//! The Assistant's second engine: the user's own Claude Code CLI in print mode (`claude -p`),
//! signed in with their Claude subscription. DocBro never reads Claude Code's credentials; all
//! use of the subscription goes through the `claude` process.
//!
//! One message is one run of the CLI, in an empty folder DocBro owns. The text goes on stdin and
//! the MCP servers (DocBro's document tools and the user's servers that are on) in a temp file
//! private to the user, since their header and env values are secrets: the command line never
//! carries either. The CLI runs its own tool loop; its stream-json lines become the chat's
//! `assistant-event`s, and the chat's state, `settle` and the events are the API engine's.
//!
//! Built and tested against claude 2.1.316. Its flags and lines are an external contract, so
//! unknown lines and fields are ignored.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::{OsStr, OsString},
    fs,
    io::{BufRead, BufReader, ErrorKind, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, Window};

use crate::{
    assistant::{
        build_system_prompt, in_window, result_text, Ask, Assistant, Begun, Event, ARGS_PREVIEW, LIMIT, MAX_ROUNDS,
        TEXT_PREVIEW,
    },
    mcp::TauriHost,
    mcp_client::{self, cut, keep_tail, redact, ServerSpec, STDERR_TAIL},
    servers::{ServerConfig, RESERVED_ID},
    AppState, CmdResult, LockExt,
};

pub(crate) const NOT_FOUND: &str =
    "Claude Code was not found. Install it from claude.com/code, or switch to an API key in MCP settings.";
pub(crate) const SIGNED_OUT: &str = "Claude Code is not signed in. Run `claude` in a terminal once and sign in.";
pub(crate) const USAGE_LIMIT: &str = "Your Claude plan's usage limit was reached. Try again later.";
const NO_DOOR: &str = "DocBro could not start its document tools for Claude Code";
const NO_MODEL: &str = "Enter a Claude Code model, such as sonnet, opus or haiku.";
const BAD_SESSION: &str = "That is not a Claude Code session id.";
const BAD_LINK: &str = "Paste the link of a Claude Code session on the web, or its id.";
const FAILED: &str = "Claude Code stopped with an error.";
// what a tool card says for a call Claude Code did not allow
const DENIED: &str = "Claude Code did not allow this tool.";

/// How long `claude` gets to stop after SIGTERM before it is killed.
const KILL_AFTER: Duration = Duration::from_secs(2);
/// How often the run checks for Stop while it waits for the next line.
const POLL: Duration = Duration::from_millis(50);
/// How long the output is read after `claude` exited, for what it wrote last.
const LAST_WORDS: Duration = Duration::from_millis(500);
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
/// A longer line of the CLI's output is skipped.
const MAX_LINE: u64 = 16 * 1024 * 1024;
const MAX_ID: usize = 128;
const MAX_MODEL: usize = 100;
/// Session files listed, and looked at to fill the list.
const MAX_SESSIONS: usize = 50;
const MAX_EXAMINED: usize = 400;
/// How much of a session file is read for its label: its first message can be ~555 KB in.
const MAX_HEAD: u64 = 2 * 1024 * 1024;
/// Lines read past the first message for an `ai-title`.
const TITLE_LINES: usize = 64;
const TITLE_CHARS: usize = 80;
/// User lines that wrap something other than what the user typed.
const WRAPPERS: [&str; 6] = [
    "<command-name>",
    "<command-message>",
    "<local-command-stdout>",
    "<local-command-caveat>",
    "<ide_opened_file>",
    "<ide_selection>",
];
/// Environment variables `claude` gets from DocBro; `PATH` is made by `mcp_client::path_for`.
/// Not the API key variables: the engine runs on the user's subscription.
const INHERITED_ENV: &[&str] = &[
    "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "CLAUDE_CONFIG_DIR",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS",
];
const INHERITED_ENV_WINDOWS: &[&str] = &["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT", "TEMP", "TMP"];

// -------------------------------------------------------------------- sessions

/// Where the next message of a window's chat goes.
#[derive(Clone, Debug, PartialEq, Default)]
pub(crate) enum Session {
    /// no conversation yet: the message starts one
    #[default]
    New,
    /// on in this session: DocBro's own, or the copy it made of one the user picked
    Resume(String),
    /// on in a copy of this session, which stays as it is ("Continue a Claude Code session")
    Fork(String),
}

/// What one run passes for its conversation.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum SessionArg {
    /// `--session-id <uuid>`
    Start(String),
    /// `--resume <id>`
    Resume(String),
    /// `--resume <id> --fork-session`
    Fork(String),
}

impl Session {
    /// A new conversation gets a new id on every try, so an id that a failed run may have saved
    /// is never passed again (the CLI refuses an id in use).
    pub(crate) fn arg(&self) -> SessionArg {
        match self {
            Session::New => SessionArg::Start(new_uuid()),
            Session::Resume(id) => SessionArg::Resume(id.clone()),
            Session::Fork(id) => SessionArg::Fork(id.clone()),
        }
    }

    /// Where the message after a run goes: on in the session the run talked in (`init` names
    /// it; a fork's is new), or where this one went when the run never reached the model.
    pub(crate) fn after(&self, arg: &SessionArg, outcome: &Outcome) -> Session {
        if !outcome.conversed {
            return self.clone();
        }
        match (&outcome.session_id, arg) {
            (Some(id), _) => Session::Resume(id.clone()),
            (None, SessionArg::Start(id) | SessionArg::Resume(id)) => Session::Resume(id.clone()),
            (None, SessionArg::Fork(_)) => self.clone(),
        }
    }
}

