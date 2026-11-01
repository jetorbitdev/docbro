//! The Assistant's chat with Claude: its settings in `assistant.json` (private to the user,
//! since it holds the API key), the Anthropic Messages API streamed over `ureq` on a worker
//! thread, and the tool loop. Document tools go through the same window dispatcher as external
//! MCP clients (`calls::call_in_window`), so each edit is one undo step; tools of the user's
//! MCP servers go through `Servers::call`.
//!
//! The API key never leaves Rust: the webview only learns its last four characters, and it is
//! never logged, put in `Debug` output, or in an error message.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    panic::{self, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, Window};

use crate::{
    calls, files, mcp,
    mcp_client::{cut, ToolInfo, ToolOutput},
    servers::RESERVED_ID,
    AppState, CmdResult, LockExt,
};

/// Same as `identifier` in tauri.conf.json.
const APP_ID: &str = "com.jetorbit.docbro";
pub const DEFAULT_MODEL: &str = "claude-sonnet-5-5";

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 4096;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// until the response headers arrive
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(60);
/// between two reads of the stream; the API sends `ping` events while it is busy
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Model rounds per message: each round is one reply, and the tools it asks for.
const MAX_ROUNDS: usize = 12;
/// Characters of a tool result the model gets.
const MAX_RESULT: usize = 20_000;
/// Tool names sent to the model match `^[A-Za-z0-9_-]{1,64}$`.
const MAX_TOOL_NAME: usize = 64;
/// Characters of a tool's arguments and of its answer shown in the chat.
const ARGS_PREVIEW: usize = 200;
const TEXT_PREVIEW: usize = 400;

/// The event the chat in a window listens to.
const EVENT: &str = "assistant-event";

pub(crate) const NO_KEY: &str = "Add your Anthropic API key in MCP settings first.";
pub(crate) const BUSY: &str = "The assistant is still answering. Stop it first.";
const NO_MODEL: &str = "Enter a model name.";
const NO_TEXT: &str = "Type a message first.";
const KEY_REJECTED: &str = "The API key was rejected. Check it in MCP settings.";
const RATE_LIMITED: &str = "Rate limited by the Anthropic API. Try again in a moment.";
const UNREACHABLE: &str = "Could not reach the Anthropic API.";
const BROKE_OFF: &str = "The connection to the Anthropic API broke off.";
const LIMIT: &str = "The assistant stopped after 12 rounds of tool calls. Send another message to let it go on.";
const INTERNAL: &str = "The assistant stopped because of an internal error. Try again.";
const WINDOW_CLOSED: &str = "The document window was closed.";
// what the model reads for a tool call that was not run
const STOPPED: &str = "Stopped by the user before this tool ran.";
const CUT_OFF: &str = "Not run: the reply was cut off before this tool call was complete.";
const OUT_OF_ROUNDS: &str = "Not run: the assistant reached its limit of 12 rounds of tool calls.";

// -------------------------------------------------------------------- config

/// What `assistant.json` holds. No `Debug`: it carries the API key.
#[derive(Serialize, Deserialize)]
#[serde(default)]
struct Config {
    api_key: String,
    model: String,
}

impl Default for Config {
    fn default() -> Self {
        Config { api_key: String::new(), model: DEFAULT_MODEL.into() }
    }
}

/// What the webview may know about the settings: the key's last four characters, never the key.
#[derive(Serialize, Debug, PartialEq)]
pub struct Status {
    pub configured: bool,
    pub key_hint: Option<String>,
    pub model: String,
}

impl Config {
    fn status(&self) -> Status {
        let chars: Vec<char> = self.api_key.chars().collect();
        // a short key would give most of itself away
        let key_hint = (chars.len() > 8).then(|| chars[chars.len() - 4..].iter().collect());
        Status { configured: !self.api_key.is_empty(), key_hint, model: self.model.clone() }
    }
}

fn config_path() -> CmdResult<PathBuf> {
    dirs::config_dir()
        .map(|d| d.join(APP_ID).join("assistant.json"))
        .ok_or_else(|| "No config directory".to_string())
}

