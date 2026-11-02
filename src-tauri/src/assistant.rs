//! The Assistant's chat with Claude: its settings in `assistant.json` (private to the user,
//! since it holds the API key), the Anthropic Messages API streamed over `ureq` on a worker
//! thread, and the tool loop. Document tools go through the same window dispatcher as external
//! MCP clients (`calls::call_in_window`), so each edit is one undo step; tools of the user's
//! MCP servers go through `Servers::call`.
//!
//! The API key never leaves Rust: the webview only learns its last four characters, and it is
//! never logged, put in `Debug` output, or in an error message.
//!
//! A second engine, Claude Code (`claude_code`), runs the user's own `claude` CLI instead of the
//! API. The CLI runs its own tool loop, so it sits beside `run_turn` and shares the rest: the
//! chat of each window, `settle` and the `assistant-event`s.
//!
//! A third engine, any provider with an OpenAI-compatible API (`openai`), is one more `Model`
//! for `run_turn`.

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
    calls,
    claude_code::{self, ClaudeStatus, Session},
    files, mcp,
    mcp_client::{cut, ToolInfo, ToolOutput},
    servers::RESERVED_ID,
    AppState, CmdResult, LockExt,
};

mod openai;
use openai::{Endpoint, OpenAiModel, OpenAiStatus, Preset, ProviderDraft};

/// Same as `identifier` in tauri.conf.json.
const APP_ID: &str = "com.jetorbit.docbro";
pub const DEFAULT_MODEL: &str = "claude-sonnet-5-5";
/// What Claude Code runs unless the user picks another model: a CLI alias.
pub const DEFAULT_CLAUDE_MODEL: &str = "sonnet";

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 4096;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// until the response headers arrive
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(60);
/// between two reads of the stream; the API sends `ping` events while it is busy
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Model rounds per message: each round is one reply, and the tools it asks for.
pub(crate) const MAX_ROUNDS: usize = 12;
/// Characters of a tool result the model gets.
const MAX_RESULT: usize = 20_000;
/// Tool names sent to the model match `^[A-Za-z0-9_-]{1,64}$`.
const MAX_TOOL_NAME: usize = 64;
/// Characters of a tool's arguments and of its answer shown in the chat.
pub(crate) const ARGS_PREVIEW: usize = 200;
pub(crate) const TEXT_PREVIEW: usize = 400;

/// The event the chat in a window listens to.
const EVENT: &str = "assistant-event";

pub(crate) const NO_KEY: &str = "Add your Anthropic API key in MCP settings first.";
pub(crate) const BUSY: &str = "The assistant is still answering. Stop it first.";
const NO_MODEL: &str = "Enter a model name.";
const NO_TEXT: &str = "Type a message first.";
const NOT_ANTHROPIC_KEY: &str = "Enter the provider's API key in its own settings.";
const KEY_REJECTED: &str = "The API key was rejected. Check it in MCP settings.";
const RATE_LIMITED: &str = "Rate limited by the Anthropic API. Try again in a moment.";
const UNREACHABLE: &str = "Could not reach the Anthropic API.";
const BROKE_OFF: &str = "The connection to the Anthropic API broke off.";
pub(crate) const LIMIT: &str = "The assistant stopped after 12 rounds of tool calls. Send another message to let it go on.";
const INTERNAL: &str = "The assistant stopped because of an internal error. Try again.";
const WINDOW_CLOSED: &str = "The document window was closed.";
// what the model reads for a tool call that was not run
const STOPPED: &str = "Stopped by the user before this tool ran.";
const CUT_OFF: &str = "Not run: the reply was cut off before this tool call was complete.";
const OUT_OF_ROUNDS: &str = "Not run: the assistant reached its limit of 12 rounds of tool calls.";

// -------------------------------------------------------------------- config

/// Who answers: the user's Claude Code CLI on their Claude subscription, the Anthropic API
/// with their key, or another provider through an OpenAI-compatible API.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    ClaudeCode,
    ApiKey,
    #[serde(rename = "openai_compatible")]
    OpenAiCompatible,
}