fn new_uuid() -> String {
    let mut b = [0u8; 16];
    if getrandom::fill(&mut b).is_err() {
        // no secure source: the clock keeps ids apart, which is all a session id needs
        b = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos()).to_le_bytes();
    }
    // version 4, RFC 4122 variant
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// Session ids reach the command line: plain ones only, and never one that reads as a flag.
pub(crate) fn check_session_id(id: &str) -> CmdResult<()> {
    let plain = !id.is_empty()
        && id.len() <= MAX_ID
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    plain.then_some(()).ok_or_else(|| BAD_SESSION.to_string())
}

/// The model reaches the command line too: a CLI alias or a full name.
pub(crate) fn check_model(model: &str) -> CmdResult<()> {
    let plain = !model.is_empty()
        && model.len() <= MAX_MODEL
        && !model.starts_with('-')
        && model.chars().all(|c| c.is_ascii_alphanumeric() || "._:/[]-".contains(c));
    plain.then_some(()).ok_or_else(|| NO_MODEL.to_string())
}

// ---------------------------------------------------------- the command line

/// What one run is given besides its prompt.
pub(crate) struct RunSpec<'a> {
    pub(crate) model: &'a str,
    /// the private file `mcp_config` was written to
    pub(crate) mcp_config: &'a Path,
    /// the servers in that file, whose tools are pre-approved
    pub(crate) servers: &'a [String],
    pub(crate) system_prompt: &'a str,
    pub(crate) session: &'a SessionArg,
}

/// `claude`'s arguments. The prompt goes on stdin and the secrets into the MCP config file, so
/// neither shows in `ps`.
pub(crate) fn cli_args(spec: &RunSpec) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // none of the user's hooks, skills, settings or slash commands, and no built-in tools
        // (Bash, Edit, Read, ...): only the servers below
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .map(String::from)
    .to_vec();
    args.push(spec.mcp_config.to_string_lossy().into_owned());
    // without it print mode refuses every call; one entry each, and never followed by a
    // positional argument, which the variadic flag would take as a server
    if !spec.servers.is_empty() {
        args.push("--allowedTools".into());
        args.extend(spec.servers.iter().map(|s| format!("mcp__{s}")));
    }
    args.extend(["--append-system-prompt".into(), spec.system_prompt.into(), "--model".into(), spec.model.into()]);
    // the same limit as the API engine's; the flag works though `--help` leaves it out
    args.extend(["--max-turns".into(), MAX_ROUNDS.to_string()]);
    match spec.session {
        SessionArg::Start(id) => args.extend(["--session-id".into(), id.clone()]),
        SessionArg::Resume(id) => args.extend(["--resume".into(), id.clone()]),
        SessionArg::Fork(id) => args.extend(["--resume".into(), id.clone(), "--fork-session".into()]),
    }
    args
}

/// DocBro's own document tools, as the CLI reaches them (`mcp::Lease`).
pub(crate) struct BuiltinEndpoint {
    pub(crate) url: String,
    /// a secret, for the MCP config file only
    pub(crate) token: String,
}

/// The user's servers for one message: the ones switched on, or with an @mention only that one.
/// The built-in server is not among them (see `BuiltinEndpoint`).
pub(crate) fn pick_servers(configs: &[ServerConfig], only: Option<&str>) -> Vec<(String, ServerSpec)> {
    configs
        .iter()
        .filter(|c| c.enabled && only.is_none_or(|id| id == c.id))
        .map(|c| (c.id.clone(), c.spec.clone()))
        .collect()
}

/// The MCP config in Claude Code's format (`--mcp-config`). It holds secrets.
pub(crate) fn mcp_config(servers: &[(String, ServerSpec)], builtin: Option<&BuiltinEndpoint>) -> Value {
    let mut all = serde_json::Map::new();
    if let Some(b) = builtin {
        let auth = format!("Bearer {}", b.token);
        all.insert(RESERVED_ID.into(), json!({ "type": "http", "url": b.url, "headers": { "Authorization": auth } }));
    }
    for (id, spec) in servers {
        let entry = match spec {
            ServerSpec::Http { url, headers } => json!({ "type": "http", "url": url, "headers": headers }),
            ServerSpec::Stdio { command, args, env } => {
                json!({ "type": "stdio", "command": command, "args": args, "env": env })
            }
        };
        all.insert(id.clone(), entry);
    }
    json!({ "mcpServers": all })
}

/// The servers of a request, as named in its MCP config: the built-in one first.
fn server_names(request: &Request) -> Vec<String> {
    let builtin = request.builtin.as_ref().map(|_| RESERVED_ID.to_string());
    builtin.into_iter().chain(request.servers.iter().map(|(id, _)| id.clone())).collect()
}

/// A stdio server starts with the `PATH` the API engine gives it, unless it sets its own.
fn with_child_path(spec: ServerSpec) -> ServerSpec {
    match spec {
        ServerSpec::Stdio { command, args, mut env } => {
            if !env.contains_key("PATH") {
                env.insert("PATH".into(), mcp_client::path_for(&command).to_string_lossy().into_owned());
            }
            ServerSpec::Stdio { command, args, env }
        }
        http => http,
    }
}

/// The text `claude` reads on stdin: the message, and the text the user added with
/// "+ Selection". Both stay off the command line.
pub(crate) fn message_text(text: &str, selection: Option<&str>) -> String {
    let text = text.trim_end();
    match selection.filter(|s| !s.trim().is_empty()) {
        Some(selection) => format!("{text}\n\nThe user selected: \"{selection}\""),
        None => text.to_string(),
    }
}