/// A missing or broken file is no settings.
fn read_config(path: &Path) -> Config {
    // a file someone else could read is made private before anything else
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
            }
        }
    }
    let mut config = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Config>(&text).ok())
        .unwrap_or_default();
    if config.model.trim().is_empty() {
        config.model = DEFAULT_MODEL.into();
    }
    config
}

// --------------------------------------------------------------- chat state

/// One window's conversation.
#[derive(Default)]
struct Chat {
    /// every turn so far, in the API's shape: the user's messages, the replies with their tool
    /// calls, and the tool results. Empty while a message is answered: the worker has it.
    history: Vec<Value>,
    /// the message being answered
    running: Option<Run>,
}

struct Run {
    id: u64,
    cancel: Arc<AtomicBool>,
}

/// A message that may be answered now. No `Debug`: it carries the API key.
pub(crate) struct Begun {
    pub(crate) id: u64,
    pub(crate) cancel: Arc<AtomicBool>,
    /// the conversation so far, ending with the user's message
    pub(crate) history: Vec<Value>,
    /// how long the history was before the user's message
    pub(crate) before: usize,
    pub(crate) key: String,
    pub(crate) model: String,
}

/// The settings, read from the file whenever they are needed, and the chat of every window;
/// kept in `AppState`.
pub struct Assistant {
    file: CmdResult<PathBuf>,
    /// saves read the file, change it and write it back: they take turns
    saving: Mutex<()>,
    /// by window label
    chats: Mutex<HashMap<String, Chat>>,
    next_run: AtomicU64,
}

impl Assistant {
    pub fn load() -> Assistant {
        Assistant::at(config_path())
    }

    pub(crate) fn at(file: CmdResult<PathBuf>) -> Assistant {
        Assistant { file, saving: Mutex::new(()), chats: Mutex::new(HashMap::new()), next_run: AtomicU64::new(0) }
    }

    fn config(&self) -> Config {
        self.file.as_deref().map(read_config).unwrap_or_default()
    }

    fn write(&self, config: &Config) -> CmdResult<()> {
        let path = self.file.as_deref().map_err(Clone::clone)?;
        let failed = |e: String| format!("Could not save the assistant settings: {e}");
        fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(|e| failed(e.to_string()))?;
        let json = serde_json::to_string_pretty(config).map_err(|e| failed(e.to_string()))?;
        files::write_private(path, json.as_bytes()).map_err(failed)
    }

    pub fn status(&self) -> Status {
        self.config().status()
    }

