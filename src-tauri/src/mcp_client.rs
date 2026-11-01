//! MCP client: connects to the MCP servers the user added, over stdio or Streamable HTTP, so
//! the Assistant can list and call their tools. Header and env values are secrets (API keys,
//! tokens): they never appear in `Debug` output or in an error message.

use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    ffi::{OsStr, OsString},
    fmt, fs,
    io::{self, BufRead, BufReader, ErrorKind, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{mcp::PROTOCOLS, LockExt};

/// The most DocBro reads for one message: an HTTP response, or one line from a stdio server.
const MAX_MESSAGE: u64 = 4 * 1024 * 1024;
/// How much of a stdio server's stderr is kept to explain a failure.
const STDERR_TAIL: usize = 4096;
/// A server whose tool list goes on for more pages than this is treated as broken.
const MAX_PAGES: usize = 50;
/// Environment variables a stdio server gets from DocBro; everything else it needs is
/// configured. `PATH` is made by `child_path`.
const INHERITED_ENV: &[&str] = &["HOME", "USER", "LANG", "TMPDIR"];
const INHERITED_ENV_WINDOWS: &[&str] = &["SystemRoot", "USERPROFILE", "APPDATA", "PATHEXT"];

// ------------------------------------------------------------------- settings

#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(tag = "transport", rename_all = "lowercase")]
pub enum ServerSpec {
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
}

/// Shows header and env names, never their values.
impl fmt::Debug for ServerSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let keys = self.secret_keys();
        match self {
            ServerSpec::Http { url, .. } => {
                f.debug_struct("Http").field("url", url).field("headers", &keys).finish()
            }
            ServerSpec::Stdio { command, args, .. } => f
                .debug_struct("Stdio")
                .field("command", command)
                .field("args", args)
                .field("env", &keys)
                .finish(),
        }
    }
}

impl ServerSpec {
    pub fn transport(&self) -> &'static str {
        match self {
            ServerSpec::Http { .. } => "http",
            ServerSpec::Stdio { .. } => "stdio",
        }
    }

    /// The URL, or the command line that runs.
    pub fn summary(&self) -> String {
        match self {
            ServerSpec::Http { url, .. } => url.clone(),
            ServerSpec::Stdio { command, args, .. } => std::iter::once(command)
                .chain(args)
                .map(|a| {
                    let plain = !a.is_empty() && !a.contains(|c: char| c.is_whitespace() || c == '"');
                    if plain { a.clone() } else { format!("\"{}\"", a.replace('"', "\\\"")) }
                })
                .collect::<Vec<_>>()
                .join(" "),
        }
    }

    /// The header or env map: values are secrets.
    pub(crate) fn secrets(&self) -> &BTreeMap<String, String> {
        match self {
            ServerSpec::Http { headers, .. } => headers,
            ServerSpec::Stdio { env, .. } => env,
        }
    }

    pub(crate) fn secrets_mut(&mut self) -> &mut BTreeMap<String, String> {
        match self {
            ServerSpec::Http { headers, .. } => headers,
            ServerSpec::Stdio { env, .. } => env,
        }
    }

    pub fn secret_keys(&self) -> Vec<String> {
        self.secrets().keys().cloned().collect()
    }

    /// Text to scrub from every message: each value, and each long word in it (the token of
    /// `Bearer <token>`, which a server may echo on its own). Longest first.
    fn secret_values(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for value in self.secrets().values() {
            out.push(value.clone());
            out.extend(value.split_whitespace().filter(|w| w.len() >= 8).map(str::to_string));
        }
        out.retain(|s| s.trim().len() >= 4);
        out.sort_by_key(|s| std::cmp::Reverse(s.len()));
        out.dedup();
        out
    }

    /// Refuses settings DocBro cannot use safely. Messages name keys, never values.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ServerSpec::Http { url, headers } => {
                let lower = url.trim().to_ascii_lowercase();
                let parsed = url.trim().parse::<ureq::http::Uri>().ok();
                if !(lower.starts_with("http://") || lower.starts_with("https://"))
                    || parsed.and_then(|u| u.host().map(str::to_string)).is_none_or(|h| h.is_empty())
                {
                    return Err("The URL must start with http:// or https://".into());
                }
                for (name, value) in headers {
                    let token = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c);
                    if name.is_empty() || !name.chars().all(token) {
                        return Err(format!("\"{name}\" is not a valid header name"));
                    }
                    let reserved = ["host", "content-length", "content-type", "accept", "connection",
                        "transfer-encoding", "mcp-session-id", "mcp-protocol-version"];
                    if reserved.contains(&name.to_ascii_lowercase().as_str()) {
                        return Err(format!("The {name} header is set by DocBro"));
                    }
                    if !value.chars().all(|c| c == '\t' || (' '..='~').contains(&c)) {
                        return Err(format!(
                            "The value of the {name} header contains a line break or another character headers cannot hold"
                        ));
                    }
                }
            }
            ServerSpec::Stdio { command, args, env } => {
                if command.trim().is_empty() {
                    return Err("Enter the command to run".into());
                }
                if command.contains('\0') || args.iter().any(|a| a.contains('\0')) {
                    return Err("The command contains a NUL character".into());
                }
                for (name, value) in env {
                    if name.is_empty() || name.contains(['=', '\0']) {
                        return Err(format!("\"{name}\" is not a valid environment variable name"));
                    }
                    if value.contains('\0') {
                        return Err(format!("The value of {name} contains a NUL character"));
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
}

/// A live connection to one server. Every `Err` starts with the server's label.
pub trait Connection: Send {
    fn list_tools(&mut self) -> Result<Vec<ToolInfo>, String>;
    /// A tool that fails, or a JSON-RPC error the server answers, is `Ok` with `is_error`, so
    /// the model can read why. `Err` means the connection itself failed.
    fn call_tool(&mut self, name: &str, args: &Value) -> Result<ToolOutput, String>;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Timeouts {
    /// for `initialize` and for listing the tools
    pub handshake: Duration,
    pub call: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts { handshake: Duration::from_secs(10), call: Duration::from_secs(60) }
    }
}

#[allow(dead_code)] // the client API with the real limits; the chat loop (Task 16) may use it
pub fn connect(label: &str, spec: &ServerSpec) -> Result<Box<dyn Connection>, String> {
    connect_with(label, spec, Timeouts::default())
}

pub fn connect_with(label: &str, spec: &ServerSpec, timeouts: Timeouts) -> Result<Box<dyn Connection>, String> {
    let secrets = spec.secret_values();
    let fail = |e: String| redact(&format!("{label}: {e}"), &secrets);
    spec.validate().map_err(fail)?;
    let wire: Box<dyn Wire> = match spec {
        ServerSpec::Http { url, headers } => Box::new(HttpWire::new(url.trim(), headers)),
        ServerSpec::Stdio { command, args, env } => Box::new(StdioWire::spawn(command, args, env).map_err(fail)?),
    };
    let mut client = Client { label: label.to_string(), wire, timeouts, next_id: 1, secrets: secrets.clone() };
    // a failed handshake drops the client, which stops a stdio child
    client.handshake().map_err(fail)?;
    Ok(Box::new(client))
}

fn redact(text: &str, secrets: &[String]) -> String {
    secrets.iter().fold(text.to_string(), |t, s| t.replace(s.as_str(), "[hidden]"))
}

/// At most `max` characters of text a server sent.
pub(crate) fn cut(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_string(),
    }
}

fn human(d: Duration) -> String {
    if d >= Duration::from_secs(1) && d.subsec_millis() == 0 {
        format!("{} s", d.as_secs())
    } else {
        format!("{} ms", d.as_millis())
    }
}

/// A deadline and the budget it came from, for the message when it passes.
struct Due {
    at: Instant,
    budget: Duration,
}

impl Due {
    fn new(budget: Duration) -> Due {
        Due { at: Instant::now() + budget, budget }
    }
    fn left(&self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }
    fn timed_out(&self) -> String {
        format!("did not answer within {}", human(self.budget))
    }
}

// --------------------------------------------------------------- JSON-RPC

/// One transport. Errors here are not prefixed with the label yet.
trait Wire: Send {
    /// Sends a request and returns the server's reply to it (an object with `result` or `error`).
    fn request(&mut self, msg: &Value, id: u64, due: &Due) -> Result<Value, String>;
    fn notify(&mut self, msg: &Value, due: &Due) -> Result<(), String>;
    fn set_protocol(&mut self, _version: &str) {}
}

/// The reply with `id` in a message or a batch.
fn find_reply(msg: Value, id: u64) -> Option<Value> {
    match msg {
        Value::Array(items) => items.into_iter().find_map(|m| find_reply(m, id)),
        Value::Object(ref o)
            if o.get("id") == Some(&json!(id)) && (o.contains_key("result") || o.contains_key("error")) =>
        {
            Some(msg)
        }
        _ => None,
    }
}

struct Client {
    label: String,
    wire: Box<dyn Wire>,
    timeouts: Timeouts,
    next_id: u64,
    secrets: Vec<String>,
}

enum Answer {
    Result(Value),
    /// a JSON-RPC error: the server is fine, it refused this request
    Refused(String),
}

impl Client {
    fn rpc(&mut self, method: &str, params: Value, due: &Due) -> Result<Answer, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let mut reply = self.wire.request(&msg, id, due)?;
        if let Some(error) = reply.get("error") {
            let message = error["message"].as_str().map(|m| cut(m, 1000));
            let code = error["code"].as_i64().unwrap_or(0);
            return Ok(Answer::Refused(message.unwrap_or_else(|| format!("error {code}"))));
        }
        Ok(Answer::Result(reply["result"].take()))
    }

    /// `rpc` where a refusal is a failure.
    fn expect(&mut self, method: &str, params: Value, due: &Due) -> Result<Value, String> {
        match self.rpc(method, params, due)? {
            Answer::Result(v) => Ok(v),
            Answer::Refused(m) => Err(format!("{method} failed: {m}")),
        }
    }

    fn handshake(&mut self) -> Result<(), String> {
        let due = Due::new(self.timeouts.handshake);
        let params = json!({
            "protocolVersion": PROTOCOLS[0],
            "capabilities": {},
            "clientInfo": { "name": "docbro", "title": "DocBro", "version": env!("CARGO_PKG_VERSION") },
        });
        let result = self.expect("initialize", params, &due)?;
        let version = result["protocolVersion"].as_str().unwrap_or("");
        if !PROTOCOLS.contains(&version) {
            return Err(format!("it speaks MCP version \"{}\", which DocBro does not support", cut(version, 40)));
        }
        let version = version.to_string();
        self.wire.set_protocol(&version);
        self.wire.notify(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), &due)
    }

    fn list(&mut self) -> Result<Vec<ToolInfo>, String> {
        let due = Due::new(self.timeouts.handshake);
        let (mut tools, mut cursor, mut seen) = (Vec::new(), None::<String>, HashSet::new());
        for _ in 0..MAX_PAGES {
            let params = cursor.as_ref().map_or_else(|| json!({}), |c| json!({ "cursor": c }));
            let result = self.expect("tools/list", params, &due)?;
            tools.extend(result["tools"].as_array().into_iter().flatten().filter_map(tool_info));
            match result["nextCursor"].as_str() {
                None | Some("") => return Ok(tools),
                Some(next) if !seen.insert(next.to_string()) => {
                    return Err("its tool list repeats the same page over and over".into())
                }
                Some(next) => cursor = Some(next.to_string()),
            }
        }
        Err(format!("its tool list goes on for more than {MAX_PAGES} pages"))
    }

    fn fail(&self, e: String) -> String {
        redact(&format!("{}: {e}", self.label), &self.secrets)
    }
}