// ----------------------------------------------------------------- the stream

/// Turns `claude`'s stream-json lines into the chat's events. Text comes from the streamed
/// deltas only (the whole `assistant` message repeats it); a tool card starts with the
/// `assistant` line's `tool_use` and ends with the `tool_result` of the same id.
#[derive(Default)]
pub(crate) struct ClaudeCodeParser {
    /// the servers in this run's MCP config, to split `mcp__<server>__<tool>`
    servers: Vec<String>,
    /// text to hide from error messages
    secrets: Vec<String>,
    /// tool cards shown, in order, and whether each has ended
    cards: Vec<(String, bool)>,
    /// the tool of each call Claude Code refused, by id (`permission_denied`)
    denied: HashMap<String, String>,
    signed_out: bool,
    /// a `rate_limit_event` said the plan's limit is reached
    limited: bool,
    /// the session `init` named
    pub(crate) session_id: Option<String>,
    /// `init` came
    pub(crate) started: bool,
    /// the model answered (the CLI's own messages, such as "Not logged in", do not count)
    pub(crate) conversed: bool,
    /// `result` came
    pub(crate) finished: bool,
}

impl ClaudeCodeParser {
    pub(crate) fn new(servers: &[String]) -> ClaudeCodeParser {
        ClaudeCodeParser { servers: servers.to_vec(), ..ClaudeCodeParser::default() }
    }

    /// The events of one line. `result` ends in `Done` or `Error`; anything else that is not
    /// JSON or not known is ignored.
    pub(crate) fn feed(&mut self, line: &str) -> Vec<Event> {
        let mut events = Vec::new();
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { return events };
        match msg["type"].as_str().unwrap_or_default() {
            "system" => self.system(&msg),
            "stream_event" => self.stream(&msg["event"], &mut events),
            "assistant" => self.assistant(&msg, &mut events),
            "user" => self.user(&msg, &mut events),
            "rate_limit_event" => {
                let status = msg["rate_limit_info"]["status"].as_str();
                // "allowed" and "allowed_warning" let the message through
                if status.is_some_and(|s| !s.starts_with("allowed")) {
                    self.limited = true;
                }
            }
            "result" => self.result(&msg, &mut events),
            _ => {}
        }
        events
    }

    fn system(&mut self, msg: &Value) {
        match msg["subtype"].as_str() {
            Some("init") => {
                self.started = true;
                self.session_id = msg["session_id"].as_str().map(str::to_string);
            }
            Some("permission_denied") => {
                if let (Some(id), Some(tool)) = (msg["tool_use_id"].as_str(), msg["tool_name"].as_str()) {
                    self.denied.insert(id.into(), tool.into());
                }
            }
            _ => {}
        }
    }

    fn stream(&mut self, event: &Value, events: &mut Vec<Event>) {
        if !event.is_object() {
            return;
        }
        // only the model's own answer streams
        self.conversed = true;
        let delta = &event["delta"];
        if event["type"] == "content_block_delta" && delta["type"] == "text_delta" {
            if let Some(text) = delta["text"].as_str().filter(|t| !t.is_empty()) {
                events.push(Event::Text { delta: text.into() });
            }
        }
    }

    fn assistant(&mut self, msg: &Value, events: &mut Vec<Event>) {
        if msg["error"] == "authentication_failed" {
            self.signed_out = true;
        }
        let message = &msg["message"];
        if message["model"].as_str().is_some_and(|m| m != "<synthetic>") {
            self.conversed = true;
        }
        for block in message["content"].as_array().into_iter().flatten() {
            if let (Some("tool_use"), Some(id)) = (block["type"].as_str(), block["id"].as_str()) {
                self.start(id, block["name"].as_str().unwrap_or_default(), &block["input"], events);
            }
        }
    }

    fn user(&mut self, msg: &Value, events: &mut Vec<Event>) {
        for block in msg["message"]["content"].as_array().into_iter().flatten() {
            if let (Some("tool_result"), Some(id)) = (block["type"].as_str(), block["tool_use_id"].as_str()) {
                // a list of text blocks when the tool ran, a string when the CLI answered for it
                let text = result_text(&block["content"]);
                self.end(id, block["is_error"] != true, &text, events);
            }
        }
    }

    fn result(&mut self, msg: &Value, events: &mut Vec<Event>) {
        self.finished = true;
        // a refusal leaves the result a success; these are its only trace
        for denial in msg["permission_denials"].as_array().into_iter().flatten() {
            if let Some(id) = denial["tool_use_id"].as_str() {
                self.start(id, denial["tool_name"].as_str().unwrap_or_default(), &denial["tool_input"], events);
                self.end(id, false, DENIED, events);
            }
        }
        events.push(match msg["is_error"] == true {
            true => Event::Error { message: self.failure(msg) },
            false => Event::Done,
        });
    }

    fn start(&mut self, id: &str, name: &str, input: &Value, events: &mut Vec<Event>) {
        if self.cards.iter().any(|(card, _)| card == id) {
            return;
        }
        let (server, tool) = self.split(name);
        let input = if input.is_object() { input.clone() } else { json!({}) };
        let args = serde_json::to_string(&input).unwrap_or_default();
        events.push(Event::ToolStart { id: id.into(), server, name: tool, args: cut(&args, ARGS_PREVIEW) });
        self.cards.push((id.into(), false));
    }