    /// `api_key` None (or blank) keeps the saved key.
    pub fn save(&self, api_key: Option<String>, model: String) -> CmdResult<Status> {
        let model = model.trim();
        if model.is_empty() {
            return Err(NO_MODEL.into());
        }
        let _turn = self.saving.lock_recovering();
        let mut config = self.config();
        if let Some(key) = api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
            config.api_key = key;
        }
        config.model = model.to_string();
        self.write(&config)?;
        Ok(config.status())
    }

    pub fn clear_key(&self) -> CmdResult<Status> {
        let _turn = self.saving.lock_recovering();
        let mut config = self.config();
        config.api_key.clear();
        self.write(&config)?;
        Ok(config.status())
    }

    /// Takes the user's message in window `label`, if there is a key and the window's chat is
    /// not answering another one, and marks the chat busy until `finish`.
    pub(crate) fn begin(&self, label: &str, text: &str) -> CmdResult<Begun> {
        let text = text.trim();
        if text.is_empty() {
            return Err(NO_TEXT.into());
        }
        let config = self.config();
        if config.api_key.is_empty() {
            return Err(NO_KEY.into());
        }
        let mut chats = self.chats.lock_recovering();
        let chat = chats.entry(label.to_string()).or_default();
        if chat.running.is_some() {
            return Err(BUSY.into());
        }
        let id = self.next_run.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        chat.running = Some(Run { id, cancel: cancel.clone() });
        let mut history = std::mem::take(&mut chat.history);
        let before = history.len();
        history.push(json!({ "role": "user", "content": text }));
        Ok(Begun { id, cancel, history, before, key: config.api_key, model: config.model })
    }

    /// Message `id` is over: its conversation is kept and the chat takes the next message.
    /// False when the chat was reset meanwhile; the history is then thrown away.
    pub(crate) fn finish(&self, label: &str, id: u64, history: Vec<Value>) -> bool {
        let mut chats = self.chats.lock_recovering();
        let Some(chat) = chats.get_mut(label).filter(|c| c.running.as_ref().is_some_and(|r| r.id == id)) else {
            return false;
        };
        chat.history = history;
        chat.running = None;
        true
    }

    fn is_current(&self, label: &str, id: u64) -> bool {
        self.chats.lock_recovering().get(label).and_then(|c| c.running.as_ref()).is_some_and(|r| r.id == id)
    }

    /// Stops the answer at the next chance: before the next tool call or model round, or
    /// between two pieces of the stream. The chat stays busy until the loop has stopped.
    pub fn cancel(&self, label: &str) {
        if let Some(run) = self.chats.lock_recovering().get(label).and_then(|c| c.running.as_ref()) {
            run.cancel.store(true, Ordering::SeqCst);
        }
    }

    /// Drops the conversation and stops its answer, which then sends nothing more. The window
    /// may send a new message at once.
    pub fn reset(&self, label: &str) {
        if let Some(run) = self.chats.lock_recovering().remove(label).and_then(|c| c.running) {
            run.cancel.store(true, Ordering::SeqCst);
        }
    }
}

// ------------------------------------------------------------------- tools

/// The name the model sees for `tool` of server `server_id`.
pub(crate) fn tool_name(server_id: &str, tool: &str) -> String {
    let safe = |c: char| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' };
    format!("{server_id}__{tool}").chars().map(safe).take(MAX_TOOL_NAME).collect()
}

/// The server and tool behind a name the model used, looked up in the table of the tools it
/// was offered. Names are never split on `__`: a tool's own name may contain it.
pub(crate) fn split_tool_name(name: &str, known: &[(String, String)]) -> Option<(String, String)> {
    known.iter().find(|(server, tool)| tool_name(server, tool) == name).cloned()
}

/// The tool list for the API, and the (server id, tool) table to map the model's names back.
/// `builtin` is the document server's list in MCP's shape (`mcp::tool_defs`). When two tools
/// end up with the same name, only the first is offered.
pub(crate) fn build_tools(builtin: &[Value], external: &[(String, ToolInfo)]) -> (Vec<Value>, Vec<(String, String)>) {
    let text = |v: &Value| v.as_str().unwrap_or_default().to_string();
    let builtin = builtin
        .iter()
        .map(|d| (RESERVED_ID.to_string(), text(&d["name"]), text(&d["description"]), d["inputSchema"].clone()));
    let external =
        external.iter().map(|(id, t)| (id.clone(), t.name.clone(), t.description.clone(), t.input_schema.clone()));
    let (mut defs, mut known, mut names) = (Vec::new(), Vec::new(), HashSet::new());
    for (server, tool, description, schema) in builtin.chain(external) {
        let name = tool_name(&server, &tool);
        if !names.insert(name.clone()) {
            continue;
        }
        // the API refuses the whole request over one schema that is not an object schema
        let schema = if schema["type"] == "object" { schema } else { json!({ "type": "object" }) };
        defs.push(json!({ "name": name, "description": description, "input_schema": schema }));
        known.push((server, tool));
    }
    (defs, known)
}

/// The system prompt of one message. `doc_info_json` is what `document_info` answered, or
/// empty when the document tools are off.
pub(crate) fn build_system_prompt(doc_info_json: &str, selection: Option<&str>) -> String {
    let mut prompt = String::from(
        "You are the assistant in DocBro, a word processor. You help the user with the document open \
         in this window: you answer questions about it and change it when asked, using the tools you \
         are given.\n",
    );
    if !doc_info_json.trim().is_empty() {
        prompt.push('\n');
        prompt.push_str(&describe_document(doc_info_json));
        prompt.push_str(
            "\nRead the document with read_document before you quote it or say what it contains. \
             Every edit tool call is one step the user can undo.\n",
        );
    }
    if let Some(text) = selection.filter(|s| !s.trim().is_empty()) {
        prompt.push_str(&format!("\nThe user selected: \"{text}\"\n"));
    }
    prompt.push_str("\nAnswer in the user's language.");
    prompt
}