fn tool_info(v: &Value) -> Option<ToolInfo> {
    let name = v["name"].as_str().filter(|n| !n.is_empty())?;
    let schema = v.get("inputSchema").filter(|s| s.is_object());
    Some(ToolInfo {
        name: name.to_string(),
        description: v["description"].as_str().unwrap_or("").to_string(),
        input_schema: schema.cloned().unwrap_or_else(|| json!({ "type": "object" })),
    })
}

fn tool_output(result: &Value) -> ToolOutput {
    let blocks = result["content"].as_array().into_iter().flatten();
    let parts: Vec<String> = blocks
        .map(|b| match b["type"].as_str().unwrap_or("") {
            "text" => b["text"].as_str().unwrap_or("").to_string(),
            "resource" | "resource_link" => "[resource]".into(),
            other => format!("[{}]", cut(other, 20)),
        })
        .collect();
    let mut text = parts.join("\n");
    if text.is_empty() {
        if let Some(data) = result.get("structuredContent") {
            text = data.to_string();
        }
    }
    ToolOutput { text, is_error: result["isError"].as_bool().unwrap_or(false) }
}

impl Connection for Client {
    fn list_tools(&mut self) -> Result<Vec<ToolInfo>, String> {
        self.list().map_err(|e| self.fail(e))
    }

    fn call_tool(&mut self, name: &str, args: &Value) -> Result<ToolOutput, String> {
        let due = Due::new(self.timeouts.call);
        let args = if args.is_null() { json!({}) } else { args.clone() };
        match self.rpc("tools/call", json!({ "name": name, "arguments": args }), &due) {
            Ok(Answer::Result(result)) => Ok(tool_output(&result)),
            Ok(Answer::Refused(m)) => Ok(ToolOutput { text: redact(&m, &self.secrets), is_error: true }),
            Err(e) => Err(self.fail(e)),
        }
    }
}

// ---------------------------------------------------------------------- HTTP

/// Ends a body read with an error once more than `left` bytes come.
struct Capped<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for Capped<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.left == 0 {
            return match self.inner.read(&mut [0u8; 1])? {
                0 => Ok(0),
                _ => Err(io::Error::new(ErrorKind::FileTooLarge, "too large")),
            };
        }
        let max = buf.len().min(usize::try_from(self.left).unwrap_or(usize::MAX));
        let n = self.inner.read(&mut buf[..max])?;
        self.left -= n as u64;
        Ok(n)
    }
}

fn too_large() -> String {
    "it sent a message larger than 4 MiB".into()
}

fn read_error(e: io::Error, due: &Due) -> String {
    if e.kind() == ErrorKind::FileTooLarge {
        return too_large();
    }
    match ureq::Error::from(e) {
        ureq::Error::Timeout(_) => due.timed_out(),
        ureq::Error::Io(e) if e.kind() == ErrorKind::TimedOut => due.timed_out(),
        ureq::Error::Io(e) => format!("the connection broke off: {e}"),
        other => format!("the connection broke off: {other}"),
    }
}