    fn end(&mut self, id: &str, ok: bool, text: &str, events: &mut Vec<Event>) {
        if !self.cards.iter().any(|(card, _)| card == id) {
            if let Some(tool) = self.denied.get(id).cloned() {
                self.start(id, &tool, &json!({}), events);
            }
        }
        if let Some((_, ended)) = self.cards.iter_mut().find(|(card, ended)| card == id && !*ended) {
            *ended = true;
            events.push(Event::ToolEnd { id: id.into(), ok, text: cut(text, TEXT_PREVIEW) });
        }
    }

    /// `mcp__<server>__<tool>` split with this run's servers, the longest that fits (an id may
    /// end in `_`); a name that fits none is shown as it is.
    fn split(&self, name: &str) -> (String, String) {
        self.servers
            .iter()
            .filter_map(|s| {
                let tool = name.strip_prefix("mcp__")?.strip_prefix(s.as_str())?.strip_prefix("__")?;
                Some((s, tool))
            })
            .max_by_key(|(s, _)| s.len())
            .map_or_else(|| (String::new(), name.to_string()), |(s, tool)| (s.clone(), tool.to_string()))
    }

    /// What a `result` with `is_error` is shown as.
    fn failure(&self, msg: &Value) -> String {
        let said = msg["result"].as_str().filter(|t| !t.trim().is_empty()).or_else(|| msg["errors"][0].as_str());
        // hidden before the text is cut, so a cut never leaves part of a secret
        let text = redact(said.unwrap_or_default().trim(), &self.secrets);
        if self.signed_out || text.starts_with("Not logged in") {
            return SIGNED_OUT.into();
        }
        if msg["subtype"] == "error_max_turns" {
            return LIMIT.into();
        }
        if self.limited || usage_limit(&text) {
            return usage_message(&text);
        }
        match text.is_empty() {
            true => FAILED.into(),
            false => format!("Claude Code: {}", cut(&text, 300)),
        }
    }
}

/// No usage-limit failure was seen in the spike, so the CLI's wording is matched loosely.
fn usage_limit(text: &str) -> bool {
    let text = text.to_lowercase();
    ["usage limit", "hit your limit", "limit reached", "rate limit", "rate_limit", "out of extra usage"]
        .iter()
        .any(|s| text.contains(s))
}

/// The message for a usage limit, with the CLI's own words when they say when it resets.
fn usage_message(text: &str) -> String {
    match text.to_lowercase().contains("reset") {
        true => format!("{USAGE_LIMIT} Claude Code says: {}", cut(text, 200)),
        false => USAGE_LIMIT.into(),
    }
}

/// What a run that ended without a `result` is shown as: its exit code and the last lines of
/// its stderr, which the caller has already hidden the secrets from.
pub(crate) fn exit_error(code: Option<i32>, stderr: &str, started: bool) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" ");
    if tail.contains("Not logged in") {
        return SIGNED_OUT.into();
    }
    if usage_limit(&tail) {
        return usage_message(&tail);
    }
    let how = code.map_or_else(|| "it was stopped".to_string(), |c| format!("exit code {c}"));
    let mut message = match started {
        true => format!("Claude Code stopped before it finished its answer ({how})."),
        // `init` never came: a CLI too old for these flags, or one that failed at once
        false => format!("Claude Code stopped before it started ({how}). If this goes on, update it with `claude update`."),
    };
    if !tail.is_empty() {
        message.push_str(&format!(" It said: {}", cut(&tail, 300)));
    }
    message
}

// -------------------------------------------------------------------- the run

/// One message for `run_message`.
pub(crate) struct Request {
    pub(crate) model: String,
    /// the user's servers, from `pick_servers`
    pub(crate) servers: Vec<(String, ServerSpec)>,
    /// the document tools, unless they are switched off
    pub(crate) builtin: Option<BuiltinEndpoint>,
    pub(crate) system_prompt: String,
    /// stdin, from `message_text`
    pub(crate) text: String,
}

/// Where and how `claude` runs.
pub(crate) struct Setup {
    pub(crate) bin: PathBuf,
    /// a folder DocBro owns, so no project's CLAUDE.md is read
    pub(crate) cwd: PathBuf,
    /// where the MCP config file goes
    pub(crate) temp_dir: PathBuf,
    /// the whole environment `claude` gets
    pub(crate) env: Vec<(String, OsString)>,
}

/// What a run learned about its conversation.
#[derive(Default, Debug, Clone, PartialEq)]
pub(crate) struct Outcome {
    pub(crate) session_id: Option<String>,
    pub(crate) conversed: bool,
}

/// The process groups of the runs going on, each with its MCP config file, for `stop_all`.
static GROUPS: Mutex<Vec<(u32, PathBuf)>> = Mutex::new(Vec::new());

/// The MCP config files `TempConfig` writes: `docbro-mcp-<uuid>.json`, as `new_uuid` spells it.
fn is_config_name(name: &str) -> bool {
    let Some(id) = name.strip_prefix("docbro-mcp-").and_then(|rest| rest.strip_suffix(".json")) else {
        return false;
    };
    id.len() == 36
        && id.char_indices().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { matches!(c, '0'..='9' | 'a'..='f') })
}

/// A config older than this that is still there was left by a DocBro that quit mid-run or
/// crashed. A newer one may belong to another DocBro, whose `claude` has yet to read it.
const STALE_CONFIG: Duration = Duration::from_secs(60);

/// Removes the MCP config files (they hold tokens and server headers) that runs of an earlier
/// DocBro left in the temp folder. Run at startup.
pub fn sweep_stale_configs() {
    let dir = std::env::temp_dir();
    thread::spawn(move || sweep_configs(&dir, STALE_CONFIG));
}