fn describe_document(info: &str) -> String {
    let Ok(info) = serde_json::from_str::<Value>(info) else {
        return format!("Document info: {info}\n");
    };
    let name = info["name"].as_str().unwrap_or("Untitled");
    let blocks = info["blocks"].as_u64().unwrap_or(0);
    let plural = if blocks == 1 { "" } else { "s" };
    let mut text = format!("The open document is \"{name}\", {blocks} block{plural} long.\n");
    match info["outline"].as_array().filter(|o| !o.is_empty()) {
        Some(outline) => {
            text.push_str("Its outline (headings and their block numbers):\n");
            for heading in outline {
                let depth = heading["level"].as_u64().unwrap_or(1).clamp(1, 3) as usize - 1;
                let title = heading["text"].as_str().unwrap_or_default();
                text.push_str(&format!("{}- {title} (block {})\n", "  ".repeat(depth), heading["block"]));
            }
        }
        None => text.push_str("It has no headings.\n"),
    }
    text
}

/// A tool result as the model gets it: at most `MAX_RESULT` characters.
pub(crate) fn trim_result(text: &str) -> String {
    match text.char_indices().nth(MAX_RESULT) {
        Some((i, _)) => format!("{}… truncated", &text[..i]),
        None => text.to_string(),
    }
}

// --------------------------------------------------------------- the stream

/// What the Anthropic stream says, as the loop needs it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum StreamEvent {
    Text(String),
    /// a whole tool call, once its input has streamed in
    ToolUse { id: String, name: String, input: Value },
    /// `stop_reason`
    Stop(String),
    Error(String),
}

/// Reads the Messages API's Server-Sent Events from chunks of any size.
#[derive(Default)]
pub(crate) struct SseParser {
    /// the start of a line whose end has not arrived yet
    line: Vec<u8>,
    /// the `data` of the event being read
    data: String,
    /// tool calls being streamed, by block index: (id, name, their input's JSON so far)
    tools: HashMap<u64, (String, String, String)>,
}

impl SseParser {
    pub(crate) fn feed(&mut self, chunk: &[u8]) -> Vec<StreamEvent> {
        self.line.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut start = 0;
        while let Some(end) = self.line[start..].iter().position(|&b| b == b'\n') {
            let raw = &self.line[start..start + end];
            // lines are only decoded once whole, so a character split across chunks survives
            lines.push(String::from_utf8_lossy(raw.strip_suffix(b"\r").unwrap_or(raw)).into_owned());
            start += end + 1;
        }
        self.line.drain(..start);
        let mut events = Vec::new();
        for line in lines {
            self.take_line(&line, &mut events);
        }
        events
    }