/// Reads Server-Sent Events until one carries the reply with `id`; skips comments, other
/// fields and unrelated messages. `None` when the stream ends without it.
fn read_sse(body: impl Read, id: u64) -> io::Result<Option<Value>> {
    let mut reader = BufReader::new(body);
    let (mut data, mut line) = (String::new(), Vec::new());
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\n', '\r']);
        if n == 0 || text.is_empty() {
            if !data.is_empty() {
                let msg = serde_json::from_str(&data).ok();
                if let Some(reply) = msg.and_then(|m| find_reply(m, id)) {
                    return Ok(Some(reply));
                }
                data.clear();
            }
            if n == 0 {
                return Ok(None);
            }
            continue;
        }
        let (field, value) = text.split_once(':').unwrap_or((text, ""));
        if field == "data" {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
}

struct HttpWire {
    agent: ureq::Agent,
    url: String,
    headers: Vec<(String, String)>,
    session: Option<String>,
    protocol: Option<String>,
}

impl HttpWire {
    fn new(url: &str, headers: &BTreeMap<String, String>) -> HttpWire {
        let agent = ureq::Agent::config_builder()
            // a redirect could carry the Authorization header to another host
            .max_redirects(0)
            .http_status_as_error(false)
            .user_agent(concat!("DocBro/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        let headers = headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        HttpWire { agent, url: url.to_string(), headers, session: None, protocol: None }
    }

    /// POSTs one message; returns a 2xx response.
    fn post(&mut self, msg: &Value, due: &Due) -> Result<ureq::http::Response<ureq::Body>, String> {
        if due.left().is_zero() {
            return Err(due.timed_out());
        }
        let mut req = self
            .agent
            .post(&self.url)
            .config()
            .timeout_global(Some(due.left()))
            .build()
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream");
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        if let Some(session) = &self.session {
            req = req.header("Mcp-Session-Id", session);
        }
        if let Some(version) = &self.protocol {
            req = req.header("MCP-Protocol-Version", version);
        }
        let res = req.send(msg.to_string()).map_err(|e| match e {
            ureq::Error::Timeout(_) => due.timed_out(),
            ureq::Error::HostNotFound => format!("could not find the host of {}", self.url),
            ureq::Error::ConnectionFailed => format!("could not connect to {}", self.url),
            ureq::Error::Io(e) => match e.kind() {
                ErrorKind::TimedOut => due.timed_out(),
                ErrorKind::ConnectionRefused => format!("nothing answers at {}. Is the server running?", self.url),
                _ => format!("the request failed: {e}"),
            },
            other => format!("the request failed: {other}"),
        })?;
        if let Some(session) = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            self.session = Some(session.to_string());
        }
        let status = res.status().as_u16();
        match status {
            200..=299 => Ok(res),
            300..=399 => Err(format!(
                "the server redirects to another address (HTTP {status}). DocBro does not follow \
                 redirects, so enter the final URL"
            )),
            _ => {
                let mut body = Vec::new();
                let _ = Capped { inner: res.into_body().into_reader(), left: 64 * 1024 }.read_to_end(&mut body);
                let detail = serde_json::from_slice::<Value>(&body)
                    .ok()
                    .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
                    .unwrap_or_else(|| String::from_utf8_lossy(&body).trim().to_string());
                let hint = match status {
                    401 | 403 => " Check its headers, such as Authorization.",
                    404 if self.session.is_some() => " The session may have ended: switch the server off and on.",
                    _ => "",
                };
                let detail = if detail.is_empty() { String::new() } else { format!(": {}", cut(&detail, 300)) };
                Err(format!("the server answered HTTP {status}{detail}.{hint}"))
            }
        }
    }
}

impl Wire for HttpWire {
    fn request(&mut self, msg: &Value, id: u64, due: &Due) -> Result<Value, String> {
        let res = self.post(msg, due)?;
        if res.status().as_u16() == 202 {
            return Err("the server accepted the request but sent no answer".into());
        }
        let sse = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.trim().to_ascii_lowercase().starts_with("text/event-stream"));
        let mut body = Capped { inner: res.into_body().into_reader(), left: MAX_MESSAGE };
        let reply = if sse {
            read_sse(body, id).map_err(|e| read_error(e, due))?
        } else {
            let mut bytes = Vec::new();
            body.read_to_end(&mut bytes).map_err(|e| read_error(e, due))?;
            serde_json::from_slice(&bytes).ok().and_then(|m| find_reply(m, id))
        };
        reply.ok_or_else(|| "the server's answer did not contain a reply to the request".into())
    }

    fn notify(&mut self, msg: &Value, due: &Due) -> Result<(), String> {
        self.post(msg, due).map(drop)
    }

    fn set_protocol(&mut self, version: &str) {
        self.protocol = Some(version.to_string());
    }
}

// --------------------------------------------------------------------- stdio

/// The `PATH` a stdio server starts with. An app opened from the Finder inherits only
/// `/usr/bin:/bin:/usr/sbin:/sbin`, where `npx`, `uvx` and the `node` their scripts ask for
/// (`#!/usr/bin/env node`) are missing. So: the command's own folder first, then the inherited
/// `PATH`, then (macOS and Linux) the usual install folders that exist. A `PATH` in the
/// server's configured env replaces all of this.
fn child_path(
    command: &str,
    inherited: &OsStr,
    home: Option<&Path>,
    nvm_bin: Option<&Path>,
    exists: &dyn Fn(&Path) -> bool,
) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut add = |dir: PathBuf| {
        // an empty entry means the working folder, which a server should not run from
        if !dir.as_os_str().is_empty() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };
    let command = Path::new(command);
    if command.is_absolute() {
        if let Some(folder) = command.parent() {
            add(folder.to_path_buf());
        }
    }
    std::env::split_paths(inherited).for_each(&mut add);
    if cfg!(unix) {
        let mut common = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
        if let Some(home) = home {
            common.extend([home.join(".local/bin"), home.join(".cargo/bin")]);
        }
        common.extend(nvm_bin.map(Path::to_path_buf));
        common.into_iter().filter(|d| exists(d)).for_each(&mut add);
    }
    std::env::join_paths(&dirs).unwrap_or_else(|_| inherited.to_os_string())
}

/// The `bin` folder of the newest Node.js that nvm installed.
fn newest_nvm_bin(home: &Path) -> Option<PathBuf> {
    let version = |name: &str| -> Option<Vec<u64>> {
        name.strip_prefix('v')?.split('.').map(|part| part.parse().ok()).collect()
    };
    fs::read_dir(home.join(".nvm/versions/node"))
        .ok()?
        .flatten()
        .filter_map(|e| Some((version(&e.file_name().to_string_lossy())?, e.path().join("bin"))))
        .filter(|(_, bin)| bin.is_dir())
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, bin)| bin)
}

enum Incoming {
    Message(Value),
    TooLong,
}

struct StdioWire {
    child: Child,
    command: String,
    /// lines for the thread that writes the child's stdin; dropping it closes stdin
    to_child: Option<mpsc::Sender<Vec<u8>>>,
    from_child: mpsc::Receiver<Incoming>,
    stderr: Arc<Mutex<VecDeque<u8>>>,
    stderr_done: mpsc::Receiver<()>,
}

