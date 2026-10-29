//! MCP (Model Context Protocol) server: lets AI tools read and edit the open document.
//!
//! HTTP clients (Claude Code, Cursor, VS Code, ...) talk to `POST /mcp` on 127.0.0.1 with a
//! bearer token. Clients that only speak stdio (Claude Desktop, Codex, ...) launch this same
//! binary with `--mcp-stdio`, which relays every message to that endpoint. Both paths end in
//! `handle_message`, so the tools behave the same everywhere. The document lives in the
//! webview's editor, so every tool call is forwarded to the window that last had focus
//! (`calls::call_in_window`), which runs it as one undo step the user sees happen.

use std::{
    fs,
    io::{self, BufRead, Read, Write},
    net::{SocketAddr, TcpStream},
    panic::{self, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread::JoinHandle,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::{calls, AppState, CmdResult, LockExt};

pub const DEFAULT_PORT: u16 = 7425;
const MAX_BODY: usize = 8 * 1024 * 1024;

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
        config_path()
            .ok()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self) -> CmdResult<()> {
        self.save_to(&config_path()?)
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

/// Where tool calls go, so the server can run against a test double. `Err` is a refusal or
/// failure the AI gets to read.
pub(crate) trait Host: Send + Sync + 'static {
    fn call(&self, name: &str, args: &Value) -> Result<String, String>;
}

/// Runs every tool in the window that last had focus, opening one when none is left.
pub struct TauriHost(pub AppHandle);

impl Host for TauriHost {
    fn call(&self, name: &str, args: &Value) -> Result<String, String> {
        let label = self.0.state::<AppState>().active_label();
        calls::call_in_window(&self.0, &label, name, args)
    }
}

struct Running {
    server: Arc<Server>,
    thread: Option<JoinHandle<()>>,
}

impl Running {
    fn start<H: Host>(host: Arc<H>, port: u16, token: Arc<Mutex<String>>) -> CmdResult<(Running, u16)> {
        let server = Server::http(("127.0.0.1", port)).map_err(|e| {
            let in_use = e
                .downcast_ref::<io::Error>()
                .is_some_and(|e| e.kind() == io::ErrorKind::AddrInUse);
            if in_use {
                format!("Port {port} is already in use. Choose another port.")
            } else {
                format!("Could not listen on port {port}: {e}")
            }
        })?;
        let bound = server
            .server_addr()
            .to_ip()
            .map_or(port, |a| a.port());
        let server = Arc::new(server);
        let accept = server.clone();
        let thread = std::thread::spawn(move || {
            for req in accept.incoming_requests() {
                let (host, token) = (host.clone(), token.clone());
                // one thread per request: a client stalling mid-body, or a tool waiting for the
                // window to answer, must not block the others
                std::thread::spawn(move || handle_http(&*host, &token, bound, req));
            }
        });
        Ok((Running { server, thread: Some(thread) }, bound))
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

/// Settings plus the live server; kept in `AppState`.
pub struct Runtime {
    config: Config,
    token: Arc<Mutex<String>>,
    running: Option<Running>,
    error: Option<String>,
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
        let mut config = Config::load();
        if config.token.is_empty() {
            config.token = new_token().unwrap_or_default();
        }
        Runtime {
            token: Arc::new(Mutex::new(config.token.clone())),
            config,
            running: None,
            error: None,
        }
    }

    fn start<H: Host>(&mut self, host: Arc<H>, port: u16) -> CmdResult<()> {
        if self.config.token.is_empty() {
            self.config.token = new_token()?;
            *self.token.lock_recovering() = self.config.token.clone();
        }
        // let go of the old listener first, or restarting on the same port would collide with it
        self.running = None;
        let (running, bound) = Running::start(host, port, self.token.clone())?;
        let previous = self.config.clone();
        self.config.enabled = true;
        self.config.port = bound;
        if let Err(e) = self.config.save() {
            self.config = previous;
            return Err(e);
        }
        self.running = Some(running);
        self.error = None;
        Ok(())
    }

    fn disable(&mut self) -> CmdResult<()> {
        self.running = None;
        self.error = None;
        self.config.enabled = false;
        self.config.save()
    }

    fn regenerate_token(&mut self) -> CmdResult<()> {
        let token = new_token()?;
        self.config.token = token.clone();
        self.config.save()?;
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
        if let Err(e) = rt.start(Arc::new(TauriHost(app.clone())), port) {
            rt.error = Some(e);
        }
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
        rt.start(Arc::new(TauriHost(app)), port)?;
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

fn handle_http<H: Host>(host: &H, token: &Mutex<String>, port: u16, mut req: Request) {
    if !host_ok(header(&req, "Host").as_deref(), port) {
        return fail(req, 403, "Forbidden host", &[]);
    }
    // Browsers always send Origin on cross-site requests; MCP clients never do.
    // Refusing it keeps web pages from driving the document.
    if header(&req, "Origin").is_some() {
        return fail(req, 403, "Forbidden origin", &[]);
    }
    let token = token.lock_recovering().clone();
    if !bearer_ok(header(&req, "Authorization").as_deref(), &token) {
        let msg = "Missing or wrong access token. Copy the connection settings from the MCP settings in DocBro.";
        return fail(req, 401, msg, &[("WWW-Authenticate", "Bearer realm=\"DocBro\"")]);
    }
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
            let replies: Vec<Value> = batch.iter().filter_map(|m| handle_message(host, m)).collect();
            (!replies.is_empty()).then_some(Value::Array(replies))
        }
        Ok(msg) => handle_message(host, &msg),
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
fn handle_message<H: Host>(host: &H, msg: &Value) -> Option<Value> {
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
        "tools/call" => call_tool(host, params),
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
            read_document to see the blocks with their numbers. insert_content and replace_blocks take \
            Markdown and work on whole top-level blocks only. Every edit is one undo step (the user can \
            press Cmd+Z, or you can call undo)."
    })
}

fn call_tool<H: Host>(host: &H, params: &Value) -> Result<Value, (i32, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "Missing tool name".to_string()))?;
    if !TOOL_NAMES.contains(&name) {
        return Err((-32602, format!("Unknown tool: {name}")));
    }
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    // Tool failures are results, not protocol errors, so the model sees them and can retry
    Ok(match guarded(|| host.call(name, &args)) {
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

// --------------------------------------------------------------------- tools

/// The tools the webview runs (`TOOL_NAMES` in src/mcp/tools.ts, same order; names.test.ts
/// checks it). Anything else is refused here, before it reaches the window.
pub(crate) const TOOL_NAMES: [&str; 11] = [
    "document_info",
    "read_document",
    "insert_content",
    "replace_blocks",
    "delete_blocks",
    "find_replace",
    "format_text",
    "undo",
    "redo",
    "open_document",
    "save_document",
];

enum Hint {
    Read,
    /// changes the document but loses nothing that undo cannot bring back
    Safe,
    Destructive,
}

fn tool(name: &str, title: &str, description: &str, props: Value, required: &[&str], hint: Hint) -> Value {
    let (read_only, destructive) = match hint {
        Hint::Read => (true, false),
        Hint::Safe => (false, false),
        Hint::Destructive => (false, true),
    };
    json!({
        "name": name,
        "title": title,
        "description": description,
        // the webview refuses arguments it does not know, so a misspelt one is never ignored
        "inputSchema": { "type": "object", "properties": props, "required": required, "additionalProperties": false },
        "annotations": {
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "openWorldHint": false,
        },
    })
}

/// The tool list sent to MCP clients (and, from Task 16, to the assistant's model).
pub(crate) fn tool_defs() -> Vec<Value> {
    let block = |what: &str| json!({ "type": "integer", "minimum": 1, "description": what });
    let flag = |what: &str| json!({ "type": "boolean", "description": what });
    let color = |what: &str| {
        json!({
            "type": ["string", "null"],
            "pattern": "^#[0-9a-fA-F]{6}$",
            "description": format!("{what} as \"#rrggbb\", or null to remove it."),
        })
    };
    let from = block("First block, counting from 1.");
    let to = block("Last block (inclusive). Defaults to from.");
    let markdown = json!({ "type": "string", "description": "Markdown: headings, paragraphs, lists, quotes, tables, links, bold, italic." });
    vec![
        tool(
            "document_info",
            "Document info",
            "Name, path, format (docx or md), unsaved-changes flag, block, word and character counts and \
             outline (headings with their block numbers) of the document open in DocBro, as JSON. `dropped` \
             lists parts of the file DocBro cannot keep. Call this first.",
            json!({}),
            &[],
            Hint::Read,
        ),
        tool(
            "read_document",
            "Read document",
            "Reads blocks from..to as Markdown, each starting with [n], its block number. Blocks are the \
             document's top-level paragraphs, headings, lists, quotes, tables, images and dividers, \
             numbered from 1; a whole list or table is one block. A long document comes in pages: the end \
             of the text says where to go on.",
            json!({
                "from": block("First block to read, counting from 1. Defaults to 1."),
                "to": block("Last block to read (inclusive). Defaults to the last block."),
            }),
            &[],
            Hint::Read,
        ),
        tool(
            "insert_content",
            "Insert content",
            "Inserts Markdown as new top-level blocks before or after a block (give one of them), or at \
             the end when neither is given. It works on top-level blocks only: it cannot go inside a list \
             or a table cell, so replace the whole list or table instead. One undo step.",
            json!({
                "markdown": markdown,
                "before": block("Insert before this block."),
                "after": block("Insert after this block."),
            }),
            &["markdown"],
            Hint::Safe,
        ),
        tool(
            "replace_blocks",
            "Replace blocks",
            "Replaces top-level blocks from..to with Markdown. A whole list or table is one block, so this \
             is how to change inside one. One undo step.",
            json!({ "from": from, "to": to, "markdown": markdown }),
            &["from", "markdown"],
            Hint::Destructive,
        ),
        tool(
            "delete_blocks",
            "Delete blocks",
            "Deletes top-level blocks from..to. One undo step.",
            json!({ "from": from, "to": to }),
            &["from"],
            Hint::Destructive,
        ),
        tool(
            "find_replace",
            "Find and replace",
            "Replaces every occurrence of the literal text `find` with `replace`, optionally only in blocks \
             from..to. Case sensitive unless case_sensitive is false. A match never crosses from one \
             paragraph into the next. Reports how many were replaced (0 is not an error). One undo step.",
            json!({
                "find": { "type": "string", "description": "Text to look for (not a pattern)." },
                "replace": { "type": "string", "description": "Text to put in its place." },
                "case_sensitive": flag("Match upper and lower case exactly. Defaults to true."),
                "from": block("First block to search. Defaults to 1."),
                "to": block("Last block to search (inclusive). Defaults to the last block."),
            }),
            &["find", "replace"],
            Hint::Safe,
        ),
        tool(
            "format_text",
            "Format text",
            "Formats top-level blocks from..to. Pass only what should change, at least one option. With \
             `text`, bold, italic, underline, strike, color, highlight and link go on the occurrences of \
             that text only; style, align and list always apply to whole paragraphs and headings. One \
             undo step.",
            json!({
                "from": from,
                "to": to,
                "text": { "type": "string", "description": "Only format the occurrences of this text (case sensitive)." },
                "bold": flag("Bold on or off."),
                "italic": flag("Italic on or off."),
                "underline": flag("Underline on or off."),
                "strike": flag("Strikethrough on or off."),
                "color": color("Text color"),
                "highlight": color("Highlight color"),
                "link": { "type": ["string", "null"], "description": "An http, https or mailto URL, or null to remove the link." },
                "style": { "type": "string", "enum": ["body", "heading1", "heading2", "heading3", "quote"], "description": "Paragraph style." },
                "align": { "type": ["string", "null"], "enum": ["left", "center", "right", "justify", null], "description": "Alignment, or null for the default." },
                "list": { "type": "string", "enum": ["bullet", "numbered", "none"], "description": "Make the blocks a list, or none to take a list apart." },
            }),
            &["from"],
            Hint::Safe,
        ),
        tool("undo", "Undo", "Undoes the last change, the user's or an AI's. Each edit tool call is one step.", json!({}), &[], Hint::Safe),
        tool("redo", "Redo", "Redoes the last undone change.", json!({}), &[], Hint::Safe),
        tool(
            "open_document",
            "Open file",
            "Opens a .docx or .md file in DocBro, replacing the current document. Refused while the \
             document has unsaved changes unless discard is true, so ask the user before setting that.",
            json!({
                "path": { "type": "string", "description": "Absolute path of a .docx or .md file." },
                "discard": flag("Throw away unsaved changes in the current document."),
            }),
            &["path"],
            Hint::Destructive,
        ),
        tool(
            "save_document",
            "Save file",
            "Saves the document. Without `path` it saves to the file it was opened from. With `path` it \
             saves there and refuses to replace another file unless overwrite is true. Refuses when the \
             file would lose parts DocBro cannot keep, unless accept_loss is true.",
            json!({
                "path": { "type": "string", "description": "Absolute target path ending in .docx or .md." },
                "overwrite": flag("Allow replacing an existing file at `path`."),
                "accept_loss": flag("Save even though the file will lose parts DocBro cannot keep."),
            }),
            &[],
            Hint::Destructive,
        ),
    ]
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
        reply: Result<String, String>,
    }

    impl TestHost {
        fn answering(reply: Result<String, String>) -> Arc<TestHost> {
            Arc::new(TestHost { calls: Mutex::new(Vec::new()), reply })
        }
        fn new() -> Arc<TestHost> {
            TestHost::answering(Ok("done".into()))
        }
        fn seen(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Host for TestHost {
        fn call(&self, name: &str, args: &Value) -> Result<String, String> {
            self.calls.lock().unwrap().push((name.to_string(), args.clone()));
            self.reply.clone()
        }
    }

    fn tools_call(id: i64, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": params })
    }

    /// Calls a tool through the JSON-RPC layer; returns (is_error, text).
    fn call(host: &TestHost, name: &str, args: Value) -> (bool, String) {
        let reply = handle_message(host, &tools_call(1, json!({ "name": name, "arguments": args }))).unwrap();
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
        assert_eq!(hinted("readOnlyHint"), ["document_info", "read_document"]);
        assert_eq!(hinted("destructiveHint"), ["replace_blocks", "delete_blocks", "open_document", "save_document"]);
    }

    #[test]
    fn handshake_negotiates_protocol_version() {
        let host = TestHost::new();
        let init = |v: &str| {
            handle_message(&*host, &json!({ "jsonrpc": "2.0", "id": 7, "method": "initialize", "params": { "protocolVersion": v } }))
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
        assert!(handle_message(&*host, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        assert!(handle_message(&*host, &json!({ "jsonrpc": "2.0", "id": 1, "result": {} })).is_none());
        let missing = handle_message(&*host, &json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/list" })).unwrap();
        assert_eq!(missing["error"]["code"], -32601);
        let ping = handle_message(&*host, &json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" })).unwrap();
        assert_eq!(ping["result"], json!({}));
        let list = handle_message(&*host, &json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" })).unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), TOOL_NAMES.len());
        assert!(host.seen().is_empty());
    }

    #[test]
    fn tool_results_and_errors_reach_the_client_as_results() {
        let host = TestHost::new();
        assert_eq!(call(&host, "read_document", json!({ "from": 2 })), (false, "done".to_string()));
        // no arguments at all reach the webview as an empty object
        handle_message(&*host, &tools_call(2, json!({ "name": "undo" }))).unwrap();
        assert_eq!(
            host.seen(),
            vec![("read_document".to_string(), json!({ "from": 2 })), ("undo".to_string(), json!({}))]
        );

        // a refusal from the webview is a tool result the model can read, not a protocol error
        let refusing = TestHost::answering(Err("x".into()));
        let reply = handle_message(&*refusing, &tools_call(3, json!({ "name": "delete_blocks", "arguments": { "from": 9 } })))
            .unwrap();
        assert!(reply.get("error").is_none(), "{reply}");
        assert_eq!(reply["result"]["isError"], true);
        assert_eq!(reply["result"]["content"][0]["text"], "x");
    }

    #[test]
    fn unknown_tools_never_reach_the_host() {
        let host = TestHost::new();
        let unknown = handle_message(&*host, &tools_call(4, json!({ "name": "nope" }))).unwrap();
        assert_eq!(unknown["error"]["code"], -32602);
        assert!(unknown["error"]["message"].as_str().unwrap().contains("nope"));
        // a spreadsheet tool from the sibling app is just as unknown here
        let sheet = handle_message(&*host, &tools_call(5, json!({ "name": "read_range" }))).unwrap();
        assert_eq!(sheet["error"]["code"], -32602);
        let nameless = handle_message(&*host, &tools_call(6, json!({ "arguments": {} }))).unwrap();
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
        Running::start(host.clone(), 0, Arc::new(Mutex::new(TOKEN.into()))).unwrap()
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

    #[test]
    fn rejects_a_port_that_is_taken() {
        let host = TestHost::new();
        let (_server, port) = start(&host);
        let err = Running::start(host.clone(), port, Arc::new(Mutex::new(TOKEN.into())))
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