    fn take_line(&mut self, line: &str, events: &mut Vec<StreamEvent>) {
        if line.is_empty() {
            let data = std::mem::take(&mut self.data);
            if !data.is_empty() {
                self.dispatch(&data, events);
            }
            return;
        }
        // `event:` repeats the data's `type`; comments (`:`) and other fields are not needed
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        if field == "data" {
            if !self.data.is_empty() {
                self.data.push('\n');
            }
            self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }

    fn dispatch(&mut self, data: &str, events: &mut Vec<StreamEvent>) {
        let Ok(msg) = serde_json::from_str::<Value>(data) else { return };
        let index = msg["index"].as_u64().unwrap_or(0);
        let text = |v: &Value| v.as_str().unwrap_or_default().to_string();
        let mut push_text = |t: &Value| {
            if let Some(t) = t.as_str().filter(|t| !t.is_empty()) {
                events.push(StreamEvent::Text(t.to_string()));
            }
        };
        match msg["type"].as_str().unwrap_or_default() {
            "content_block_start" => {
                let block = &msg["content_block"];
                match block["type"].as_str() {
                    Some("tool_use") => {
                        self.tools.insert(index, (text(&block["id"]), text(&block["name"]), String::new()));
                    }
                    Some("text") => push_text(&block["text"]),
                    _ => {}
                }
            }
            "content_block_delta" => {
                let delta = &msg["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => push_text(&delta["text"]),
                    Some("input_json_delta") => {
                        if let Some((_, _, json)) = self.tools.get_mut(&index) {
                            json.push_str(delta["partial_json"].as_str().unwrap_or_default());
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some((id, name, json)) = self.tools.remove(&index) {
                    // no input at all is an empty object; a broken one (a reply cut off) is too,
                    // and such a call is never run
                    let input = serde_json::from_str::<Value>(&json).ok().filter(Value::is_object).unwrap_or_else(|| json!({}));
                    events.push(StreamEvent::ToolUse { id, name, input });
                }
            }
            "message_delta" => {
                if let Some(reason) = msg["delta"]["stop_reason"].as_str() {
                    events.push(StreamEvent::Stop(reason.to_string()));
                }
            }
            "error" => {
                let error = &msg["error"];
                let message = error["message"].as_str().or(error["type"].as_str()).unwrap_or("unknown error");
                events.push(StreamEvent::Error(message.to_string()));
            }
            _ => {}
        }
    }
}

/// What a failed request is shown as. `body` is the API's answer.
pub(crate) fn http_error(status: u16, body: &str, model: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| body.trim().to_string());
    match status {
        401 => KEY_REJECTED.into(),
        429 => RATE_LIMITED.into(),
        // the API answers 404 `model: <name>` for a model it does not know
        400 | 404 if is_about_the_model(&message) => format!("The model \"{model}\" is not available to this key."),
        _ if message.is_empty() => format!("Anthropic API error {status}."),
        _ => format!("Anthropic API error {status}: {}", cut(&message, 300)),
    }
}

fn is_about_the_model(message: &str) -> bool {
    let m = message.to_lowercase();
    let says_missing = ["not found", "unknown", "not available", "unavailable", "does not exist", "invalid model"];
    m.starts_with("model:") || (m.contains("model") && says_missing.iter().any(|s| m.contains(s)))
}

// ----------------------------------------------------------------- the loop

/// What `assistant-event` carries to the window's chat.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Event {
    Text { delta: String },
    /// `args` is the arguments' JSON, cut to 200 characters
    ToolStart { id: String, server: String, name: String, args: String },
    /// `text` is the tool's answer, cut to 400 characters
    ToolEnd { id: String, ok: bool, text: String },
    Done,
    Error { message: String },
}

/// One streamed reply per call. `request` holds the `messages`; the rest of the request
/// (model, system prompt, tools) belongs to the model.
pub(crate) trait Model {
    fn stream(&self, request: &Value, on: &mut dyn FnMut(StreamEvent)) -> Result<(), String>;
}

pub(crate) trait ToolRunner {
    /// The (server id, tool) table of the tools the model was offered (`build_tools`).
    fn known(&self) -> &[(String, String)];
    /// `Err` is a failure the model reads, like an output with `is_error`.
    fn run(&mut self, server: &str, tool: &str, args: &Value) -> Result<ToolOutput, String>;
}

/// One reply as it streamed in.
#[derive(Default)]
struct Reply {
    content: Vec<Value>,
    /// text that came after the last block in `content`
    text: String,
    uses: Vec<(String, String, Value)>,
    stop: Option<String>,
    error: Option<String>,
}

impl Reply {
    fn take(&mut self, event: StreamEvent, emit: &mut dyn FnMut(Event)) {
        match event {
            StreamEvent::Text(delta) => {
                self.text.push_str(&delta);
                emit(Event::Text { delta });
            }
            StreamEvent::ToolUse { id, name, input } => {
                self.end_text();
                self.content.push(json!({ "type": "tool_use", "id": id, "name": name, "input": input }));
                self.uses.push((id, name, input));
            }
            StreamEvent::Stop(reason) => self.stop = Some(reason),
            StreamEvent::Error(message) => self.error = Some(message),
        }
    }

    /// The API refuses empty text blocks, so only text that came in becomes one.
    fn end_text(&mut self) {
        if !self.text.is_empty() {
            self.content.push(json!({ "type": "text", "text": std::mem::take(&mut self.text) }));
        }
    }
}

fn refused(text: &str) -> ToolOutput {
    ToolOutput { text: text.into(), is_error: true }
}

fn run_tool(tools: &mut dyn ToolRunner, emit: &mut dyn FnMut(Event), id: &str, name: &str, input: &Value) -> ToolOutput {
    let Some((server, tool)) = split_tool_name(name, tools.known()) else {
        return refused(&format!("There is no tool named {name}."));
    };
    let args = serde_json::to_string(input).unwrap_or_default();
    emit(Event::ToolStart { id: id.into(), server: server.clone(), name: tool.clone(), args: cut(&args, ARGS_PREVIEW) });
    let output = tools.run(&server, &tool, input).unwrap_or_else(|text| ToolOutput { text, is_error: true });
    emit(Event::ToolEnd { id: id.into(), ok: !output.is_error, text: cut(&output.text, TEXT_PREVIEW) });
    output
}

/// Answers the user's message at the end of `history`: streams a reply, runs the tools it asks
/// for, sends their results back, and goes on while the model asks for tools, for at most
/// `MAX_ROUNDS` replies. Every tool call in `history` gets its result, even one that was not
/// run, so the conversation can always go on. Emits `Done` when the answer is complete or was
/// stopped; an `Err` is for the caller to show.
pub(crate) fn run_turn(
    model: &dyn Model,
    tools: &mut dyn ToolRunner,
    history: &mut Vec<Value>,
    emit: &mut dyn FnMut(Event),
    cancel: &AtomicBool,
) -> Result<(), String> {
    let stopped = || cancel.load(Ordering::SeqCst);
    for round in 1..=MAX_ROUNDS {
        if stopped() {
            emit(Event::Done);
            return Ok(());
        }
        let mut reply = Reply::default();
        let streamed = model.stream(&json!({ "messages": history }), &mut |event| {
            // nothing more is shown once stopped, or after an error
            if !stopped() && reply.error.is_none() {
                reply.take(event, emit);
            }
        });
        if !stopped() {
            streamed?;
            if let Some(message) = reply.error {
                return Err(format!("Anthropic API error: {message}"));
            }
            if reply.stop.is_none() {
                return Err(BROKE_OFF.into());
            }
        }
        reply.end_text();
        if !reply.content.is_empty() {
            history.push(json!({ "role": "assistant", "content": reply.content }));
        }
        if reply.uses.is_empty() {
            emit(Event::Done);
            return Ok(());
        }
        let wants_tools = reply.stop.as_deref() == Some("tool_use");
        let mut results = Vec::new();
        for (id, name, input) in &reply.uses {
            let output = if stopped() {
                refused(STOPPED)
            } else if !wants_tools {
                refused(CUT_OFF)
            } else if round == MAX_ROUNDS {
                refused(OUT_OF_ROUNDS)
            } else {
                run_tool(tools, emit, id, name, input)
            };
            let content = trim_result(&output.text);
            results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": content, "is_error": output.is_error }));
        }
        history.push(json!({ "role": "user", "content": results }));
        if stopped() || !wants_tools {
            emit(Event::Done);
            return Ok(());
        }
    }
    Err(LIMIT.into())
}

// ---------------------------------------------------------------- the API

/// The Messages API, streamed with `ureq`'s blocking reader: run it on a worker thread.
/// No `Debug`: it carries the API key.
pub(crate) struct AnthropicModel {
    agent: ureq::Agent,
    key: String,
    model: String,
    system: String,
    tools: Vec<Value>,
    url: String,
    cancel: Arc<AtomicBool>,
}

impl AnthropicModel {
    /// `url` is the Messages endpoint; tests point it at a local server.
    pub(crate) fn new(key: &str, model: &str, system: String, tools: Vec<Value>, url: &str, cancel: Arc<AtomicBool>) -> AnthropicModel {
        let agent = ureq::Agent::config_builder()
            // a redirect could carry the key to another host
            .max_redirects(0)
            .http_status_as_error(false)
            .user_agent(concat!("DocBro/", env!("CARGO_PKG_VERSION")))
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_response(Some(RESPONSE_TIMEOUT))
            .timeout_per_read(Some(READ_TIMEOUT))
            .build()
            .into();
        AnthropicModel { agent, key: key.into(), model: model.into(), system, tools, url: url.into(), cancel }
    }

    /// Whatever the API says back never shows the key, even if it repeats it.
    fn hide_key(&self, text: String) -> String {
        if self.key.is_empty() {
            return text;
        }
        text.replace(&self.key, "[hidden]")
    }
}

impl Model for AnthropicModel {
    fn stream(&self, request: &Value, on: &mut dyn FnMut(StreamEvent)) -> Result<(), String> {
        let mut body = json!({
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "messages": request["messages"],
            "stream": true,
        });
        if !self.system.is_empty() {
            body["system"] = json!(self.system);
        }
        if !self.tools.is_empty() {
            body["tools"] = json!(self.tools);
        }
        let res = self
            .agent
            .post(&self.url)
            .header("x-api-key", &self.key)
            .header("anthropic-version", API_VERSION)
            .header("Content-Type", "application/json")
            .send(body.to_string())
            // the error could name the address, never the key, but the user needs neither
            .map_err(|_| UNREACHABLE.to_string())?;
        let status = res.status().as_u16();
        if !(200..300).contains(&status) {
            let mut answer = Vec::new();
            let _ = res.into_body().into_reader().take(64 * 1024).read_to_end(&mut answer);
            return Err(self.hide_key(http_error(status, &String::from_utf8_lossy(&answer), &self.model)));
        }
        let mut reader = res.into_body().into_reader();
        let (mut parser, mut chunk) = (SseParser::default(), [0u8; 8192]);
        while !self.cancel.load(Ordering::SeqCst) {
            let n = reader.read(&mut chunk).map_err(|_| BROKE_OFF.to_string())?;
            if n == 0 {
                break;
            }
            for event in parser.feed(&chunk[..n]) {
                on(match event {
                    StreamEvent::Error(message) => StreamEvent::Error(self.hide_key(message)),
                    event => event,
                });
            }
        }
        Ok(())
    }
}

// ------------------------------------------------------------- the worker

/// What came with a message besides its text.
struct Ask {
    /// the text the user added with "+ Selection"
    context: Option<String>,
    /// the server picked with an @mention: only its tools are offered, with the document's
    /// own tools unless those are switched off
    only: Option<String>,
    /// the built-in document server is switched on
    builtin: bool,
}

/// Document tools run in the window that asked; the others on the user's MCP servers.
struct AppTools<'a> {
    app: &'a AppHandle,
    label: &'a str,
    known: Vec<(String, String)>,
}

impl ToolRunner for AppTools<'_> {
    fn known(&self) -> &[(String, String)] {
        &self.known
    }