impl StdioWire {
    fn spawn(command: &str, args: &[String], env: &BTreeMap<String, String>) -> Result<StdioWire, String> {
        let command = command.trim();
        let mut cmd = Command::new(command);
        // no shell: the program runs with exactly these arguments
        cmd.args(args).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let windows: &[&str] = if cfg!(windows) { INHERITED_ENV_WINDOWS } else { &[] };
        for key in INHERITED_ENV.iter().chain(windows) {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        // a bare command name is looked up in this PATH too (unix)
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let nvm = home.as_deref().and_then(newest_nvm_bin);
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        cmd.env("PATH", child_path(command, &inherited, home.as_deref(), nvm.as_deref(), &|p| p.is_dir()));
        cmd.envs(env);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: no console window pops up next to DocBro
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            ErrorKind::NotFound => format!(
                "could not start \"{command}\": there is no such program. Check the command, or enter its full path"
            ),
            _ => format!("could not start \"{command}\": {e}"),
        })?;
        let (Some(mut stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("could not connect to \"{command}\""));
        };

        let (to_child, lines) = mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            for line in lines {
                if stdin.write_all(&line).and_then(|_| stdin.flush()).is_err() {
                    break;
                }
            }
        });
        // bounded: a server that sends messages nobody waits for is held up, not buffered
        let (incoming, from_child) = mpsc::sync_channel(64);
        thread::spawn(move || read_messages(stdout, incoming));
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        let (done, stderr_done) = mpsc::channel();
        let keep = tail.clone();
        thread::spawn(move || {
            keep_tail(stderr, &keep);
            let _ = done.send(());
        });
        Ok(StdioWire { child, command: command.to_string(), to_child: Some(to_child), from_child, stderr: tail, stderr_done })
    }

    fn send(&mut self, msg: &Value) -> Result<(), String> {
        let mut line = msg.to_string().into_bytes();
        line.push(b'\n');
        match &self.to_child {
            Some(tx) if tx.send(line).is_ok() => Ok(()),
            _ => Err(self.stopped()),
        }
    }

    /// The last lines the child wrote to stderr.
    fn tail(&self) -> String {
        let bytes: Vec<u8> = self.stderr.lock_recovering().iter().copied().collect();
        let text = String::from_utf8_lossy(&bytes).trim().to_string();
        if text.is_empty() { String::new() } else { format!(". Its last output:\n{text}") }
    }

    /// Why the child stopped talking, once it closed its output.
    fn stopped(&mut self) -> String {
        let mut status = None;
        for _ in 0..50 {
            if let Ok(Some(s)) = self.child.try_wait() {
                status = Some(s);
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        // the rest of stderr comes in a moment after the exit
        let _ = self.stderr_done.recv_timeout(Duration::from_millis(500));
        let how = match status {
            Some(s) => format!("stopped ({s})"),
            None => "closed its output".into(),
        };
        format!("\"{}\" {how}{}", self.command, self.tail())
    }
}

/// One JSON-RPC message per stdout line. Anything else there is a log line and skipped.
fn read_messages(out: impl Read, tx: mpsc::SyncSender<Incoming>) {
    let mut out = BufReader::new(out);
    let mut line = Vec::new();
    loop {
        line.clear();
        match out.by_ref().take(MAX_MESSAGE + 1).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let msg = if line.len() as u64 > MAX_MESSAGE && line.last() != Some(&b'\n') {
            if out.skip_until(b'\n').is_err() {
                return;
            }
            Incoming::TooLong
        } else {
            match serde_json::from_slice::<Value>(&line) {
                Ok(v) if v.is_array() || v.get("jsonrpc").is_some() => Incoming::Message(v),
                _ => continue,
            }
        };
        if tx.send(msg).is_err() {
            return;
        }
    }
}

fn keep_tail(mut err: impl Read, tail: &Mutex<VecDeque<u8>>) {
    let mut buf = [0u8; 2048];
    while let Ok(n @ 1..) = err.read(&mut buf) {
        let mut tail = tail.lock_recovering();
        tail.extend(&buf[..n]);
        let excess = tail.len().saturating_sub(STDERR_TAIL);
        tail.drain(..excess);
    }
}

impl Wire for StdioWire {
    fn request(&mut self, msg: &Value, id: u64, due: &Due) -> Result<Value, String> {
        self.send(msg)?;
        loop {
            match self.from_child.recv_timeout(due.left()) {
                Ok(Incoming::Message(m)) => {
                    // a request from the server, such as ping: answer it, or it may wait forever
                    if let (Some(rid), Some(method)) = (m.get("id"), m["method"].as_str()) {
                        let reply = if method == "ping" {
                            json!({ "jsonrpc": "2.0", "id": rid, "result": {} })
                        } else {
                            json!({ "jsonrpc": "2.0", "id": rid, "error": { "code": -32601, "message": "Method not found" } })
                        };
                        self.send(&reply)?;
                        continue;
                    }
                    if let Some(reply) = find_reply(m, id) {
                        return Ok(reply);
                    }
                }
                Ok(Incoming::TooLong) => return Err(too_large()),
                Err(mpsc::RecvTimeoutError::Timeout) => return Err(format!("{}{}", due.timed_out(), self.tail())),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(self.stopped()),
            }
        }
    }

    fn notify(&mut self, msg: &Value, _due: &Due) -> Result<(), String> {
        self.send(msg)
    }
}

impl Drop for StdioWire {
    fn drop(&mut self) {
        // closing stdin tells the server, and anything it started, to stop
        self.to_child = None;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// --------------------------------------------------------------------- tests

#[cfg(test)]
pub(crate) mod tests {
    use std::{
        fs,
        net::TcpListener,
        thread::JoinHandle,
    };

    use super::*;

    pub(crate) const SHORT: Timeouts =
        Timeouts { handshake: Duration::from_millis(400), call: Duration::from_millis(400) };

    fn tool_def(name: &str) -> Value {
        json!({ "name": name, "description": format!("The {name} tool"), "inputSchema": { "type": "object", "properties": {} } })
    }

    fn text(t: impl ToString) -> Value {
        json!({ "content": [{ "type": "text", "text": t.to_string() }] })
    }

    /// What both fake servers answer: two pages of tools and a few of them to call.
    pub(crate) fn fake_reply(msg: &Value) -> Option<Value> {
        let id = msg.get("id")?.clone();
        let params = &msg["params"];
        let result = match msg["method"].as_str().unwrap_or("") {
            "initialize" => json!({
                "protocolVersion": params["protocolVersion"],
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "fake", "version": "1" },
            }),
            "tools/list" if params["cursor"].is_null() => {
                json!({ "tools": [tool_def("echo"), tool_def("fail")], "nextCursor": "page-2" })
            }
            "tools/list" => json!({ "tools": [tool_def("env"), tool_def("pid")] }),
            "tools/call" => match params["name"].as_str().unwrap_or("") {
                "echo" => json!({ "content": [
                    { "type": "text", "text": format!("echo {}", params["arguments"]) },
                    { "type": "image", "data": "AAAA", "mimeType": "image/png" },
                    { "type": "resource", "resource": { "uri": "file:///a.txt", "text": "a" } },
                ] }),
                "fail" => json!({ "content": [{ "type": "text", "text": "it broke" }], "isError": true }),
                "env" => text(serde_json::to_string(&std::env::vars().collect::<BTreeMap<_, _>>()).unwrap()),
                "pid" => text(std::process::id()),
                other => {
                    let error = json!({ "code": -32602, "message": format!("Unknown tool: {other}") });
                    return Some(json!({ "jsonrpc": "2.0", "id": id, "error": error }));
                }
            },
            "ping" => json!({}),
            other => {
                let error = json!({ "code": -32601, "message": format!("Method not found: {other}") });
                return Some(json!({ "jsonrpc": "2.0", "id": id, "error": error }));
            }
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    // -- fake stdio server: this very test binary ---------------------------------

    #[test]
    #[ignore = "the fake MCP server that the stdio tests start"]
    fn fake_stdio_server() {
        let Ok(mode) = std::env::var("DOCBRO_FAKE_MCP") else { return };
        if let Some(mark) = std::env::var_os("DOCBRO_FAKE_MARK") {
            fs::write(mark, std::process::id().to_string()).unwrap();
        }
        if mode == "slowstart" {
            thread::sleep(Duration::from_secs(1));
        }
        // ends the line libtest may have started, then logs like real servers do
        println!();
        println!("fake MCP server reading stdin");
        if mode == "die" {
            eprintln!("{}", "x".repeat(6000));
            eprintln!("fatal: the token {} was rejected", std::env::var("NOTES_TOKEN").unwrap_or_default());
            std::process::exit(3);
        }
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            if mode == "silent" {
                continue;
            }
            if msg["params"]["name"] == "slow" {
                thread::sleep(Duration::from_secs(30));
            }
            println!("handling {}", msg["method"]);
            if let Some(reply) = fake_reply(&msg) {
                println!("{reply}");
            }
        }
        if mode == "stubborn" {
            thread::sleep(Duration::from_secs(30));
        }
    }

    pub(crate) fn fake_stdio(mode: &str, env: &[(&str, &str)]) -> ServerSpec {
        let exe = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let args = ["--exact", "mcp_client::tests::fake_stdio_server", "--ignored", "--nocapture"];
        let mut vars: BTreeMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        vars.insert("DOCBRO_FAKE_MCP".into(), mode.into());
        ServerSpec::Stdio { command: exe, args: args.map(String::from).to_vec(), env: vars }
    }

    // -- fake HTTP server ---------------------------------------------------------

    pub(crate) struct Reply {
        status: u16,
        content_type: &'static str,
        body: String,
        headers: Vec<(&'static str, String)>,
        /// keep the connection open without finishing the answer
        stall: bool,
    }

    impl Reply {
        pub(crate) fn json(v: Value) -> Reply {
            Reply { status: 200, content_type: "application/json", body: v.to_string(), headers: vec![], stall: false }
        }
        pub(crate) fn sse(body: String) -> Reply {
            Reply { content_type: "text/event-stream", body, ..Reply::json(Value::Null) }
        }
        pub(crate) fn status(status: u16, body: &str) -> Reply {
            Reply { status, body: body.to_string(), ..Reply::json(Value::Null) }
        }
        pub(crate) fn stall(self) -> Reply {
            Reply { stall: true, ..self }
        }
        pub(crate) fn header(mut self, name: &'static str, value: &str) -> Reply {
            self.headers.push((name, value.to_string()));
            self
        }
        pub(crate) fn standard(msg: &Value) -> Reply {
            fake_reply(msg).map_or_else(|| Reply::status(202, ""), Reply::json)
        }
    }

    #[derive(Clone)]
    pub(crate) struct Seen {
        pub(crate) headers: Vec<(String, String)>,
        pub(crate) body: Value,
    }

    impl Seen {
        pub(crate) fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
        }
    }

    type Handler = dyn Fn(&Value, &[(String, String)]) -> Reply + Send + Sync;

    pub(crate) struct FakeHttp {
        pub(crate) url: String,
        seen: Arc<Mutex<Vec<Seen>>>,
        server: Arc<tiny_http::Server>,
        thread: Option<JoinHandle<()>>,
    }

    /// Never ends: stands for a server that stops talking halfway through.
    struct Stalled;
    impl Read for Stalled {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            thread::sleep(Duration::from_secs(5));
            Ok(0)
        }
    }

    impl FakeHttp {
        pub(crate) fn start(handler: impl Fn(&Value, &[(String, String)]) -> Reply + Send + Sync + 'static) -> FakeHttp {
            let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
            let port = server.server_addr().to_ip().unwrap().port();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let handler: Arc<Handler> = Arc::new(handler);
            let (accept, log) = (server.clone(), seen.clone());
            let thread = thread::spawn(move || {
                for mut req in accept.incoming_requests() {
                    let (handler, log) = (handler.clone(), log.clone());
                    thread::spawn(move || {
                        let headers: Vec<(String, String)> =
                            req.headers().iter().map(|h| (h.field.to_string(), h.value.to_string())).collect();
                        let mut body = String::new();
                        req.as_reader().read_to_string(&mut body).unwrap();
                        let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                        log.lock().unwrap().push(Seen { headers: headers.clone(), body: body.clone() });
                        let reply = handler(&body, &headers);
                        let mut head: Vec<tiny_http::Header> = reply
                            .headers
                            .iter()
                            .map(|(k, v)| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap())
                            .collect();
                        head.push(tiny_http::Header::from_bytes("Content-Type", reply.content_type).unwrap());
                        let status = tiny_http::StatusCode(reply.status);
                        let data = io::Cursor::new(reply.body.clone().into_bytes());
                        let _ = if reply.stall {
                            req.respond(tiny_http::Response::new(status, head, data.chain(Stalled), None, None))
                        } else {
                            let len = Some(reply.body.len());
                            req.respond(tiny_http::Response::new(status, head, data, len, None))
                        };
                    });
                }
            });
            FakeHttp { url: format!("http://127.0.0.1:{port}/mcp"), seen, server, thread: Some(thread) }
        }

        pub(crate) fn standard() -> FakeHttp {
            FakeHttp::start(|m, _| Reply::standard(m))
        }

        pub(crate) fn seen(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().clone()
        }

        pub(crate) fn spec(&self, headers: &[(&str, &str)]) -> ServerSpec {
            let headers = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            ServerSpec::Http { url: self.url.clone(), headers }
        }
    }

    impl Drop for FakeHttp {
        fn drop(&mut self) {
            self.server.unblock();
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    /// A server that answers every request with `answer` and hangs up.
    fn raw_server(answer: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { break };
                let (mut buf, mut chunk) = (Vec::new(), [0u8; 4096]);
                loop {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                    let len: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break;
                    }
                }
                let _ = s.write_all(answer.as_bytes());
            }
        });
        format!("http://127.0.0.1:{port}/mcp")
    }

    fn names(tools: &[ToolInfo]) -> Vec<&str> {
        tools.iter().map(|t| t.name.as_str()).collect()
    }

    fn method(s: &Seen) -> &str {
        s.body["method"].as_str().unwrap_or("")
    }

    fn err(r: Result<Box<dyn Connection>, String>) -> String {
        r.err().expect("expected the connection to fail")
    }

    // -- HTTP -----------------------------------------------------------------

    #[test]
    fn http_json_and_sse_responses_both_work() {
        let fake = FakeHttp::start(|m, _| {
            if m["method"] != "tools/call" {
                return Reply::standard(m);
            }
            // a comment, a notification, a reply to another request and unknown fields come
            // first; the reply itself spans several data lines with CRLF endings
            let note = json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": { "progress": 1 } });
            let other = json!({ "jsonrpc": "2.0", "id": 999, "result": {} });
            let reply = serde_json::to_string_pretty(&fake_reply(m).unwrap()).unwrap();
            let data: String = reply.lines().map(|l| format!("data: {l}\r\n")).collect();
            Reply::sse(format!(": keep-alive\n\nevent: message\ndata: {note}\n\ndata:{other}\n\nid: 4\nretry: 10\nfoo: bar\n{data}\r\n"))
        });
        let mut conn = connect_with("Fake", &fake.spec(&[]), Timeouts::default()).unwrap();
        assert_eq!(names(&conn.list_tools().unwrap()), ["echo", "fail", "env", "pid"]);
        let out = conn.call_tool("echo", &json!({ "a": 1 })).unwrap();
        assert_eq!(out, ToolOutput { text: "echo {\"a\":1}\n[image]\n[resource]".into(), is_error: false });

        let seen = fake.seen();
        assert_eq!(seen.iter().map(method).collect::<Vec<_>>(), ["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/call"]);
        assert_eq!(seen[0].body["params"]["protocolVersion"], PROTOCOLS[0]);
        assert!(seen.iter().all(|s| s.header("Accept") == Some("application/json, text/event-stream")));
        assert!(seen.iter().all(|s| s.header("Content-Type") == Some("application/json")));
    }

    /// Hands out its input a few bytes at a time, as a network might.
    struct Trickle(Vec<u8>, usize);
    impl Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = buf.len().min(3).min(self.0.len() - self.1);
            buf[..n].copy_from_slice(&self.0[self.1..self.1 + n]);
            self.1 += n;
            Ok(n)
        }
    }

    #[test]
    fn sse_lines_split_across_reads_still_parse() {
        let stream = ": hi\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"a\":1}}\n\n\
                      data: {\"jsonrpc\":\"2.0\",\ndata: \"id\":2,\"result\":{\"b\":2}}\n\n";
        let got = read_sse(Trickle(stream.as_bytes().to_vec(), 0), 2).unwrap().unwrap();
        assert_eq!(got["result"], json!({ "b": 2 }));
        // a stream that ends without the reply
        assert!(read_sse(Trickle(stream.as_bytes().to_vec(), 0), 3).unwrap().is_none());
        // the last event is used even without its blank line
        let last = "data: {\"jsonrpc\":\"2.0\",\"id\":5,\"result\":7}";
        assert_eq!(read_sse(last.as_bytes(), 5).unwrap().unwrap()["result"], 7);
    }

    #[test]
    fn http_session_id_is_echoed_on_later_requests() {
        let fake = FakeHttp::start(|m, _| match m["method"].as_str() {
            Some("initialize") => Reply::standard(m).header("Mcp-Session-Id", "sess-42"),
            _ => Reply::standard(m),
        });
        let mut conn = connect_with("Fake", &fake.spec(&[("X-Api-Key", "k-123456789")]), Timeouts::default()).unwrap();
        conn.list_tools().unwrap();
        conn.call_tool("echo", &Value::Null).unwrap();
        let seen = fake.seen();
        assert_eq!(seen.len(), 5);
        assert_eq!(seen[0].header("Mcp-Session-Id"), None);
        assert_eq!(seen[0].header("MCP-Protocol-Version"), None);
        for s in &seen[1..] {
            assert_eq!(s.header("Mcp-Session-Id"), Some("sess-42"), "{}", method(s));
            assert_eq!(s.header("MCP-Protocol-Version"), Some(PROTOCOLS[0]), "{}", method(s));
        }
        assert!(seen.iter().all(|s| s.header("X-Api-Key") == Some("k-123456789")));
        // no arguments go out as an empty object
        assert_eq!(seen[4].body["params"]["arguments"], json!({}));
    }

    #[test]
    fn tools_list_follows_pagination() {
        let fake = FakeHttp::standard();
        let mut conn = connect_with("Fake", &fake.spec(&[]), Timeouts::default()).unwrap();
        let tools = conn.list_tools().unwrap();
        assert_eq!(names(&tools), ["echo", "fail", "env", "pid"]);
        assert_eq!(tools[0].description, "The echo tool");
        assert_eq!(tools[0].input_schema, json!({ "type": "object", "properties": {} }));
        let lists: Vec<Value> = fake.seen().iter().filter(|s| method(s) == "tools/list").map(|s| s.body["params"].clone()).collect();
        assert_eq!(lists, [json!({}), json!({ "cursor": "page-2" })]);
    }

    #[test]
    fn endless_tool_lists_stop_with_an_error() {
        // the same cursor forever
        let same = FakeHttp::start(|m, _| match m["method"].as_str() {
            Some("tools/list") => Reply::json(json!({ "jsonrpc": "2.0", "id": m["id"], "result": { "tools": [tool_def("a")], "nextCursor": "again" } })),
            _ => Reply::standard(m),
        });
        let e = connect_with("Loop", &same.spec(&[]), Timeouts::default()).unwrap().list_tools().unwrap_err();
        assert!(e.starts_with("Loop: ") && e.contains("same page"), "{e}");
        assert_eq!(same.seen().iter().filter(|s| method(s) == "tools/list").count(), 2);

        // a new cursor forever
        let fresh = FakeHttp::start(|m, _| match m["method"].as_str() {
            Some("tools/list") => Reply::json(json!({ "jsonrpc": "2.0", "id": m["id"], "result": { "tools": [], "nextCursor": format!("c{}", m["id"]) } })),
            _ => Reply::standard(m),
        });
        let e = connect_with("Loop", &fresh.spec(&[]), Timeouts::default()).unwrap().list_tools().unwrap_err();
        assert!(e.starts_with("Loop: ") && e.contains("more than 50 pages"), "{e}");
        assert_eq!(fresh.seen().iter().filter(|s| method(s) == "tools/list").count(), MAX_PAGES);
    }

    #[test]
    fn tool_errors_are_results_not_failures() {
        let fake = FakeHttp::standard();
        let mut conn = connect_with("Fake", &fake.spec(&[]), Timeouts::default()).unwrap();
        assert_eq!(conn.call_tool("fail", &json!({})).unwrap(), ToolOutput { text: "it broke".into(), is_error: true });
        // a JSON-RPC error is the server refusing this call: the model gets to read it too
        let refused = conn.call_tool("nope", &json!({})).unwrap();
        assert!(refused.is_error && refused.text.contains("Unknown tool: nope"), "{refused:?}");
        // and the connection still works
        assert!(!conn.call_tool("echo", &json!({})).unwrap().is_error);
    }

    #[test]
    fn a_connection_closed_mid_answer_is_an_error() {
        let json = raw_server("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{\"jsonrpc\":\"2.0\",\"id\":1,\"res");
        let spec = ServerSpec::Http { url: json, headers: BTreeMap::new() };
        let e = err(connect_with("Cut", &spec, Timeouts::default()));
        assert!(e.starts_with("Cut: "), "{e}");

        let sse = raw_server("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"res");
        let spec = ServerSpec::Http { url: sse, headers: BTreeMap::new() };
        let e = err(connect_with("Cut", &spec, Timeouts::default()));
        assert!(e.starts_with("Cut: ") && e.contains("did not contain a reply"), "{e}");
    }

    #[test]
    fn enormous_answers_are_refused() {
        let huge = "x".repeat(MAX_MESSAGE as usize + 10);
        let big = huge.clone();
        let json = FakeHttp::start(move |m, _| match m["method"].as_str() {
            Some("tools/list") => Reply::json(json!({ "jsonrpc": "2.0", "id": m["id"], "result": { "tools": [{ "name": "a", "description": big }] } })),
            _ => Reply::standard(m),
        });
        let e = connect_with("Big", &json.spec(&[]), Timeouts::default()).unwrap().list_tools().unwrap_err();
        assert!(e.starts_with("Big: ") && e.contains("larger than 4 MiB"), "{e}");

        let sse = FakeHttp::start(move |m, _| match m["method"].as_str() {
            Some("tools/list") => Reply::sse(format!("data: {huge}\n\n")),
            _ => Reply::standard(m),
        });
        let e = connect_with("Big", &sse.spec(&[]), Timeouts::default()).unwrap().list_tools().unwrap_err();
        assert!(e.contains("larger than 4 MiB"), "{e}");

        // stdio: an overlong line is reported, and the next line still gets through
        let mut input = vec![b'y'; MAX_MESSAGE as usize + 5];
        input.extend_from_slice(b"\nnot json\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n");
        let (tx, rx) = mpsc::sync_channel(8);
        read_messages(&input[..], tx);
        let got: Vec<Incoming> = rx.iter().collect();
        assert!(matches!(got[..], [Incoming::TooLong, Incoming::Message(_)]));
    }

    #[test]
    fn redirects_are_not_followed() {
        let elsewhere = FakeHttp::standard();
        let target = elsewhere.url.clone();
        let fake = FakeHttp::start(move |_, _| Reply::status(307, "").header("Location", &target));
        let e = err(connect_with("Moved", &fake.spec(&[("Authorization", "Bearer tok-abcdefgh")]), Timeouts::default()));
        assert!(e.starts_with("Moved: ") && e.contains("redirects"), "{e}");
        assert!(elsewhere.seen().is_empty(), "the redirect was followed");
    }

    #[test]
    fn headers_with_line_breaks_are_refused() {
        let fake = FakeHttp::standard();
        for (name, value) in [("X-Key", "abc\r\nX-Evil: 1"), ("X-Key", "abc\ndef"), ("X-Key", "abc\u{e9}"), ("Bad Name", "v"), ("Host", "evil.example")] {
            let spec = fake.spec(&[(name, value)]);
            let e = spec.validate().unwrap_err();
            assert!(!e.contains("abc") && !e.contains("evil"), "{e}");
            let e = err(connect_with("Hdr", &spec, Timeouts::default()));
            assert!(e.starts_with("Hdr: "), "{e}");
        }
        assert!(fake.seen().is_empty());
        for url in ["ftp://example.com/mcp", "file:///etc/passwd", "example.com/mcp", "http://", ""] {
            let spec = ServerSpec::Http { url: url.into(), headers: BTreeMap::new() };
            assert!(spec.validate().unwrap_err().contains("http://"), "{url}");
        }
    }

    #[test]
    fn secrets_never_appear_in_debug_output_or_errors() {
        // a server that echoes the request headers in its refusal
        let fake = FakeHttp::start(|_, headers| Reply::status(401, &format!("{headers:?}")));
        let spec = fake.spec(&[("Authorization", "Bearer tok-abcdefgh12345"), ("X-Other", "value-9876")]);
        let e = err(connect_with("Locked", &spec, Timeouts::default()));
        assert!(e.starts_with("Locked: ") && e.contains("401"), "{e}");
        for secret in ["tok-abcdefgh12345", "value-9876"] {
            assert!(!e.contains(secret), "{e}");
            assert!(!format!("{spec:?}").contains(secret));
        }
        assert!(format!("{spec:?}").contains("Authorization"));
        let stdio = fake_stdio("1", &[("API_KEY", "sk-secret-123")]);
        assert!(!format!("{stdio:?}").contains("sk-secret-123"));
        assert!(format!("{stdio:?}").contains("API_KEY"));
    }

    #[test]
    fn a_hung_server_times_out_with_its_name_in_the_error() {
        let started = Instant::now();
        let hung = FakeHttp::start(|_, _| Reply::status(200, "").stall());
        let e = err(connect_with("Notes server", &hung.spec(&[]), SHORT));
        assert!(e.starts_with("Notes server: ") && e.contains("did not answer within 400 ms"), "{e}");

        // answers with event-stream headers, then nothing
        let quiet = FakeHttp::start(|m, _| match m["method"].as_str() {
            Some("tools/call") => Reply::sse(": waiting\n\n".into()).stall(),
            _ => Reply::standard(m),
        });
        let mut conn = connect_with("Notes server", &quiet.spec(&[]), SHORT).unwrap();
        let e = conn.call_tool("echo", &json!({})).unwrap_err();
        assert!(e.starts_with("Notes server: ") && e.contains("within 400 ms"), "{e}");

        let e = err(connect_with("Notes server", &fake_stdio("silent", &[]), SHORT));
        assert!(e.starts_with("Notes server: ") && e.contains("within 400 ms"), "{e}");

        let timeouts = Timeouts { handshake: Duration::from_secs(10), call: Duration::from_millis(400) };
        let mut conn = connect_with("Notes server", &fake_stdio("1", &[]), timeouts).unwrap();
        let e = conn.call_tool("slow", &json!({})).unwrap_err();
        assert!(e.starts_with("Notes server: ") && e.contains("within 400 ms"), "{e}");
        assert!(started.elapsed() < Duration::from_secs(8), "{:?}", started.elapsed());
    }

    // -- stdio ----------------------------------------------------------------

    #[test]
    fn stdio_roundtrip_and_ignores_non_json_lines() {
        let spec = fake_stdio("1", &[("FAKE_TOKEN", "t-1")]);
        let mut conn = connect_with("Fake", &spec, Timeouts::default()).unwrap();
        assert_eq!(names(&conn.list_tools().unwrap()), ["echo", "fail", "env", "pid"]);
        let out = conn.call_tool("echo", &json!({ "a": 1 })).unwrap();
        assert_eq!(out.text, "echo {\"a\":1}\n[image]\n[resource]");
        assert!(conn.call_tool("fail", &json!({})).unwrap().is_error);

        // the child sees its configured env and a minimal part of DocBro's
        let env: BTreeMap<String, String> = serde_json::from_str(&conn.call_tool("env", &json!({})).unwrap().text).unwrap();
        assert_eq!(env.get("FAKE_TOKEN").map(String::as_str), Some("t-1"));
        // its PATH starts with the command's folder and keeps DocBro's
        let exe_dir = std::env::current_exe().unwrap().parent().unwrap().to_string_lossy().into_owned();
        let child: Vec<String> = std::env::split_paths(&env["PATH"]).map(|p| p.to_string_lossy().into_owned()).collect();
        assert_eq!(child[0], exe_dir);
        for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).filter(|d| !d.as_os_str().is_empty()) {
            assert!(child.contains(&dir.to_string_lossy().into_owned()), "{dir:?} is missing from {child:?}");
        }
        // cargo sets these for the test process; they must not leak into the child
        for leaked in ["CARGO_MANIFEST_DIR", "CARGO_PKG_NAME", "RUST_BACKTRACE"] {
            assert!(!env.contains_key(leaked), "{leaked} reached the child");
        }
    }

    #[cfg(unix)]
    fn alive(pid: &str) -> bool {
        Command::new("kill").args(["-0", pid]).stderr(Stdio::null()).status().unwrap().success()
    }

    #[cfg(unix)]
    #[test]
    fn stdio_child_is_killed_on_drop() {
        // this fake keeps running after its stdin closes, so only a kill stops it
        let mut conn = connect_with("Fake", &fake_stdio("stubborn", &[]), Timeouts::default()).unwrap();
        let pid = conn.call_tool("pid", &json!({})).unwrap().text;
        assert!(alive(&pid));
        drop(conn);
        let gone = (0..50).any(|_| {
            thread::sleep(Duration::from_millis(20));
            !alive(&pid)
        });
        assert!(gone, "process {pid} is still running");
    }

    #[test]
    fn stdio_failure_reports_the_tail_of_stderr() {
        let spec = fake_stdio("die", &[("NOTES_TOKEN", "supersecret-777")]);
        let e = err(connect_with("Notes server", &spec, Timeouts::default()));
        assert!(e.starts_with("Notes server: "), "{e}");
        assert!(e.contains("stopped") && e.contains("3"), "{e}");
        // the end of stderr, with the secret the server printed hidden
        assert!(e.contains("fatal: the token [hidden] was rejected"), "{e}");
        assert!(!e.contains("supersecret-777"), "{e}");
        let xs = e.matches('x').count();
        assert!(xs > 3000 && xs < STDERR_TAIL, "{xs} x's: not just the tail of stderr");
    }

    #[cfg(unix)]
    #[test]
    fn a_stdio_child_that_exits_at_once_is_an_error() {
        let spec = ServerSpec::Stdio { command: "true".into(), args: vec![], env: BTreeMap::new() };
        let e = err(connect_with("Quick", &spec, Timeouts::default()));
        assert!(e.starts_with("Quick: \"true\" stopped"), "{e}");
    }

    #[test]
    fn a_missing_command_is_named_in_the_error() {
        let spec = ServerSpec::Stdio { command: "docbro-no-such-program".into(), args: vec![], env: BTreeMap::new() };
        let e = err(connect_with("Gone", &spec, Timeouts::default()));
        assert!(e.starts_with("Gone: ") && e.contains("\"docbro-no-such-program\"") && e.contains("no such program"), "{e}");
        let empty = ServerSpec::Stdio { command: "  ".into(), args: vec![], env: BTreeMap::new() };
        assert!(err(connect_with("Gone", &empty, Timeouts::default())).contains("Enter the command"));
    }

    #[test]
    fn the_summary_is_the_url_or_the_command_line() {
        let spec = ServerSpec::Stdio { command: "npx".into(), args: vec!["-y".into(), "my server".into()], env: BTreeMap::new() };
        assert_eq!(spec.summary(), "npx -y \"my server\"");
        assert_eq!(spec.transport(), "stdio");
        let http = ServerSpec::Http { url: "https://x.example/mcp".into(), headers: BTreeMap::new() };
        assert_eq!((http.summary().as_str(), http.transport()), ("https://x.example/mcp", "http"));
        // the settings file spells the transport out
        let saved = serde_json::to_value(&http).unwrap();
        assert_eq!(saved, json!({ "transport": "http", "url": "https://x.example/mcp", "headers": {} }));
        let back: ServerSpec = serde_json::from_value(json!({ "transport": "stdio", "command": "srv" })).unwrap();
        assert_eq!(back, ServerSpec::Stdio { command: "srv".into(), args: vec![], env: BTreeMap::new() });
    }

    // -- the child's PATH ------------------------------------------------------

    #[cfg(unix)]
    fn path_of(command: &str, inherited: &str, home: Option<&str>, nvm: Option<&str>, present: &[&str]) -> String {
        let exists = |p: &Path| present.iter().any(|q| Path::new(q) == p);
        child_path(command, OsStr::new(inherited), home.map(Path::new), nvm.map(Path::new), &exists)
            .to_string_lossy()
            .into_owned()
    }

    #[cfg(unix)]
    #[test]
    fn child_path_puts_the_commands_directory_first() {
        assert_eq!(path_of("/opt/tools/bin/srv", "/usr/bin:/bin", None, None, &[]), "/opt/tools/bin:/usr/bin:/bin");
        // a folder already in PATH comes first and only once
        assert_eq!(path_of("/usr/bin/srv", "/bin:/usr/bin", None, None, &[]), "/usr/bin:/bin");
        // a bare name adds nothing; empty entries (the working folder) are dropped
        assert_eq!(path_of("npx", "/usr/bin::/bin", None, None, &[]), "/usr/bin:/bin");
        assert_eq!(path_of("/opt/x/srv", "", None, None, &[]), "/opt/x");
    }

    #[cfg(unix)]
    #[test]
    fn child_path_appends_only_existing_common_directories_without_duplicates() {
        let nvm = "/Users/me/.nvm/versions/node/v22.1.0/bin";
        let present = ["/opt/homebrew/bin", "/usr/local/bin", "/Users/me/.cargo/bin", nvm];
        assert_eq!(
            path_of("npx", "/usr/bin:/bin:/usr/local/bin", Some("/Users/me"), Some(nvm), &present),
            format!("/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:/Users/me/.cargo/bin:{nvm}")
        );
        // nothing exists: nothing is added
        assert_eq!(path_of("npx", "/usr/bin", Some("/Users/me"), Some(nvm), &[]), "/usr/bin");

        // the newest Node.js by version, not by name
        let home = std::env::temp_dir().join(format!("docbro-nvm-test-{}", std::process::id()));
        let versions = home.join(".nvm/versions/node");
        for v in ["v9.0.0", "v18.2.0", "v20.10.1", "v20.9.0"] {
            fs::create_dir_all(versions.join(v).join("bin")).unwrap();
        }
        fs::create_dir_all(versions.join("v99.0.0")).unwrap(); // no bin folder
        fs::create_dir_all(versions.join("system")).unwrap();
        assert_eq!(newest_nvm_bin(&home), Some(versions.join("v20.10.1/bin")));
        assert_eq!(newest_nvm_bin(Path::new("/nonexistent-docbro-home")), None);
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_configured_path_overrides_the_computed_one() {
        let spec = fake_stdio("1", &[("PATH", "/docbro/only")]);
        let mut conn = connect_with("Fake", &spec, Timeouts::default()).unwrap();
        let env: BTreeMap<String, String> = serde_json::from_str(&conn.call_tool("env", &json!({})).unwrap().text).unwrap();
        assert_eq!(env["PATH"], "/docbro/only");
    }

    /// `start-server` runs `docbro-fake-helper` by bare name, as `#!/usr/bin/env node` finds
    /// `node`: it only works when the command's own folder is on the child's PATH.
    #[cfg(unix)]
    #[test]
    fn a_script_finds_its_neighbours_through_the_commands_directory() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("docbro-path-script-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let exe = std::env::current_exe().unwrap();
        let scripts = [
            ("docbro-fake-helper", format!("#!/bin/sh\nexec '{}' --exact mcp_client::tests::fake_stdio_server --ignored --nocapture\n", exe.display())),
            ("start-server", "#!/bin/sh\nexec docbro-fake-helper\n".to_string()),
        ];
        for (name, body) in &scripts {
            fs::write(dir.join(name), body).unwrap();
            fs::set_permissions(dir.join(name), fs::Permissions::from_mode(0o755)).unwrap();
        }
        let spec = |extra: &[(&str, &str)]| {
            let mut env: BTreeMap<String, String> = extra.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            env.insert("DOCBRO_FAKE_MCP".into(), "1".into());
            ServerSpec::Stdio { command: dir.join("start-server").to_string_lossy().into_owned(), args: vec![], env }
        };
        let mut conn = connect_with("Script", &spec(&[]), Timeouts::default()).unwrap();
        assert_eq!(conn.list_tools().unwrap().len(), 4);
        // with PATH pinned to the system folders, the helper is not found
        let e = err(connect_with("Script", &spec(&[("PATH", "/usr/bin:/bin")]), Timeouts::default()));
        assert!(e.starts_with("Script: ") && e.contains("stopped"), "{e}");
        drop(conn);
        fs::remove_dir_all(&dir).unwrap();
    }
}
