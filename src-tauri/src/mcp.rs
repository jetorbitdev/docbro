//! MCP (Model Context Protocol) server: lets AI tools read and edit the open document.
//!
//! HTTP clients (Claude Code, Cursor, VS Code, ...) talk to `POST /mcp` on 127.0.0.1 with a
//! bearer token. Clients that only speak stdio (Claude Desktop, Codex, ...) launch this same
//! binary with `--mcp-stdio`, which relays every message to that endpoint. Both paths end in
//! `handle_message`, so the tools behave the same everywhere. The document lives in the
//! webview's editor, so every tool call is forwarded to the window that last had focus
//! (`calls::call_in_window`), which runs it as one undo step the user sees happen.
//!
//! The Assistant's Claude Code engine reaches the document tools over HTTP too, through a
//! listener of its own (`Lease`): a port the OS picks, a new token for each run that is never
//! saved, and calls that run in the window of the chat that asked. It works while Serve DocBro
//! is off, and the user's token gets nothing there.

use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, Read, Write},
    net::{SocketAddr, TcpStream},
    panic::{self, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread::JoinHandle,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::{calls, AppState, CmdResult, LockExt};

mod tools;
pub(crate) use tools::{tool_defs, TOOL_NAMES};

pub const DEFAULT_PORT: u16 = 7425;
const MAX_BODY: usize = 8 * 1024 * 1024;
/// How long a restart on the same port waits for the old listener to let go of it
const REBIND_PATIENCE: Duration = Duration::from_secs(1);

/// Protocol revisions we can speak: the tools-only subset is identical in all of them.
pub(crate) const PROTOCOLS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// Same as `identifier` in tauri.conf.json. The stdio bridge runs without Tauri, so it finds
/// the config at the path Tauri's `app_config_dir()` would give.
const APP_ID: &str = "com.jetorbit.docbro";

// -------------------------------------------------------------------- config

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Config {
    enabled: bool,
    port: u16,
    token: String,
}

impl Default for Config {
    fn default() -> Self {
        Config { enabled: false, port: DEFAULT_PORT, token: String::new() }
    }
}

fn config_path() -> CmdResult<PathBuf> {
    dirs::config_dir()
        .map(|d| d.join(APP_ID).join("mcp.json"))
        .ok_or_else(|| "No config directory".to_string())
}

fn new_token() -> CmdResult<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| format!("No secure random source: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

impl Config {
    fn load() -> Config {
        config_path().map(|p| Config::load_from(&p)).unwrap_or_default()
    }

    fn load_from(path: &Path) -> Config {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// The token is a credential, so the file is private to the user.
    fn save_to(&self, path: &Path) -> CmdResult<()> {
        fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        opts.open(path)
            .and_then(|mut f| f.write_all(json.as_bytes()))
            .map_err(|e| format!("Could not save MCP settings: {e}"))
    }
}

// ------------------------------------------------------------------- runtime

/// Who made a request, by the token it carries.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Caller {
    /// an AI client the user connected, with the user's token
    External,
    /// the Assistant's Claude Code run for the chat in this window
    Assistant(String),
}

/// Where tool calls go, so the server can run against a test double. `Err` is a refusal or
/// failure the AI gets to read.
pub(crate) trait Host: Send + Sync + 'static {
    fn call(&self, caller: &Caller, name: &str, args: &Value) -> Result<String, String>;
}

/// Runs an external client's tool in the window that last had focus, opening one when none is
/// left, and the Assistant's in the window of its chat, which is never opened again.
pub struct TauriHost(pub AppHandle);

impl Host for TauriHost {
    fn call(&self, caller: &Caller, name: &str, args: &Value) -> Result<String, String> {
        match caller {
            Caller::External => {
                let label = self.0.state::<AppState>().active_label();
                calls::call_in_window(&self.0, &label, name, args, calls::Origin::External)
            }
            Caller::Assistant(label) => crate::assistant::in_window(&self.0, label, name, args),
        }
    }
}

/// The tokens a listener takes.
#[derive(Clone)]
enum Keys {
    /// the user's token, for the clients they connected (Serve DocBro)
    User(Arc<Mutex<String>>),
    /// the token of each Claude Code run, and the window label of its chat
    Assistant(Arc<Mutex<HashMap<String, String>>>),
}

impl Keys {
    fn caller(&self, auth: Option<&str>) -> Option<Caller> {
        match self {
            Keys::User(token) => bearer_ok(auth, &token.lock_recovering()).then_some(Caller::External),
            Keys::Assistant(tokens) => tokens
                .lock_recovering()
                .iter()
                .find(|(token, _)| bearer_ok(auth, token))
                .map(|(_, label)| Caller::Assistant(label.clone())),
        }
    }
}

struct Running {
    server: Arc<Server>,
    thread: Option<JoinHandle<()>>,
    /// the port it listens on
    port: u16,
}

impl Running {
    /// Listens on `port`. While the port is in use, it tries again for up to `patience`.
    fn start<H: Host>(host: Arc<H>, port: u16, keys: Keys, patience: Duration) -> CmdResult<Running> {
        let deadline = Instant::now() + patience;
        let server = loop {
            let e = match Server::http(("127.0.0.1", port)) {
                Ok(server) => break server,
                Err(e) => e,
            };
            let in_use = e
                .downcast_ref::<io::Error>()
                .is_some_and(|e| e.kind() == io::ErrorKind::AddrInUse);
            if !in_use {
                return Err(format!("Could not listen on port {port}: {e}"));
            }
            if Instant::now() >= deadline {
                return Err(format!("Port {port} is already in use. Choose another port."));
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let bound = server
            .server_addr()
            .to_ip()
            .map_or(port, |a| a.port());
        let server = Arc::new(server);
        let accept = server.clone();
        let thread = std::thread::spawn(move || {
            for req in accept.incoming_requests() {
                let (host, keys) = (host.clone(), keys.clone());
                // one thread per request: a client stalling mid-body, or a tool waiting for the
                // window to answer, must not block the others
                std::thread::spawn(move || handle_http(&*host, &keys, bound, req));
            }
        });
        Ok(Running { server, thread: Some(thread), port: bound })
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The Claude Code engine's way in to the document tools: listening only while a run holds a
/// `Lease`.
#[derive(Default)]
struct AssistantDoor {
    tokens: Arc<Mutex<HashMap<String, String>>>,
    /// a token is only ever added or taken with this held, so the listener stops with the last
    running: Mutex<Option<Running>>,
}

/// One Claude Code run's access to the document tools of its chat's window. Dropping it ends
/// the access.
pub(crate) struct Lease {
    door: Arc<AssistantDoor>,
    token: String,
    port: u16,
}

impl Lease {
    #[cfg(test)]
    pub(crate) fn port(&self) -> u16 {
        self.port
    }
    pub(crate) fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }
    /// A secret: it only goes into the run's private MCP config file.
    pub(crate) fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut running = self.door.running.lock_recovering();
        let mut tokens = self.door.tokens.lock_recovering();
        tokens.remove(&self.token);
        let last = tokens.is_empty();
        drop(tokens);
        let stopped = if last { running.take() } else { None };
        drop(running);
        // stopping waits for the listener's thread: done with no lock held
        drop(stopped);
    }
}

/// Settings plus the live server; kept in `AppState`.
pub struct Runtime {
    config: Config,
    /// where `config` is saved
    file: CmdResult<PathBuf>,
    token: Arc<Mutex<String>>,
    running: Option<Running>,
    error: Option<String>,
    assistant: Arc<AssistantDoor>,
}

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    running: bool,
    port: u16,
    url: String,
    token: String,
    /// this executable; stdio clients run it with `--mcp-stdio`
    command: String,
    error: Option<String>,
}

impl Runtime {
    pub fn load() -> Runtime {
        Runtime::at(config_path())
    }

    /// The runtime whose settings live in `file`.
    fn at(file: CmdResult<PathBuf>) -> Runtime {
        let mut config = file.as_deref().map(Config::load_from).unwrap_or_default();
        if config.token.is_empty() {
            config.token = new_token().unwrap_or_default();
        }
        Runtime {
            token: Arc::new(Mutex::new(config.token.clone())),
            config,
            file,
            running: None,
            error: None,
            assistant: Arc::default(),
        }
    }

    fn save(&self) -> CmdResult<()> {
        self.config.save_to(self.file.as_deref().map_err(Clone::clone)?)
    }

    /// Turns the server on at `port`. A server already listening there is left as it is.
    fn enable<H: Host>(&mut self, host: Arc<H>, port: u16) -> CmdResult<()> {
        if self.running.as_ref().is_some_and(|r| r.port == port) {
            return Ok(());
        }
        self.start(host, port)
    }

    /// (Re)starts the server on `port`. When that fails, the status says it is on but not
    /// running, with the reason, and the next launch tries again.
    fn start<H: Host>(&mut self, host: Arc<H>, port: u16) -> CmdResult<()> {
        let started = self.try_start(host, port);
        if let Err(e) = &started {
            self.running = None;
            self.config.enabled = true;
            self.config.port = port;
            self.error = Some(e.clone());
            let _ = self.save();
        }
        started
    }

    fn try_start<H: Host>(&mut self, host: Arc<H>, port: u16) -> CmdResult<()> {
        if self.config.token.is_empty() {
            self.config.token = new_token()?;
            *self.token.lock_recovering() = self.config.token.clone();
        }
        // let go of the old listener first, or restarting on the same port would collide with
        // it. The OS frees the port a moment after, so a restart there waits for it a little.
        let old_port = self.running.take().map(|old| old.port);
        let patience = if old_port == Some(port) { REBIND_PATIENCE } else { Duration::ZERO };
        let running = Running::start(host, port, Keys::User(self.token.clone()), patience)?;
        self.config.enabled = true;
        self.config.port = running.port;
        self.save()?;
        self.running = Some(running);
        self.error = None;
        Ok(())
    }

    fn disable(&mut self) -> CmdResult<()> {
        self.running = None;
        self.error = None;
        self.config.enabled = false;
        self.save()
    }

    /// Lets a Claude Code run for the chat in window `label` use the document tools, until the
    /// lease is dropped.
    pub(crate) fn lease<H: Host>(&self, host: Arc<H>, label: &str) -> CmdResult<Lease> {
        let door = &self.assistant;
        let mut running = door.running.lock_recovering();
        if running.is_none() {
            // port 0: the OS picks a free one, so Serve DocBro's port and other apps are never in the way
            *running = Some(Running::start(host, 0, Keys::Assistant(door.tokens.clone()), Duration::ZERO)?);
        }
        let port = running.as_ref().map_or(0, |r| r.port);
        let token = new_token()?;
        door.tokens.lock_recovering().insert(token.clone(), label.to_string());
        Ok(Lease { door: door.clone(), token, port })
    }

    fn regenerate_token(&mut self) -> CmdResult<()> {
        let token = new_token()?;
        self.config.token = token.clone();
        self.save()?;
        // requests already carrying the old token are refused from now on
        *self.token.lock_recovering() = token;
        Ok(())
    }

    fn status(&self) -> Status {
        let port = self.config.port;
        Status {
            enabled: self.config.enabled,
            running: self.running.is_some(),
            port,
            url: format!("http://127.0.0.1:{port}/mcp"),
            token: self.config.token.clone(),
            command: std::env::current_exe()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            error: self.error.clone(),
        }
    }
}

/// Starts the server at launch when the user left it on.
pub fn autostart(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut rt = state.mcp.lock_recovering();
    if rt.config.enabled {
        let port = rt.config.port;
        // a failure is kept in the status for the settings panel
        let _ = rt.start(Arc::new(TauriHost(app.clone())), port);
    }
}

#[tauri::command]
pub fn mcp_status(state: State<AppState>) -> Status {
    state.mcp.lock_recovering().status()
}

#[tauri::command]
pub fn mcp_set_enabled(
    enabled: bool,
    port: Option<u16>,
    app: AppHandle,
    state: State<AppState>,
) -> CmdResult<Status> {
    let mut rt = state.mcp.lock_recovering();
    if enabled {
        let port = port.unwrap_or(rt.config.port);
        if port < 1024 {
            return Err("Choose a port between 1024 and 65535".into());
        }
        rt.enable(Arc::new(TauriHost(app)), port)?;
    } else {
        rt.disable()?;
    }
    Ok(rt.status())
}

#[tauri::command]
pub fn mcp_regenerate_token(state: State<AppState>) -> CmdResult<Status> {
    let mut rt = state.mcp.lock_recovering();
    rt.regenerate_token()?;
    Ok(rt.status())
}

// ---------------------------------------------------------------------- HTTP

fn header(req: &Request, name: &'static str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_string())
}

fn respond(req: Request, status: u16, body: String, headers: &[(&str, &str)]) {
    let mut res = Response::from_string(body)
        .with_status_code(status)
        // every body is in memory; chunked encoding would only complicate the stdio bridge
        .with_chunked_threshold(usize::MAX);
    let fixed = [("Content-Type", "application/json"), ("Cache-Control", "no-store")];
    for (k, v) in fixed.iter().chain(headers) {
        if let Ok(h) = Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            res.add_header(h);
        }
    }
    let _ = req.respond(res);
}

fn fail(req: Request, status: u16, message: &str, headers: &[(&str, &str)]) {
    respond(req, status, rpc_error(Value::Null, -32000, message).to_string(), headers);
}

/// DNS-rebinding guard: only requests addressed to this very listener are served.
fn host_ok(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else { return false };
    let host = host.to_ascii_lowercase();
    [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")]
        .contains(&host)
}

fn bearer_ok(auth: Option<&str>, token: &str) -> bool {
    let Some(auth) = auth else { return false };
    let Some(given) = auth.get(7..).filter(|_| auth[..7].eq_ignore_ascii_case("bearer ")) else {
        return false;
    };
    let (a, b) = (given.trim().as_bytes(), token.as_bytes());
    // compare in constant time so the token cannot be guessed byte by byte
    !b.is_empty() && a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn handle_http<H: Host>(host: &H, keys: &Keys, port: u16, mut req: Request) {
    if !host_ok(header(&req, "Host").as_deref(), port) {
        return fail(req, 403, "Forbidden host", &[]);
    }
    // Browsers always send Origin on cross-site requests; MCP clients never do.
    // Refusing it keeps web pages from driving the document.
    if header(&req, "Origin").is_some() {
        return fail(req, 403, "Forbidden origin", &[]);
    }
    let Some(caller) = keys.caller(header(&req, "Authorization").as_deref()) else {
        let msg = "Missing or wrong access token. Copy the connection settings from the MCP settings in DocBro.";
        return fail(req, 401, msg, &[("WWW-Authenticate", "Bearer realm=\"DocBro\"")]);
    };
    if req.url().split('?').next() != Some("/mcp") {
        return fail(req, 404, "Not found. The MCP endpoint is /mcp", &[]);
    }
    // Streamable HTTP: no server-initiated stream (GET) and no sessions (DELETE)
    if *req.method() != Method::Post {
        return fail(req, 405, "Use POST", &[("Allow", "POST")]);
    }

    let mut body = Vec::new();
    let read = req.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body);
    if read.is_err() {
        return fail(req, 400, "Could not read the request body", &[]);
    }
    if body.len() > MAX_BODY {
        return fail(req, 413, "Request too large", &[]);
    }
    let reply = match serde_json::from_slice::<Value>(&body) {
        Err(_) => Some(rpc_error(Value::Null, -32700, "Parse error")),
        Ok(Value::Array(batch)) if batch.is_empty() => {
            Some(rpc_error(Value::Null, -32600, "Invalid Request"))
        }
        Ok(Value::Array(batch)) => {
            let replies: Vec<Value> = batch.iter().filter_map(|m| handle_message(host, &caller, m)).collect();
            (!replies.is_empty()).then_some(Value::Array(replies))
        }
        Ok(msg) => handle_message(host, &caller, &msg),
    };
    match reply {
        Some(v) => respond(req, 200, v.to_string(), &[]),
        // notifications and responses are acknowledged without a body
        None => respond(req, 202, String::new(), &[]),
    }
}

// ------------------------------------------------------------------ JSON-RPC

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Answers one JSON-RPC message; `None` for notifications and client responses.
fn handle_message<H: Host>(host: &H, caller: &Caller, msg: &Value) -> Option<Value> {
    let Some(obj) = msg.as_object() else {
        return Some(rpc_error(Value::Null, -32600, "Invalid Request"));
    };
    let id = obj.get("id").cloned();
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        // an answer to a request we never sent
        if obj.contains_key("result") || obj.contains_key("error") {
            return None;
        }
        return Some(rpc_error(id.unwrap_or(Value::Null), -32600, "Invalid Request"));
    };
    // no id: a notification such as notifications/initialized
    let id = id?;
    let params = obj.get("params").unwrap_or(&Value::Null);
    let result = match method {
        "initialize" => Ok(initialize(params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_defs() })),
        "tools/call" => call_tool(host, caller, params),
        _ => Err((-32601, format!("Method not found: {method}"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => rpc_error(id, code, &message),
    })
}

fn initialize(params: &Value) -> Value {
    let wanted = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let version = PROTOCOLS.iter().find(|v| **v == wanted).unwrap_or(&PROTOCOLS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "docbro", "title": "DocBro", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "DocBro is a word processor. These tools read and edit the document the user \
            has open, live in their window (the one in front when several are open). The document is \
            a list of top-level blocks (paragraphs, headings, lists, quotes, tables, images, dividers) \
            numbered from 1; a whole list or table is one block. Call document_info first, then \
            read_document to see the blocks with their numbers. Markdown carries no typeface or size: \
            read_fonts tells what the text is set in, and format_text sets font and size. insert_content \
            and replace_blocks take Markdown and work on whole top-level blocks only. Every edit is one undo step (the user can \
            press Cmd+Z, or you can call undo)."
    })
}

fn call_tool<H: Host>(host: &H, caller: &Caller, params: &Value) -> Result<Value, (i32, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "Missing tool name".to_string()))?;
    if !TOOL_NAMES.contains(&name) {
        return Err((-32602, format!("Unknown tool: {name}")));
    }
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    // Tool failures are results, not protocol errors, so the model sees them and can retry
    Ok(match guarded(|| host.call(caller, name, &args)) {
        Ok(text) => tool_result(text, false),
        Err(text) => tool_result(text, true),
    })
}