    fn run(&mut self, server: &str, tool: &str, args: &Value) -> Result<ToolOutput, String> {
        if server == RESERVED_ID {
            return in_window(self.app, self.label, tool, args).map(|text| ToolOutput { text, is_error: false });
        }
        self.app.state::<AppState>().servers.call(server, tool, args)
    }
}

/// Runs a document tool in window `label`. `call_in_window` opens a window that is missing, but
/// a chat whose window closed must not bring it back.
fn in_window(app: &AppHandle, label: &str, tool: &str, args: &Value) -> Result<String, String> {
    if app.get_webview_window(label).is_none() {
        return Err(WINDOW_CLOSED.into());
    }
    calls::call_in_window(app, label, tool, args)
}

fn converse(
    app: &AppHandle,
    label: &str,
    run: &Begun,
    ask: &Ask,
    history: &mut Vec<Value>,
    emit: &mut dyn FnMut(Event),
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (builtin, doc_info) = match ask.builtin {
        // without the facts the prompt just has no document section
        true => (mcp::tool_defs(), in_window(app, label, "document_info", &json!({})).unwrap_or_default()),
        false => (Vec::new(), String::new()),
    };
    // a server that is off is never started: `tools_for` only connects to enabled ones
    let external = match ask.only.as_deref() {
        Some(RESERVED_ID) => Vec::new(),
        only => state.servers.tools_for(only),
    };
    let (defs, known) = build_tools(&builtin, &external);
    let system = build_system_prompt(&doc_info, ask.context.as_deref());
    let model = AnthropicModel::new(&run.key, &run.model, system, defs, API_URL, run.cancel.clone());
    run_turn(&model, &mut AppTools { app, label, known }, history, emit, &run.cancel)
}