/// What `assistant.json` holds. No `Debug`: it carries the API key.
#[derive(Serialize, Deserialize)]
#[serde(default)]
struct Config {
    api_key: String,
    /// the API's model
    model: String,
    /// None until the user picks one; see `engine()`
    #[serde(skip_serializing_if = "Option::is_none")]
    engine: Option<Engine>,
    /// Claude Code's model: a CLI alias (`sonnet`, `opus`, `haiku`) or a full name
    claude_model: String,
    /// where `claude` is when it is not found on its own; not in the UI
    #[serde(skip_serializing_if = "Option::is_none")]
    claude_path: Option<String>,
    /// the other provider: preset, base URL, model and its own key
    #[serde(skip_serializing_if = "openai::Settings::is_unset")]
    openai: openai::Settings,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            api_key: String::new(),
            model: DEFAULT_MODEL.into(),
            engine: None,
            claude_model: DEFAULT_CLAUDE_MODEL.into(),
            claude_path: None,
            openai: openai::Settings::default(),
        }
    }
}

/// What the webview may know about the settings: the key's last four characters, never the key.
#[derive(Serialize, Debug, PartialEq)]
pub struct Status {
    /// the engine has what it needs: a key, or a `claude` that was found
    pub configured: bool,
    pub key_hint: Option<String>,
    /// the API's model
    pub model: String,
    pub engine: Engine,
    pub claude_model: String,
    pub claude: ClaudeStatus,
    pub openai: OpenAiStatus,
}

/// The last four characters of `key`; none for a short key, which would give most of itself away.
fn key_hint(key: &str) -> Option<String> {
    let chars: Vec<char> = key.chars().collect();
    (chars.len() > 8).then(|| chars[chars.len() - 4..].iter().collect())
}

impl Config {
    /// The engine the user picked; until then Claude Code when it is installed and no key is
    /// saved, else the API.
    fn engine(&self, claude_found: bool) -> Engine {
        self.engine.unwrap_or(match claude_found && self.api_key.is_empty() {
            true => Engine::ClaudeCode,
            false => Engine::ApiKey,
        })
    }