/// Runs a tool and turns a panic inside it into an error result. A failing tool must not take
/// the whole app down, and with it the document the user has not saved.
fn guarded<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    panic::catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| {
        Err("Internal error while running this tool. Check the document with read_document, or use undo."
            .to_string())
    })
}

fn tool_result(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

// -------------------------------------------------------------- stdio bridge

const OFF_MESSAGE: &str = "DocBro's MCP server is off. Open DocBro, click the gear in the Assistant panel \
    and turn on the MCP server.";

/// Relays newline-delimited JSON-RPC from stdin to the running app and prints the answers.
/// Port and token come from the config file, so client configs hold no secrets.
pub fn stdio_bridge() -> i32 {
    let mut out = io::stdout();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match forward(&line) {
            Ok(reply) => reply,
            Err(message) => failure_reply(&line, &message),
        };
        if let Some(reply) = reply {
            if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    }
    0
}

fn forward(message: &str) -> Result<Option<String>, String> {
    let config = Config::load();
    if !config.enabled || config.token.is_empty() {
        return Err(OFF_MESSAGE.into());
    }
    let (status, body) = post(config.port, &config.token, message)?;
    match status {
        200 => Ok(Some(body)),
        202 => Ok(None),
        401 => Err("DocBro rejected the access token. Restart this AI tool so it picks up the new one.".into()),
        _ => {
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
                .unwrap_or(body);
            Err(format!("DocBro answered HTTP {status}: {detail}"))
        }
    }
}

/// An error answer for a request that could not be relayed; notifications get none.
fn failure_reply(message: &str, error: &str) -> Option<String> {
    let id = serde_json::from_str::<Value>(message).ok()?.get("id")?.clone();
    Some(rpc_error(id, -32000, error).to_string())
}

/// One plain HTTP/1.1 POST over a fresh connection; returns status and body.
fn post(port: u16, token: &str, body: &str) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|_| {
        format!("Cannot reach DocBro on port {port}. Is the app running with its MCP server turned on?")
    })?;
    let io_err = |e: io::Error| format!("Lost the connection to DocBro: {e}");
    // longer than a tool call can take: opening a window plus the window's answer
    stream.set_read_timeout(Some(Duration::from_secs(120))).map_err(io_err)?;
    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\
         Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).map_err(io_err)?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(io_err)?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("Malformed answer from DocBro")?;
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or("Malformed answer from DocBro")?;
    Ok((status, body.trim().to_string()))
}