/// Answers one message in window `label` with `converse` and frees the chat, however the
/// answer ends: done, stopped, failed or panicked. The closing `done` or `error` goes out once
/// the chat is free, so the next message can follow it at once; a chat that was reset
/// meanwhile hears nothing more from this answer.
fn settle(
    assistant: &Assistant,
    label: &str,
    mut run: Begun,
    send: &dyn Fn(Event),
    converse: impl FnOnce(&Begun, &mut Vec<Value>, &mut dyn FnMut(Event)) -> Result<(), String>,
) {
    let mut history = std::mem::take(&mut run.history);
    let mut emit = |event: Event| {
        if event != Event::Done && assistant.is_current(label, run.id) {
            send(event);
        }
    };
    let outcome = panic::catch_unwind(AssertUnwindSafe(|| converse(&run, &mut history, &mut emit)));
    let last = match outcome {
        Ok(Ok(())) => Event::Done,
        Ok(Err(message)) => {
            // a message that got no answer at all is dropped, so sending it again does not send it twice
            if history.len() == run.before + 1 {
                history.truncate(run.before);
            }
            Event::Error { message }
        }
        // the history may end in a tool call with no result: back to before the message
        Err(_) => {
            history.truncate(run.before);
            Event::Error { message: INTERNAL.into() }
        }
    };
    if assistant.finish(label, run.id, history) {
        send(last);
    }
}