    fn status(&self, claude: ClaudeStatus) -> Status {
        let engine = self.engine(claude.found);
        let openai = self.openai.status();
        let configured = match engine {
            Engine::ApiKey => !self.api_key.is_empty(),
            Engine::ClaudeCode => claude.found,
            Engine::OpenAiCompatible => openai.configured,
        };
        let key_hint = key_hint(&self.api_key);
        Status { configured, key_hint, model: self.model.clone(), engine, claude_model: self.claude_model.clone(), claude, openai }
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
    if config.claude_model.trim().is_empty() {
        config.claude_model = DEFAULT_CLAUDE_MODEL.into();
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
    /// where Claude Code's next message goes
    session: Session,
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
    /// the engine's model
    pub(crate) model: String,
    pub(crate) engine: Engine,
    /// the user's message, trimmed
    pub(crate) text: String,
    /// Claude Code: the `claude` found, and where the message goes
    pub(crate) claude: Option<PathBuf>,
    pub(crate) session: Session,
    /// the other provider: where the message goes
    pub(crate) endpoint: Option<Endpoint>,
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
    /// where `claude` is, and its version
    claude: claude_code::Local,
}

impl Assistant {
    pub fn load() -> Assistant {
        Assistant { claude: claude_code::Local::search(), ..Assistant::at(config_path()) }
    }

    /// Settings in `file`, and no `claude` anywhere.
    pub(crate) fn at(file: CmdResult<PathBuf>) -> Assistant {
        Assistant {
            file,
            saving: Mutex::new(()),
            chats: Mutex::new(HashMap::new()),
            next_run: AtomicU64::new(0),
            claude: claude_code::Local::fixed(None),
        }
    }

    /// `claude` is `bin`, or missing.
    #[cfg(test)]
    pub(crate) fn with_claude(self, bin: Option<PathBuf>) -> Assistant {
        Assistant { claude: claude_code::Local::fixed(bin), ..self }
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

    /// May run `claude --version` (once per app run): not on the main thread.
    pub fn status(&self) -> Status {
        self.status_of(self.config())
    }

    fn status_of(&self, config: Config) -> Status {
        let claude = self.claude.status(config.claude_path.as_deref());
        config.status(claude)
    }

    /// `api_key` is the Anthropic key; None (or blank) keeps the saved one. `engine` None keeps
    /// the engine and makes `model` the API's model; otherwise `model` is that engine's. With the
    /// other provider's engine a key is refused: it would be sent to Anthropic.
    pub fn save(&self, api_key: Option<String>, model: String, engine: Option<Engine>) -> CmdResult<Status> {
        let api_key = api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        if engine == Some(Engine::OpenAiCompatible) && api_key.is_some() {
            return Err(NOT_ANTHROPIC_KEY.into());
        }
        let model = model.trim();
        if model.is_empty() {
            return Err(NO_MODEL.into());
        }
        if engine == Some(Engine::ClaudeCode) {
            claude_code::check_model(model)?;
        }
        let turn = self.saving.lock_recovering();
        let mut config = self.config();
        if let Some(key) = api_key {
            config.api_key = key;
        }
        match engine {
            Some(Engine::ClaudeCode) => config.claude_model = model.to_string(),
            Some(Engine::OpenAiCompatible) => config.openai.set_model(model),
            _ => config.model = model.to_string(),
        }
        config.engine = engine.or(config.engine);
        self.write(&config)?;
        drop(turn);
        Ok(self.status_of(config))
    }

    pub fn clear_key(&self) -> CmdResult<Status> {
        let turn = self.saving.lock_recovering();
        let mut config = self.config();
        config.api_key.clear();
        self.write(&config)?;
        drop(turn);
        Ok(self.status_of(config))
    }

    /// Saves the other provider's settings and picks that engine. A blank `base_url` is the
    /// preset's. `api_key` None (or blank) keeps the saved key, but only while the base URL's
    /// origin stays the same. `model` may stay empty until the provider's list is loaded.
    pub fn save_openai(&self, preset: String, base_url: String, model: String, api_key: Option<String>) -> CmdResult<Status> {
        let turn = self.saving.lock_recovering();
        let mut config = self.config();
        config.openai.update(&preset, &base_url, &model, api_key)?;
        config.engine = Some(Engine::OpenAiCompatible);
        self.write(&config)?;
        drop(turn);
        Ok(self.status_of(config))
    }

    pub fn clear_openai_key(&self) -> CmdResult<Status> {
        let turn = self.saving.lock_recovering();
        let mut config = self.config();
        config.openai.clear_key();
        self.write(&config)?;
        drop(turn);
        Ok(self.status_of(config))
    }

    /// The other provider's models, with the saved settings, or with the form's before they are
    /// saved: then the saved key only goes along to its own origin, as on a save. Saves nothing
    /// and keeps the engine. Blocks on the network.
    pub fn list_models(&self, draft: Option<ProviderDraft>) -> CmdResult<Vec<String>> {
        let mut settings = self.config().openai;
        if let Some(draft) = draft {
            settings.update(&draft.preset, &draft.base_url, "", draft.api_key)?;
        }
        openai::list_models(settings.key(), &settings.endpoint()?)
    }

    /// Takes the user's message in window `label`, if the engine has what it needs (a key,
    /// `claude`, or a provider set up) and the window's chat is not answering another one, and
    /// marks the chat busy until `finish`.
    pub(crate) fn begin(&self, label: &str, text: &str) -> CmdResult<Begun> {
        let text = text.trim();
        if text.is_empty() {
            return Err(NO_TEXT.into());
        }
        let config = self.config();
        let claude = self.claude.find(config.claude_path.as_deref());
        let engine = config.engine(claude.is_some());
        let (key, model, endpoint) = match engine {
            Engine::ApiKey if config.api_key.is_empty() => return Err(NO_KEY.into()),
            Engine::ApiKey => (config.api_key, config.model, None),
            Engine::ClaudeCode if claude.is_none() => return Err(claude_code::NOT_FOUND.into()),
            Engine::ClaudeCode => {
                claude_code::check_model(&config.claude_model)?;
                (String::new(), config.claude_model, None)
            }
            Engine::OpenAiCompatible => {
                let endpoint = config.openai.endpoint()?;
                if config.openai.model().is_empty() {
                    return Err(NO_MODEL.into());
                }
                (config.openai.key().to_string(), config.openai.model().to_string(), Some(endpoint))
            }
        };
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
        // Claude Code keeps its own conversation; the others' waits for the engine to come back
        if engine != Engine::ClaudeCode {
            history.push(json!({ "role": "user", "content": text }));
        }
        let session = chat.session.clone();
        Ok(Begun { id, cancel, history, before, key, model, engine, text: text.into(), claude, session, endpoint })
    }

    /// Claude Code's next message in window `label` goes on in a copy of session `id`.
    pub(crate) fn continue_session(&self, label: &str, id: &str) -> CmdResult<()> {
        claude_code::check_session_id(id)?;
        let mut chats = self.chats.lock_recovering();
        let chat = chats.entry(label.to_string()).or_default();
        if chat.running.is_some() {
            return Err(BUSY.into());
        }
        chat.session = Session::Fork(id.into());
        Ok(())
    }

    /// Where Claude Code's next message goes once message `id` is over; dropped when the chat
    /// was reset meanwhile.
    pub(crate) fn keep_session(&self, label: &str, id: u64, session: Session) {
        let mut chats = self.chats.lock_recovering();
        if let Some(chat) = chats.get_mut(label).filter(|c| c.running.as_ref().is_some_and(|r| r.id == id)) {
            chat.session = session;
        }
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

/// The prompt is part of Claude Code's command line, so the outline in it has a size limit:
/// at most this many headings, each cut to `MAX_HEADING` characters, and a name of `MAX_NAME`.
const MAX_HEADINGS: usize = 200;
const MAX_HEADING: usize = 120;
const MAX_NAME: usize = 200;

fn describe_document(info: &str) -> String {
    let Ok(info) = serde_json::from_str::<Value>(info) else {
        return format!("Document info: {}\n", cut(info, MAX_HEADINGS * MAX_HEADING));
    };
    let name = cut(info["name"].as_str().unwrap_or("Untitled"), MAX_NAME);
    let blocks = info["blocks"].as_u64().unwrap_or(0);
    let plural = if blocks == 1 { "" } else { "s" };
    let mut text = format!("The open document is \"{name}\", {blocks} block{plural} long.\n");
    match info["outline"].as_array().filter(|o| !o.is_empty()) {
        Some(outline) => {
            text.push_str("Its outline (headings and their block numbers):\n");
            for heading in outline.iter().take(MAX_HEADINGS) {
                let depth = heading["level"].as_u64().unwrap_or(1).clamp(1, 3) as usize - 1;
                // one line per heading, whatever breaks its text has
                let title = heading["text"].as_str().unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
                text.push_str(&format!("{}- {} (block {})\n", "  ".repeat(depth), cut(&title, MAX_HEADING), heading["block"]));
            }
            if outline.len() > MAX_HEADINGS {
                text.push_str(&format!("… and {} more headings.\n", outline.len() - MAX_HEADINGS));
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

    /// The API refuses text blocks that are empty or only whitespace (as when the user stops
    /// right after a line break), so such text is dropped.
    fn end_text(&mut self) {
        let text = std::mem::take(&mut self.text);
        if !text.trim().is_empty() {
            self.content.push(json!({ "type": "text", "text": text }));
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
        let messages = match self.tools.is_empty() {
            true => without_tool_blocks(&request["messages"]),
            false => request["messages"].clone(),
        };
        let mut body = json!({
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "messages": messages,
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
            // hidden before `http_error` cuts the message, so a cut never leaves part of the key
            let answer = self.hide_key(String::from_utf8_lossy(&answer).into_owned());
            return Err(http_error(status, &answer, &self.model));
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

/// The conversation with its tool calls and results told as text. The API refuses tool blocks in
/// a request that offers no tools, which is what a conversation that used tools sends once the
/// user switches off every server it used. The history itself keeps the blocks, so they go out
/// as they are again once tools are offered.
fn without_tool_blocks(messages: &Value) -> Value {
    let Some(messages) = messages.as_array() else { return messages.clone() };
    let as_text = |block: &Value| match block["type"].as_str() {
        Some("tool_use") => {
            let name = block["name"].as_str().unwrap_or_default();
            json!({ "type": "text", "text": format!("[Called the tool {name} with {}]", block["input"]) })
        }
        Some("tool_result") => {
            let what = if block["is_error"] == true { "The tool failed" } else { "The tool answered" };
            json!({ "type": "text", "text": format!("[{what}: {}]", result_text(&block["content"])) })
        }
        _ => block.clone(),
    };
    let flat = messages.iter().map(|m| match m["content"].as_array() {
        Some(blocks) => json!({ "role": m["role"], "content": blocks.iter().map(as_text).collect::<Vec<_>>() }),
        None => m.clone(),
    });
    Value::Array(flat.collect())
}

/// A tool result's content, which is text or a list of text blocks.
pub(crate) fn result_text(content: &Value) -> String {
    match content.as_array() {
        Some(blocks) => blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        None => content.as_str().unwrap_or_default().to_string(),
    }
}

// ------------------------------------------------------------- the worker

/// What came with a message besides its text.
pub(crate) struct Ask {
    /// the text the user added with "+ Selection"
    pub(crate) context: Option<String>,
    /// the server picked with an @mention: only its tools are offered, with the document's
    /// own tools unless those are switched off
    pub(crate) only: Option<String>,
    /// the built-in document server is switched on
    pub(crate) builtin: bool,
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
pub(crate) fn in_window(app: &AppHandle, label: &str, tool: &str, args: &Value) -> Result<String, String> {
    if app.get_webview_window(label).is_none() {
        return Err(WINDOW_CLOSED.into());
    }
    calls::call_in_window(app, label, tool, args, calls::Origin::Assistant)
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
    let model: Box<dyn Model> = match &run.endpoint {
        Some(endpoint) => Box::new(OpenAiModel::new(&run.key, &run.model, endpoint.clone(), system, defs, run.cancel.clone())),
        None => Box::new(AnthropicModel::new(&run.key, &run.model, system, defs, API_URL, run.cancel.clone())),
    };
    run_turn(model.as_ref(), &mut AppTools { app, label, known }, history, emit, &run.cancel)
}

/// Answers one message in window `label` with `converse` and frees the chat, however the
/// answer ends: done, stopped, failed or panicked. The closing `done` or `error` goes out once
/// the chat is free, so the next message can follow it at once; a chat that was reset
/// meanwhile hears nothing more from this answer.
pub(crate) fn settle(
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
    settle(&app.state::<AppState>().assistant, &label, run, &send, |run, history, emit| match run.engine {
        Engine::ApiKey | Engine::OpenAiCompatible => converse(&app, &label, run, &ask, history, emit),
        Engine::ClaudeCode => claude_code::converse(&app, &label, run, &ask, emit),
    });
}

// ---------------------------------------------------------------- commands

/// Runs `f` off the main thread: the status may run `claude --version`.
async fn with_assistant<T: Send + 'static>(app: AppHandle, f: impl FnOnce(&Assistant) -> T + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>().assistant))
        .await
        .map_err(|e| format!("Internal error: {e}"))
}

#[tauri::command]
pub async fn assistant_status(app: AppHandle) -> CmdResult<Status> {
    with_assistant(app, |a| a.status()).await
}

/// `api_key` None keeps the saved key; `engine` None keeps the engine (`model` is then the API's).
#[tauri::command]
pub async fn assistant_save(api_key: Option<String>, model: String, engine: Option<Engine>, app: AppHandle) -> CmdResult<Status> {
    with_assistant(app, move |a| a.save(api_key, model, engine)).await?
}

/// `engine` `openai_compatible` removes the other provider's key; otherwise the Anthropic key.
#[tauri::command]
pub async fn assistant_clear_key(engine: Option<Engine>, app: AppHandle) -> CmdResult<Status> {
    with_assistant(app, move |a| match engine {
        Some(Engine::OpenAiCompatible) => a.clear_openai_key(),
        _ => a.clear_key(),
    })
    .await?
}

/// Saves the other provider's settings and picks that engine; see `Assistant::save_openai`.
#[tauri::command]
pub async fn assistant_save_openai(
    preset: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
    app: AppHandle,
) -> CmdResult<Status> {
    with_assistant(app, move |a| a.save_openai(preset, base_url, model, api_key)).await?
}

/// The provider's models, sorted: the saved provider's, or the one in `draft` (unsaved).
#[tauri::command]
pub async fn assistant_list_models(draft: Option<ProviderDraft>, app: AppHandle) -> CmdResult<Vec<String>> {
    with_assistant(app, move |a| a.list_models(draft)).await?
}

/// The providers the settings offer, in their order; the last is Custom.
#[tauri::command]
pub fn assistant_presets() -> &'static [Preset] {
    openai::PRESETS
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