/// Removes from `dir` every regular file of the user's with a config's name, last changed
/// over `older_than` ago. Links, folders and other names are left alone.
fn sweep_configs(dir: &Path, older_than: Duration) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        if !entry.file_name().to_str().is_some_and(is_config_name) {
            continue;
        }
        // `DirEntry::metadata` does not follow a link
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.file_type().is_file() {
            continue;
        }
        #[cfg(unix)]
        // SAFETY: getuid() cannot fail and has no side effects
        if std::os::unix::fs::MetadataExt::uid(&meta) != unsafe { libc::getuid() } {
            continue;
        }
        let age = meta.modified().ok().and_then(|m| now.duration_since(m).ok());
        if age.is_some_and(|age| age >= older_than) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return };
    // SAFETY: kill() only sends a signal; a negative pid names the process group
    unsafe {
        libc::kill(-pid, signal);
    }
}

/// A run's MCP config file: private to the user, and removed however the run ends (the file
/// goes when this is dropped, a panic included).
struct TempConfig(PathBuf);

impl TempConfig {
    fn write(dir: &Path, config: &Value) -> std::io::Result<TempConfig> {
        fs::create_dir_all(dir)?;
        loop {
            let path = dir.join(format!("docbro-mcp-{}.json", new_uuid()));
            let mut options = fs::OpenOptions::new();
            // a new file, never one someone put there
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            match options.open(&path) {
                Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
                Ok(mut file) => {
                    let config_file = TempConfig(path);
                    file.write_all(config.to_string().as_bytes())?;
                    return Ok(config_file);
                }
            }
        }
    }
}