fn answer(app: AppHandle, label: String, run: Begun, ask: Ask) {
    let send = |event: Event| {
        let _ = app.emit_to(label.as_str(), EVENT, event);
    };
    settle(&app.state::<AppState>().assistant, &label, run, &send, |run, history, emit| {
        converse(&app, &label, run, &ask, history, emit)
    });
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn assistant_status(state: State<AppState>) -> Status {
    state.assistant.status()
}

/// `api_key` None keeps the saved key.
#[tauri::command]
pub fn assistant_save(api_key: Option<String>, model: String, state: State<AppState>) -> CmdResult<Status> {
    state.assistant.save(api_key, model)
}

#[tauri::command]
pub fn assistant_clear_key(state: State<AppState>) -> CmdResult<Status> {
    state.assistant.clear_key()
}

/// Returns at once; the answer comes as `assistant-event`s to this window.
#[tauri::command]
pub fn assistant_send(
    text: String,
    context: Option<String>,
    only: Option<String>,
    exclude_builtin: Option<bool>,
    window: Window,
    state: State<AppState>,
) -> CmdResult<()> {
    let label = window.label().to_string();
    let run = state.assistant.begin(&label, &text)?;
    let ask = Ask { context, only, builtin: !exclude_builtin.unwrap_or(false) };
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || answer(app, label, run, ask));
    Ok(())
}

#[tauri::command]
pub fn assistant_cancel(window: Window, state: State<AppState>) {
    state.assistant.cancel(window.label());
}

#[tauri::command]
pub fn assistant_reset(window: Window, state: State<AppState>) {
    state.assistant.reset(window.label());
}

#[cfg(test)]
mod tests;