// --------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    /// Records every call that reaches it and answers with canned text.
    struct TestHost {
        calls: Mutex<Vec<(String, Value)>>,
        callers: Mutex<Vec<Caller>>,
        reply: Result<String, String>,
    }

    impl TestHost {
        fn answering(reply: Result<String, String>) -> Arc<TestHost> {
            Arc::new(TestHost { calls: Mutex::new(Vec::new()), callers: Mutex::new(Vec::new()), reply })
        }
        fn callers(&self) -> Vec<Caller> {
            self.callers.lock().unwrap().clone()
        }
        fn new() -> Arc<TestHost> {
            TestHost::answering(Ok("done".into()))
        }
        fn seen(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Host for TestHost {
        fn call(&self, caller: &Caller, name: &str, args: &Value) -> Result<String, String> {
            self.callers.lock().unwrap().push(caller.clone());
            self.calls.lock().unwrap().push((name.to_string(), args.clone()));
            self.reply.clone()
        }
    }

    fn tools_call(id: i64, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": params })
    }

    /// Calls a tool through the JSON-RPC layer; returns (is_error, text).
    fn call(host: &TestHost, name: &str, args: Value) -> (bool, String) {
        let reply = handle_message(host, &Caller::External, &tools_call(1, json!({ "name": name, "arguments": args }))).unwrap();
        let result = &reply["result"];
        (result["isError"].as_bool().unwrap(), result["content"][0]["text"].as_str().unwrap().to_string())
    }

    #[test]
    fn advertises_every_tool() {
        let defs = tool_defs();
        assert_eq!(defs.len(), TOOL_NAMES.len());
        let names: Vec<&str> = defs.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, TOOL_NAMES);
        for t in &defs {
            let schema = &t["inputSchema"];
            assert_eq!(schema["type"], "object", "{}", t["name"]);
            // the webview refuses unknown arguments, so the schema says so up front
            assert_eq!(schema["additionalProperties"], false, "{}", t["name"]);
            for key in schema["required"].as_array().unwrap() {
                assert!(schema["properties"].get(key.as_str().unwrap()).is_some(), "{} requires {key}", t["name"]);
            }
            assert!(!t["description"].as_str().unwrap().is_empty());
        }
        let hinted = |hint: &str| -> Vec<&str> {
            defs.iter()
                .filter(|t| t["annotations"][hint] == true)
                .map(|t| t["name"].as_str().unwrap())
                .collect()
        };
        assert_eq!(hinted("readOnlyHint"), ["document_info", "read_document", "read_fonts", "list_comments"]);
        assert_eq!(hinted("destructiveHint"), ["replace_blocks", "delete_blocks", "open_document", "save_document"]);
    }

    #[test]
    fn handshake_negotiates_protocol_version() {
        let host = TestHost::new();
        let init = |v: &str| {
            handle_message(&*host, &Caller::External, &json!({ "jsonrpc": "2.0", "id": 7, "method": "initialize", "params": { "protocolVersion": v } }))
                .unwrap()
        };
        let reply = init("2025-03-26");
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(reply["result"]["serverInfo"]["name"], "docbro");
        assert_eq!(reply["result"]["serverInfo"]["title"], "DocBro");
        assert!(reply["result"]["capabilities"]["tools"].is_object());
        // an unknown revision gets our newest instead of an error
        assert_eq!(init("1999-01-01")["result"]["protocolVersion"], PROTOCOLS[0]);

        // notifications and stray responses get no answer; unknown methods do
        assert!(handle_message(&*host, &Caller::External, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        assert!(handle_message(&*host, &Caller::External, &json!({ "jsonrpc": "2.0", "id": 1, "result": {} })).is_none());
        let missing = handle_message(&*host, &Caller::External, &json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/list" })).unwrap();
        assert_eq!(missing["error"]["code"], -32601);
        let ping = handle_message(&*host, &Caller::External, &json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" })).unwrap();
        assert_eq!(ping["result"], json!({}));
        let list = handle_message(&*host, &Caller::External, &json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" })).unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), TOOL_NAMES.len());
        assert!(host.seen().is_empty());
    }

    #[test]
    fn tool_results_and_errors_reach_the_client_as_results() {
        let host = TestHost::new();
        assert_eq!(call(&host, "read_document", json!({ "from": 2 })), (false, "done".to_string()));
        // no arguments at all reach the webview as an empty object
        handle_message(&*host, &Caller::External, &tools_call(2, json!({ "name": "undo" }))).unwrap();
        assert_eq!(
            host.seen(),
            vec![("read_document".to_string(), json!({ "from": 2 })), ("undo".to_string(), json!({}))]
        );

        // a refusal from the webview is a tool result the model can read, not a protocol error
        let refusing = TestHost::answering(Err("x".into()));
        let reply = handle_message(&*refusing, &Caller::External, &tools_call(3, json!({ "name": "delete_blocks", "arguments": { "from": 9 } })))
            .unwrap();
        assert!(reply.get("error").is_none(), "{reply}");
        assert_eq!(reply["result"]["isError"], true);
        assert_eq!(reply["result"]["content"][0]["text"], "x");
    }

    #[test]
    fn unknown_tools_never_reach_the_host() {
        let host = TestHost::new();
        let unknown = handle_message(&*host, &Caller::External, &tools_call(4, json!({ "name": "nope" }))).unwrap();
        assert_eq!(unknown["error"]["code"], -32602);
        assert!(unknown["error"]["message"].as_str().unwrap().contains("nope"));
        // a spreadsheet tool from the sibling app is just as unknown here
        let sheet = handle_message(&*host, &Caller::External, &tools_call(5, json!({ "name": "read_range" }))).unwrap();
        assert_eq!(sheet["error"]["code"], -32602);
        let nameless = handle_message(&*host, &Caller::External, &tools_call(6, json!({ "arguments": {} }))).unwrap();
        assert_eq!(nameless["error"]["code"], -32602);
        assert!(host.seen().is_empty());
    }

    #[test]
    fn a_panicking_tool_becomes_an_error_and_the_next_call_still_works() {
        let failed: Result<(), String> = guarded(|| panic!("boom"));
        assert!(failed.unwrap_err().contains("Internal error"));
        assert_eq!(guarded(|| Ok::<_, String>(5)), Ok(5));

        // a lock that a panicking thread held is still usable afterwards
        let lock = Arc::new(Mutex::new(1));
        let held = lock.clone();
        let _ = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(lock.lock().is_err());
        assert_eq!(*lock.lock_recovering(), 1);
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("docbro-mcp-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    // -- HTTP -------------------------------------------------------------

    const TOKEN: &str = "t0ken";

    fn start(host: &Arc<TestHost>) -> (Running, u16) {
        let running = Running::start(host.clone(), 0, Keys::User(Arc::new(Mutex::new(TOKEN.into()))), Duration::ZERO).unwrap();
        let port = running.port;
        (running, port)
    }

    /// Sends a hand-written request and returns (status, body).
    fn raw(port: u16, request: &[u8]) -> (u16, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(request).unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).unwrap();
        let text = String::from_utf8_lossy(&buf).to_string();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        (head.split_whitespace().nth(1).unwrap().parse().unwrap(), body.to_string())
    }

    fn request(method: &str, path: &str, port: u16, extra: &str, body: &str) -> Vec<u8> {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn http_endpoint_is_locked_down() {
        let host = TestHost::new();
        let (_server, port) = start(&host);
        let auth = format!("Authorization: Bearer {TOKEN}\r\n");
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let tool = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"undo"}}"#;

        let (status, body) = raw(port, &request("POST", "/mcp", port, &auth, ping));
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));

        // credentials: none, wrong, and a prefix of the real one
        for extra in ["".to_string(), "Authorization: Bearer nope\r\n".to_string(), "Authorization: Bearer t0k\r\n".to_string(), format!("Authorization: Basic {TOKEN}\r\n")] {
            assert_eq!(raw(port, &request("POST", "/mcp", port, &extra, tool)).0, 401, "{extra:?}");
        }
        // lowercase scheme is fine (RFC 7235)
        assert_eq!(raw(port, &request("POST", "/mcp", port, &format!("Authorization: bearer {TOKEN}\r\n"), ping)).0, 200);
        // a browser page (Origin) or a rebinding host name never gets in, even with the token
        assert_eq!(raw(port, &request("POST", "/mcp", port, &format!("{auth}Origin: https://evil.example\r\n"), tool)).0, 403);
        let rebound = format!("POST /mcp HTTP/1.1\r\nHost: evil.example:{port}\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n{tool}", tool.len());
        assert_eq!(raw(port, rebound.as_bytes()).0, 403);

        assert_eq!(raw(port, &request("GET", "/mcp", port, &auth, "")).0, 405);
        assert_eq!(raw(port, &request("DELETE", "/mcp", port, &auth, "")).0, 405);
        assert_eq!(raw(port, &request("POST", "/elsewhere", port, &auth, tool)).0, 404);
        // a body over the cap is refused, not parsed
        let huge = format!("[{}]", " ".repeat(MAX_BODY));
        assert_eq!(raw(port, &request("POST", "/mcp", port, &auth, &huge)).0, 413);

        // notifications are acknowledged with an empty 202
        let note = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert_eq!(raw(port, &request("POST", "/mcp", port, &auth, note)), (202, String::new()));
        // garbage in, JSON-RPC error out
        let (status, body) = raw(port, &request("POST", "/mcp", port, &auth, "{nope"));
        assert_eq!(status, 200);
        assert!(body.contains("-32700"), "{body}");
        let (status, body) = raw(port, &request("POST", "/mcp", port, &auth, "[]"));
        assert_eq!(status, 200);
        assert!(body.contains("-32600"), "{body}");
        // a batch is answered as a batch, minus the notifications
        let batch = format!("[{ping},{note},{ping}]");
        let (_, body) = raw(port, &request("POST", "/mcp", port, &auth, &batch));
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap().as_array().unwrap().len(), 2);
        // nothing of the above reached the document
        assert!(host.seen().is_empty());

        let (status, body) = raw(port, &request("POST", "/mcp", port, &auth, tool));
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"]["content"][0]["text"], "done");
        assert_eq!(host.seen(), vec![("undo".to_string(), json!({}))]);
    }

    #[test]
    fn stdio_bridge_round_trip_and_big_answers() {
        // ~120 KB answer: would be chunked by default, the bridge must still read it whole
        let big = "x".repeat(120_000);
        let host = TestHost::answering(Ok(big.clone()));
        let (server, port) = start(&host);
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "read_document", "arguments": {} } });
        let (status, body) = post(port, TOKEN, &msg.to_string()).unwrap();
        assert_eq!(status, 200);
        let reply: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(reply["result"]["content"][0]["text"], big.as_str());

        assert_eq!(post(port, "wrong", "{}").unwrap().0, 401);
        let (status, none) = post(port, TOKEN, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).unwrap();
        assert_eq!((status, none.as_str()), (202, ""));

        // requests that cannot be relayed still get an answer; notifications do not
        let answer = failure_reply(r#"{"jsonrpc":"2.0","id":"abc","method":"ping"}"#, OFF_MESSAGE).unwrap();
        let answer: Value = serde_json::from_str(&answer).unwrap();
        assert_eq!(answer["id"], "abc");
        assert!(answer["error"]["message"].as_str().unwrap().contains("DocBro"));
        assert!(failure_reply(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, "x").is_none());

        // stopping really closes the port (tiny_http releases the socket a moment after drop)
        drop(server);
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let closed = (0..40).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_err()
        });
        assert!(closed, "port {port} still accepts connections after stop");
    }

    /// Sends `head` (and `body`), half-closes when asked, and returns the status code of the
    /// answer without waiting for the connection to close.
    fn status_line(port: u16, head: &str, body: &[u8], close_after: bool) -> u16 {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(head.as_bytes()).unwrap();
        s.write_all(body).unwrap();
        if close_after {
            s.shutdown(std::net::Shutdown::Write).unwrap();
        }
        let mut got = Vec::new();
        let mut buf = [0u8; 512];
        while !got.windows(2).any(|w| w == b"\r\n") {
            let n = s.read(&mut buf).unwrap();
            assert!(n > 0, "connection closed before an answer");
            got.extend_from_slice(&buf[..n]);
        }
        String::from_utf8_lossy(&got).split_whitespace().nth(1).unwrap().parse().unwrap()
    }

    #[test]
    fn a_lying_content_length_cannot_take_the_app_down() {
        let host = TestHost::new();
        let (_server, port) = start(&host);
        // claims an absurd body, sends one byte and keeps the connection open: before the fix,
        // dropping the refused request allocated the claimed size and aborted the process
        let huge = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 4611686018427387904\r\n\r\n");
        assert_eq!(status_line(port, &huge, b"x", false), 401);
        // claims more than it sends, then hangs up
        let short = "POST /mcp HTTP/1.1\r\nHost: evil.example\r\nContent-Length: 5000\r\n\r\n";
        assert_eq!(status_line(port, short, &[b'x'; 10], true), 403);
        // a refused body over the drain limit, sent in full
        let big = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 200000\r\n\r\n");
        assert_eq!(status_line(port, &big, &[b' '; 200_000], true), 401);

        std::thread::sleep(Duration::from_millis(200));
        let auth = format!("Authorization: Bearer {TOKEN}\r\n");
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        assert_eq!(raw(port, &request("POST", "/mcp", port, &auth, ping)).0, 200);
    }

    #[test]
    fn an_unread_body_cannot_smuggle_a_second_request() {
        let host = TestHost::new();
        let (_server, port) = start(&host);
        // a web page's request (Origin) is refused without its body being read; the body, past the
        // drain limit, holds a request of its own that would skip the Host and Origin checks
        let tool = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"undo"}}"#;
        let forged = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: {}\r\n\r\n{tool}",
            tool.len()
        );
        let mut body = forged.clone().into_bytes();
        body.resize(70_000 - 2, b' ');
        body.extend_from_slice(b"\r\n"); // so that, read as requests, the padding ends in a 400 and a close
        let head = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://evil.example\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(head.as_bytes()).unwrap();
        s.write_all(&body).unwrap();
        // the server closes the connection: read_to_end returns instead of timing out
        let mut got = Vec::new();
        s.read_to_end(&mut got).unwrap();
        let text = String::from_utf8_lossy(&got);
        assert_eq!(text.matches("HTTP/1.1 ").count(), 1, "{text}");
        assert!(text.starts_with("HTTP/1.1 403"), "{text}");
        assert!(host.seen().is_empty());

        // a chunked body is never drained, whatever its size: the request it holds is not read either
        let head = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://evil.example\r\nTransfer-Encoding: chunked\r\n\r\n");
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(head.as_bytes()).unwrap();
        s.write_all(format!("{forged}\r\n").as_bytes()).unwrap();
        let mut got = Vec::new();
        s.read_to_end(&mut got).unwrap();
        let text = String::from_utf8_lossy(&got);
        assert_eq!(text.matches("HTTP/1.1 ").count(), 1, "{text}");
        assert!(host.seen().is_empty());
    }

    #[test]
    fn a_refused_body_past_the_drain_limit_is_read_to_its_end_before_the_connection_closes() {
        let host = TestHost::new();
        let (_server, port) = start(&host);
        // the 401 comes before the body is sent; the connection then takes the body and closes
        // as usual. Closed with the body unread, it would be reset, and the client's write or
        // read fail.
        let head = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 600000\r\n\r\n");
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(head.as_bytes()).unwrap();
        let mut got = vec![0u8; 12];
        s.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"HTTP/1.1 401");
        std::thread::sleep(Duration::from_millis(100));
        s.write_all(&[b' '; 600_000]).expect("the body could not be sent");
        let mut rest = Vec::new();
        s.read_to_end(&mut rest).expect("the connection was reset");
        assert_eq!(String::from_utf8_lossy(&rest).matches("HTTP/1.1 ").count(), 0);
    }

    #[test]
    fn restart_on_the_same_port_succeeds_every_time() {
        let host = TestHost::new();
        let mut rt = Runtime::at(Ok(tmp("restart/mcp.json")));
        rt.start(host.clone(), 0).unwrap();
        let port = rt.status().port;
        // the old listener is released a moment after it is dropped
        for i in 0..50 {
            rt.start(host.clone(), port).unwrap_or_else(|e| panic!("restart {i}: {e}"));
            assert!(rt.status().running && rt.status().error.is_none());
        }
        // applying the port it already listens on leaves the server alone
        let server = Arc::as_ptr(&rt.running.as_ref().unwrap().server);
        rt.enable(host.clone(), port).unwrap();
        assert_eq!(Arc::as_ptr(&rt.running.as_ref().unwrap().server), server);

        let auth = format!("Authorization: Bearer {}\r\n", rt.config.token);
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        assert_eq!(raw(port, &request("POST", "/mcp", port, &auth, ping)).0, 200);
    }

    #[test]
    fn a_failed_start_records_the_error_in_the_status() {
        let host = TestHost::new();
        let (_taken, port) = start(&host);
        let path = tmp("failed/mcp.json");
        let _ = fs::remove_file(&path);
        let mut rt = Runtime::at(Ok(path));
        let err = rt.enable(host.clone(), port).unwrap_err();
        assert!(err.contains("already in use"), "{err}");
        // the user asked for it on: the status says so, and why it is not running
        let status = rt.status();
        assert!(status.enabled && !status.running);
        assert_eq!(status.port, port);
        assert_eq!(status.error.as_deref(), Some(err.as_str()));

        // a start that works clears the error
        rt.enable(host.clone(), 0).unwrap();
        assert!(rt.status().running && rt.status().error.is_none());
    }

    #[test]
    fn rejects_a_port_that_is_taken() {
        let host = TestHost::new();
        let (_server, port) = start(&host);
        let err = Running::start(host.clone(), port, Keys::User(Arc::new(Mutex::new(TOKEN.into()))), Duration::ZERO)
            .err()
            .unwrap();
        assert!(err.contains("already in use"), "{err}");
    }

    #[test]
    fn config_file_is_private_and_round_trips() {
        let path = tmp("cfg-dir/nested/mcp.json");
        let _ = fs::remove_file(&path);
        let cfg = Config { enabled: true, port: 7431, token: "secret".into() };
        cfg.save_to(&path).unwrap();
        let back: Config = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!((back.enabled, back.port, back.token.as_str()), (true, 7431, "secret"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // a config written by an older version (missing keys) still loads with defaults
        let old: Config = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!((old.port, old.token.as_str()), (DEFAULT_PORT, ""));
        assert_eq!(DEFAULT_PORT, 7425);
        assert!(config_path().unwrap().ends_with("com.jetorbit.docbro/mcp.json"));
    }


    /// Whether nothing listens on `port` any more (tiny_http lets go a moment after a stop).
    fn closes(port: u16) -> bool {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        (0..40).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_err()
        })
    }

    const UNDO: &str = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"undo"}}"#;

    fn bearer(token: &str) -> String {
        format!("Authorization: Bearer {token}\r\n")
    }

    #[test]
    fn assistant_token_calls_are_marked_assistant_and_work_while_serve_is_off() {
        let host = TestHost::new();
        let path = tmp("lease/mcp.json");
        let _ = fs::remove_file(&path);
        let rt = Runtime::at(Ok(path.clone()));
        assert!(!rt.status().enabled && !rt.status().running);
        let lease = rt.lease(host.clone(), "doc-1").unwrap();
        let other = rt.lease(host.clone(), "doc-2").unwrap();
        // one listener for every run, a token of its own for each, never the user's
        let port = lease.port();
        assert_eq!(other.port(), port);
        assert_ne!(lease.token(), other.token());
        assert_eq!(lease.token().len(), 48);
        assert_ne!(lease.token(), rt.config.token);
        assert_eq!(lease.url(), format!("http://127.0.0.1:{port}/mcp"));

        let (status, body) = raw(port, &request("POST", "/mcp", port, &bearer(lease.token()), UNDO));
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"]["content"][0]["text"], "done");
        assert_eq!(raw(port, &request("POST", "/mcp", port, &bearer(other.token()), UNDO)).0, 200);
        // each call runs in the window of the chat that holds the token, as the assistant's
        assert_eq!(host.callers(), [Caller::Assistant("doc-1".into()), Caller::Assistant("doc-2".into())]);

        // every guard stays: no token, a browser page, a rebinding host name
        assert_eq!(raw(port, &request("POST", "/mcp", port, "", UNDO)).0, 401);
        let page = format!("{}Origin: https://evil.example\r\n", bearer(lease.token()));
        assert_eq!(raw(port, &request("POST", "/mcp", port, &page, UNDO)).0, 403);
        let rebound = format!(
            "POST /mcp HTTP/1.1\r\nHost: evil.example:{port}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{UNDO}",
            bearer(lease.token()),
            UNDO.len()
        );
        assert_eq!(raw(port, rebound.as_bytes()).0, 403);
        assert_eq!(host.callers().len(), 2);
        // Serve DocBro is still off, and the token was never saved
        assert!(!rt.status().enabled && !rt.status().running);
        assert!(!fs::read_to_string(&path).unwrap_or_default().contains(lease.token()));

        // a run that is over takes its token with it; the last one closes the listener
        let gone = lease.token().to_string();
        drop(lease);
        assert_eq!(raw(port, &request("POST", "/mcp", port, &bearer(&gone), UNDO)).0, 401);
        assert_eq!(raw(port, &request("POST", "/mcp", port, &bearer(other.token()), UNDO)).0, 200);
        drop(other);
        assert!(closes(port), "port {port} still accepts connections");
        // and the next run opens it again
        let again = rt.lease(host.clone(), "doc-1").unwrap();
        let port = again.port();
        assert_eq!(raw(port, &request("POST", "/mcp", port, &bearer(again.token()), UNDO)).0, 200);
    }

    #[test]
    fn user_token_is_refused_while_serve_is_off() {
        let host = TestHost::new();
        let mut rt = Runtime::at(Ok(tmp("user-token/mcp.json")));
        let lease = rt.lease(host.clone(), "main").unwrap();
        let port = lease.port();
        let user = bearer(&rt.config.token.clone());
        assert_eq!(raw(port, &request("POST", "/mcp", port, &user, UNDO)).0, 401);

        // with Serve DocBro on, each listener still takes only its own token
        rt.enable(host.clone(), 0).unwrap();
        let served = rt.status().port;
        assert_ne!(served, port);
        assert_eq!(raw(served, &request("POST", "/mcp", served, &user, UNDO)).0, 200);
        assert_eq!(raw(port, &request("POST", "/mcp", port, &user, UNDO)).0, 401);
        assert_eq!(raw(served, &request("POST", "/mcp", served, &bearer(lease.token()), UNDO)).0, 401);
        assert_eq!(host.callers(), [Caller::External]);

        // off again: the user's token gets nowhere, the chat's still works
        rt.disable().unwrap();
        assert!(closes(served), "port {served} still accepts connections");
        assert_eq!(raw(port, &request("POST", "/mcp", port, &user, UNDO)).0, 401);
        assert_eq!(raw(port, &request("POST", "/mcp", port, &bearer(lease.token()), UNDO)).0, 200);
        assert_eq!(host.callers(), [Caller::External, Caller::Assistant("main".into())]);
    }

    #[test]
    fn tokens_are_long_and_unique() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 48);
        assert_ne!(a, b);
        assert!(bearer_ok(Some(&format!("Bearer {a}")), &a));
        assert!(!bearer_ok(Some("Bearer "), ""), "an empty token never matches");
        assert!(!bearer_ok(Some("Bear"), &a), "a short header never matches");
    }
}