impl Drop for TempConfig {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// A running `claude`, in a process group of its own, so stopping it stops the MCP servers it
/// started too. Dropped before it exited (a panic included), it is stopped.
struct Claude {
    child: Child,
    over: bool,
}

impl Claude {
    /// SIGTERM to the group, then SIGKILL 2 s later, which also takes whatever the CLI left.
    fn stop(&mut self) {
        if self.over {
            return;
        }
        #[cfg(unix)]
        {
            signal_group(self.child.id(), libc::SIGTERM);
            let deadline = Instant::now() + KILL_AFTER;
            while Instant::now() < deadline && matches!(self.child.try_wait(), Ok(None)) {
                thread::sleep(Duration::from_millis(20));
            }
            signal_group(self.child.id(), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.over();
    }

    fn wait(&mut self) -> Option<i32> {
        let status = self.child.wait().ok();
        self.over();
        status.and_then(|s| s.code())
    }

    fn over(&mut self) {
        self.over = true;
        let pid = self.child.id();
        GROUPS.lock_recovering().retain(|(p, _)| *p != pid);
    }
}

impl Drop for Claude {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Every Claude Code run still going is told to stop, and its MCP config removed: DocBro is
/// quitting, so the runs' threads will not get to drop their `TempConfig`.
pub fn stop_all() {
    let runs = std::mem::take(&mut *GROUPS.lock_recovering());
    stop_runs(&runs, |_pid| {
        #[cfg(unix)]
        signal_group(_pid, libc::SIGTERM);
    });
}

fn stop_runs(runs: &[(u32, PathBuf)], mut signal: impl FnMut(u32)) {
    for (pid, config) in runs {
        signal(*pid);
        let _ = fs::remove_file(config);
    }
}

/// The CLI's output, one line at a time; a line over `MAX_LINE` is skipped.
fn read_lines(out: impl Read, tx: mpsc::Sender<String>) {
    let mut out = BufReader::new(out);
    let mut line = Vec::new();
    loop {
        line.clear();
        match out.by_ref().take(MAX_LINE + 1).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if line.len() as u64 > MAX_LINE && line.last() != Some(&b'\n') {
            if out.skip_until(b'\n').is_err() {
                return;
            }
            continue;
        }
        if tx.send(String::from_utf8_lossy(&line).into_owned()).is_err() {
            return;
        }
    }
}

/// Every secret of a request, to hide from what the user is shown.
fn secrets_of(request: &Request) -> Vec<String> {
    let mut secrets: Vec<String> = request.servers.iter().flat_map(|(_, spec)| spec.secret_values()).collect();
    secrets.extend(request.builtin.as_ref().map(|b| b.token.clone()));
    secrets.retain(|s| s.trim().len() >= 4);
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    secrets.dedup();
    secrets
}

/// Runs `claude` for one message and emits what it streams, never `Done` or `Error`: the
/// `Err` is the error to show, and a run that was stopped is `Ok`. Stop is checked between
/// lines and while waiting for one.
pub(crate) fn run_message(
    setup: &Setup,
    request: &Request,
    session: &SessionArg,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(Event),
) -> (Result<(), String>, Outcome) {
    let secrets = secrets_of(request);
    let mut parser = ClaudeCodeParser { secrets: secrets.clone(), ..ClaudeCodeParser::new(&server_names(request)) };
    let result = run_cli(setup, request, session, cancel, emit, &mut parser, &secrets);
    let outcome = Outcome { session_id: parser.session_id.clone(), conversed: parser.conversed };
    (result.map_err(|e| redact(&e, &secrets)), outcome)
}

fn run_cli(
    setup: &Setup,
    request: &Request,
    session: &SessionArg,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(Event),
    parser: &mut ClaudeCodeParser,
    secrets: &[String],
) -> Result<(), String> {
    let config = mcp_config(&request.servers, request.builtin.as_ref());
    // declared first, so it goes after the process
    let config = TempConfig::write(&setup.temp_dir, &config)
        .map_err(|e| format!("Could not write the MCP settings for Claude Code: {e}"))?;
    let servers = server_names(request);
    let spec = RunSpec {
        model: &request.model,
        mcp_config: &config.0,
        servers: &servers,
        system_prompt: &request.system_prompt,
        session,
    };
    fs::create_dir_all(&setup.cwd).map_err(|e| format!("Could not make a folder for Claude Code: {e}"))?;
    let mut cmd = Command::new(&setup.bin);
    cmd.args(cli_args(&spec))
        .current_dir(&setup.cwd)
        .env_clear()
        .envs(setup.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console window pops up next to DocBro
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        ErrorKind::NotFound => NOT_FOUND.to_string(),
        _ => format!("Could not start Claude Code: {e}"),
    })?;
    GROUPS.lock_recovering().push((child.id(), config.0.clone()));
    let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let mut claude = Claude { child, over: false };
    let (Some(mut stdin), Some(stdout), Some(stderr)) = pipes else {
        return Err("Could not connect to Claude Code.".into());
    };

    // the CLI starts once stdin is closed; a thread, so a long selection cannot block the run
    let text = request.text.clone();
    thread::spawn(move || {
        let _ = stdin.write_all(text.as_bytes());
    });
    let (tx, lines) = mpsc::channel();
    thread::spawn(move || read_lines(stdout, tx));
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    let (done, stderr_done) = mpsc::channel();
    let keep = tail.clone();
    thread::spawn(move || {
        keep_tail(stderr, &keep);
        let _ = done.send(());
    });

    let mut failure = None;
    let mut exited: Option<Instant> = None;
    loop {
        if cancel.load(Ordering::SeqCst) {
            claude.stop();
            return Ok(());
        }
        match lines.recv_timeout(POLL) {
            Ok(line) => {
                for event in parser.feed(&line) {
                    match event {
                        Event::Done => {}
                        Event::Error { message } => failure = Some(message),
                        event => emit(event),
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
            // the CLI is gone, but something it started may hold its output open
            Err(RecvTimeoutError::Timeout) => {
                if exited.is_some() || matches!(claude.child.try_wait(), Ok(Some(_))) {
                    let at = *exited.get_or_insert_with(Instant::now);
                    if at.elapsed() >= LAST_WORDS {
                        break;
                    }
                }
            }
        }
    }
    let code = claude.wait();
    if cancel.load(Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(message) = failure {
        return Err(message);
    }
    if parser.finished {
        return Ok(());
    }
    let _ = stderr_done.recv_timeout(LAST_WORDS);
    let tail = tail.lock_recovering();
    let mut bytes: Vec<u8> = tail.iter().copied().collect();
    // a full buffer may start inside a line, and so inside a secret: that line goes
    if tail.len() >= STDERR_TAIL {
        let start = bytes.iter().position(|&b| b == b'\n').map_or(bytes.len(), |i| i + 1);
        bytes.drain(..start);
    }
    let stderr = redact(&String::from_utf8_lossy(&bytes), secrets);
    Err(exit_error(code, &stderr, parser.started))
}

/// Answers one message of window `label`'s chat with `run_message` and keeps where the next
/// message goes.
pub(crate) fn answer_with(
    assistant: &Assistant,
    label: &str,
    run: &Begun,
    request: &Request,
    setup: &Setup,
    emit: &mut dyn FnMut(Event),
) -> Result<(), String> {
    let arg = run.session.arg();
    let (result, outcome) = run_message(setup, request, &arg, &run.cancel, emit);
    assistant.keep_session(label, run.id, run.session.after(&arg, &outcome));
    result
}

/// The environment `claude` runs with: a few of DocBro's variables and a `PATH` where `node`,
/// `npx` and the like are found even when DocBro was opened from the Finder.
fn child_env(bin: &Path) -> Vec<(String, OsString)> {
    let windows: &[&str] = if cfg!(windows) { INHERITED_ENV_WINDOWS } else { &[] };
    let mut env: Vec<(String, OsString)> =
        INHERITED_ENV.iter().chain(windows).filter_map(|k| Some((k.to_string(), std::env::var_os(k)?))).collect();
    env.push(("PATH".into(), mcp_client::path_for(&bin.to_string_lossy())));
    env
}

/// Answers a message of window `label` with Claude Code: the document tools through a lease on
/// DocBro's MCP endpoint, which ends with the run.
pub(crate) fn converse(app: &AppHandle, label: &str, run: &Begun, ask: &Ask, emit: &mut dyn FnMut(Event)) -> Result<(), String> {
    let state = app.state::<AppState>();
    let bin = run.claude.clone().ok_or(NOT_FOUND)?;
    let cwd = app
        .path()
        .app_data_dir()
        .map(|d| d.join("assistant-workdir"))
        .map_err(|e| format!("Could not make a folder for Claude Code: {e}"))?;
    let lease = match ask.builtin {
        true => {
            let host = Arc::new(TauriHost(app.clone()));
            Some(state.mcp.lock_recovering().lease(host, label).map_err(|e| format!("{NO_DOOR}: {e}."))?)
        }
        false => None,
    };
    // without the facts the prompt just has no document section
    let doc_info = match ask.builtin {
        true => in_window(app, label, "document_info", &json!({})).unwrap_or_default(),
        false => String::new(),
    };
    let servers = pick_servers(&state.servers.configs(), ask.only.as_deref());
    let request = Request {
        model: run.model.clone(),
        servers: servers.into_iter().map(|(id, spec)| (id, with_child_path(spec))).collect(),
        builtin: lease.as_ref().map(|l| BuiltinEndpoint { url: l.url(), token: l.token().into() }),
        // the selection goes with the message, so it stays off the command line
        system_prompt: build_system_prompt(&doc_info, None),
        text: message_text(&run.text, ask.context.as_deref()),
    };
    let setup = Setup { env: child_env(&bin), bin, cwd, temp_dir: std::env::temp_dir() };
    answer_with(&state.assistant, label, run, &request, &setup, emit)
}

// ------------------------------------------------------------- finding claude

/// What the webview may know about the `claude` found.
#[derive(Serialize, Debug, PartialEq, Clone, Default)]
pub struct ClaudeStatus {
    pub found: bool,
    pub path: Option<String>,
    /// from `claude --version`, e.g. "2.1.316"
    pub version: Option<String>,
}

/// Finds `claude` and asks its version once per app run.
pub(crate) struct Local {
    /// None: look in the usual places; Some: this one or none (tests)
    fixed: Option<Option<PathBuf>>,
    versions: Mutex<HashMap<PathBuf, Option<String>>>,
}

impl Local {
    pub(crate) fn search() -> Local {
        Local { fixed: None, versions: Mutex::default() }
    }

    pub(crate) fn fixed(bin: Option<PathBuf>) -> Local {
        Local { fixed: Some(bin), versions: Mutex::default() }
    }

    /// `configured` is `claude_path` from the settings, which wins when it is a file.
    pub(crate) fn find(&self, configured: Option<&str>) -> Option<PathBuf> {
        let configured = configured.map(str::trim).filter(|p| !p.is_empty()).map(PathBuf::from);
        if let Some(path) = configured.filter(|p| p.is_file()) {
            return Some(path);
        }
        match &self.fixed {
            Some(bin) => bin.clone().filter(|b| b.is_file()),
            None => {
                let path = std::env::var_os("PATH").unwrap_or_default();
                find_claude(&path, dirs::home_dir().as_deref(), &|p| p.is_file())
            }
        }
    }

    /// May run `claude --version`: not on the main thread.
    pub(crate) fn status(&self, configured: Option<&str>) -> ClaudeStatus {
        let Some(bin) = self.find(configured) else { return ClaudeStatus::default() };
        let known = self.versions.lock_recovering().get(&bin).cloned();
        let version = known.unwrap_or_else(|| {
            let version = version_of(&bin);
            self.versions.lock_recovering().insert(bin.clone(), version.clone());
            version
        });
        ClaudeStatus { found: true, path: Some(bin.to_string_lossy().into_owned()), version }
    }
}

/// `claude` in `PATH` or where its installers put it. An app opened from the Finder has a
/// minimal `PATH`, so the usual folders are tried too.
fn find_claude(path: &OsStr, home: Option<&Path>, is_file: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    // a relative entry would mean the working folder
    let mut dirs: Vec<PathBuf> = std::env::split_paths(path).filter(|d| d.is_absolute()).collect();
    dirs.extend(home.map(|h| h.join(".local/bin")));
    dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    dirs.extend(home.map(|h| h.join(".claude/local")));
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| is_file(p))
}

/// The first word of `claude --version` ("2.1.316 (Claude Code)"); None when it does not answer
/// within `VERSION_TIMEOUT`.
fn version_of(bin: &Path) -> Option<String> {
    let mut child = Command::new(bin)
        .arg("--version")
        .env_clear()
        .envs(child_env(bin))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + VERSION_TIMEOUT;
    while matches!(child.try_wait(), Ok(None)) {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let mut out = String::new();
    child.stdout.take()?.take(4096).read_to_string(&mut out).ok()?;
    out.split_whitespace().next().filter(|w| w.chars().any(|c| c.is_ascii_digit())).map(str::to_string)
}

// ------------------------------------------------------------ session list

/// A Claude Code session on this Mac, as the "Continue a Claude Code session" list shows it.
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct SessionInfo {
    pub id: String,
    /// its `ai-title`, or else its first message, cut to 80 characters
    pub title: String,
    /// the name of the folder it ran in
    pub project: String,
    /// when the file last changed, ISO 8601 UTC
    pub modified: String,
}

/// What the first lines of a session file say about it.
#[derive(Default)]
struct Head {
    title: Option<String>,
    prompt: Option<String>,
    /// a `-p` run's prompt, from its `queue-operation` line
    queued: Option<String>,
    cwd: Option<String>,
    /// lines read since the prompt
    after: usize,
}

impl Head {
    /// Takes one line; true once there is nothing more to learn.
    fn take(&mut self, line: &str) -> bool {
        if self.prompt.is_some() {
            self.after += 1;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
            if self.cwd.is_none() {
                self.cwd = v["cwd"].as_str().filter(|c| !c.is_empty()).map(str::to_string);
            }
            let text = |v: &Value| v.as_str().filter(|t| !t.trim().is_empty()).map(str::to_string);
            match v["type"].as_str() {
                Some("ai-title") => self.title = text(&v["aiTitle"]).or(self.title.take()),
                Some("user") if self.prompt.is_none() => self.prompt = first_prompt(&v),
                Some("queue-operation") if self.queued.is_none() && v["operation"] == "enqueue" => {
                    self.queued = text(&v["content"]);
                }
                _ => {}
            }
        }
        (self.title.is_some() && self.prompt.is_some()) || self.after > TITLE_LINES
    }

    fn prompt(&self) -> Option<&String> {
        self.prompt.as_ref().or(self.queued.as_ref())
    }

    fn label(&self) -> Option<String> {
        let text = self.title.as_ref().or(self.prompt())?;
        let folded = text.split_whitespace().collect::<Vec<_>>().join(" ");
        (!folded.is_empty()).then(|| cut(&folded, TITLE_CHARS))
    }
}

/// What the user typed, from a `user` line: not a tool result, a side chain, a meta line or a
/// wrapper such as `<command-name>`.
fn first_prompt(line: &Value) -> Option<String> {
    if line["isSidechain"] == true || line["isMeta"] == true {
        return None;
    }
    let content = &line["message"]["content"];
    let text = match content.as_array() {
        Some(blocks) if blocks.iter().any(|b| b["type"] == "tool_result") => return None,
        Some(blocks) => {
            let texts = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str());
            texts.collect::<Vec<_>>().join("\n")
        }
        None => content.as_str()?.to_string(),
    };
    let text = text.trim();
    (!text.is_empty() && !WRAPPERS.iter().any(|w| text.starts_with(w))).then(|| text.to_string())
}

/// The label of a session from the start of its file (`list_sessions` reads files the same way).
#[cfg(test)]
pub(crate) fn session_title(head: &str) -> Option<String> {
    let mut scan = Head::default();
    for line in head.lines() {
        if scan.take(line) {
            break;
        }
    }
    scan.label()
}

/// Reads a session file line by line, until its label is known or `MAX_HEAD` bytes are read.
fn read_head(path: &Path) -> Head {
    let mut head = Head::default();
    let Ok(file) = fs::File::open(path) else { return head };
    let mut reader = BufReader::new(file.take(MAX_HEAD));
    let mut line = Vec::new();
    while matches!(reader.read_until(b'\n', &mut line), Ok(1..)) {
        if head.take(&String::from_utf8_lossy(&line)) {
            break;
        }
        line.clear();
    }
    head
}

/// The newest sessions in `projects` (`~/.claude/projects`): `<folder>/<session id>.jsonl`, only
/// at the top of each folder. Read only. Copies with the same label and first message (the
/// forks "Continue" makes) are listed once, the newest.
pub(crate) fn list_sessions(projects: &Path) -> Vec<SessionInfo> {
    let mut files: Vec<(SystemTime, PathBuf, String)> = Vec::new();
    for project in fs::read_dir(projects).into_iter().flatten().flatten() {
        if !project.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let folder = project.file_name().to_string_lossy().into_owned();
        for entry in fs::read_dir(project.path()).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "jsonl") || !entry.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH);
            files.push((modified, path, folder.clone()));
        }
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    let (mut list, mut seen) = (Vec::new(), HashSet::new());
    for (modified, path, folder) in files.into_iter().take(MAX_EXAMINED) {
        if list.len() == MAX_SESSIONS {
            break;
        }
        let Some(id) = path.file_stem().and_then(OsStr::to_str).filter(|id| check_session_id(id).is_ok()) else {
            continue;
        };
        let head = read_head(&path);
        let Some(title) = head.label() else { continue };
        if !seen.insert((title.clone(), head.prompt().cloned())) {
            continue;
        }
        // the folder's name is the path with / and . made -, which cannot be undone
        let cwd = head.cwd.as_deref().and_then(|c| Path::new(c).file_name());
        let project = cwd.map_or(folder, |n| n.to_string_lossy().into_owned());
        list.push(SessionInfo { id: id.into(), title, project, modified: iso_utc(modified) });
    }
    list
}

/// `YYYY-MM-DDTHH:MM:SSZ`.
fn iso_utc(time: SystemTime) -> String {
    let secs = time.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // days to a civil date (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

fn claude_home() -> Option<PathBuf> {
    let configured = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()).map(PathBuf::from);
    configured.or_else(|| dirs::home_dir().map(|h| h.join(".claude")))
}

// ------------------------------------------------------------------ teleport

/// What "From Claude Code on the web" tells the user to do.
#[derive(Serialize, Debug, PartialEq)]
pub struct TeleportOutcome {
    pub needs_terminal: bool,
    pub command: String,
}

/// The session id in a claude.ai/code link (its last path segment), or the id pasted.
pub(crate) fn teleport_id(input: &str) -> CmdResult<String> {
    let path = input.trim().split(['?', '#']).next().unwrap_or_default();
    let id = path.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
    check_session_id(id).map_err(|_| BAD_LINK.to_string())?;
    Ok(id.to_string())
}

/// DocBro never runs `claude --teleport` itself: in print mode it fails without a word on a bad
/// id, and it checks out the session's git branch in the folder it runs in. The user runs it
/// once in Terminal, in the repository the web session worked on; the session then shows in the
/// list of this Mac's sessions.
pub(crate) fn teleport(input: &str) -> CmdResult<TeleportOutcome> {
    let id = teleport_id(input)?;
    Ok(TeleportOutcome { needs_terminal: true, command: format!("claude --teleport {id}") })
}

// ----------------------------------------------------------------- commands

/// Recent Claude Code sessions on this Mac, newest first.
#[tauri::command]
pub async fn claude_sessions() -> CmdResult<Vec<SessionInfo>> {
    let projects = claude_home().map(|h| h.join("projects"));
    tauri::async_runtime::spawn_blocking(move || projects.map(|p| list_sessions(&p)).unwrap_or_default())
        .await
        .map_err(|e| format!("Internal error: {e}"))
}

/// This window's next message goes on in a copy of session `session_id`.
#[tauri::command]
pub fn assistant_continue(session_id: String, window: Window, state: State<AppState>) -> CmdResult<()> {
    state.assistant.continue_session(window.label(), &session_id)
}

#[tauri::command]
pub fn assistant_teleport(input: String) -> CmdResult<TeleportOutcome> {
    teleport(&input)
}

#[cfg(test)]
mod tests;
