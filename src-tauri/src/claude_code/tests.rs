use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs,
    panic::{self, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime},
};

use serde_json::{json, Value};

use super::*;
use crate::assistant::{settle, Engine, LIMIT};

// -- recorded lines (claude 2.1.316, Task 19 spike) ------------------------------------

const INIT: &str = r#"{"type":"system","subtype":"init","cwd":"/w","session_id":"@SID@","tools":["mcp__docbro__read_document"],"mcp_servers":[{"name":"docbro","status":"connected","source":"dynamic"}],"model":"claude-haiku-5-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.316"}"#;
const STATUS: &str = r#"{"type":"system","subtype":"status","status":"requesting","session_id":"@SID@"}"#;
const RATE_OK: &str = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","resetsAt":1793000000},"session_id":"@SID@"}"#;
const TOOL_START: &str = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01Qx","name":"mcp__docbro__read_document","input":{}}}}"#;
const TOOL_ARGS: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"from\": 1"}}}"#;
const TOOL_USE: &str = r#"{"type":"assistant","message":{"model":"claude-haiku-5-5","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Qx","name":"mcp__docbro__read_document","input":{"from":1},"caller":{"type":"direct"}}],"stop_reason":null},"session_id":"@SID@"}"#;
const TOOL_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01Qx","type":"tool_result","content":[{"type":"text","text":"[1] # Report"}]}]},"tool_use_result":[{"type":"text","text":"[1] # Report"}],"tool_result_meta":[{"id":"toolu_01Qx","permission_decision":{"decision":"accept","source":"config","reason_type":"rule"}}]}"#;
const TEXT_1: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}"#;
const TEXT_2: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo."}}}"#;
const TEXT_WHOLE: &str = r#"{"type":"assistant","message":{"model":"claude-haiku-5-5","role":"assistant","content":[{"type":"text","text":"Hello."}],"stop_reason":null},"session_id":"@SID@"}"#;
const DONE: &str = r#"{"type":"result","subtype":"success","is_error":false,"result":"Hello.","stop_reason":"end_turn","session_id":"@SID@","num_turns":2,"total_cost_usd":0.00097817,"permission_denials":[],"terminal_reason":"completed"}"#;
const SIGNED_OUT_LINE: &str = r#"{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed","is_api_error_message":true,"session_id":"@SID@"}"#;
const SIGNED_OUT_RESULT: &str = r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","terminal_reason":"api_error","api_error_status":null,"stop_reason":"stop_sequence","num_turns":1,"total_cost_usd":0,"permission_denials":[],"session_id":"@SID@"}"#;
const MAX_TURNS: &str = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":2,"stop_reason":"tool_use","terminal_reason":"max_turns","errors":["Reached maximum number of turns (12)"],"permission_denials":[]}"#;
const NO_SESSION: &str = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"0000","errors":["No conversation found with session ID: 0000"]}"#;

/// The lines of a run that reads the document and answers "Hello.".
fn answered() -> Vec<&'static str> {
    vec![INIT, STATUS, RATE_OK, TOOL_START, TOOL_ARGS, TOOL_USE, TOOL_RESULT, TEXT_1, TEXT_2, TEXT_WHOLE, DONE]
}

// -- a fake `claude` ---------------------------------------------------------------------

/// A shell script standing in for `claude`: it records its arguments, its stdin, the MCP config
/// it was given (and that file's mode), then prints `replay` with `@SID@` replaced by the
/// session id it was given (a fork gets `forked-session-0001`) and runs `tail`.
struct Fake {
    dir: PathBuf,
}

impl Fake {
    fn new(name: &str, replay: &[&str], tail: &str) -> Fake {
        let dir = std::env::temp_dir().join(format!("docbro-claude-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("work")).unwrap();
        fs::create_dir_all(dir.join("tmp")).unwrap();
        let fake = Fake { dir };
        fake.replay(replay);
        let script = format!(
            r#"#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
if [ "$1" = "--version" ]; then echo "2.1.316 (Claude Code)"; exit 0; fi
: > "$here/argv"
for a in "$@"; do printf '%s\0' "$a" >> "$here/argv"; done
cat > "$here/stdin"
prev=""; sid=""; cfg=""
for a in "$@"; do
  case "$prev" in --session-id|--resume) sid="$a" ;; --mcp-config) cfg="$a" ;; esac
  prev="$a"
done
for a in "$@"; do if [ "$a" = "--fork-session" ]; then sid="forked-session-0001"; fi; done
if [ -n "$cfg" ]; then cp "$cfg" "$here/config.json"; ls -l "$cfg" | cut -c1-10 > "$here/config.mode"; fi
pwd > "$here/cwd"
echo $$ > "$here/pid"
sed "s/@SID@/$sid/g" "$here/replay"
{tail}
"#
        );
        let bin = fake.bin();
        fs::write(&bin, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fake
    }

    fn replay(&self, lines: &[&str]) {
        fs::write(self.dir.join("replay"), lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
    }

    fn bin(&self) -> PathBuf {
        self.dir.join("claude")
    }

    fn setup(&self) -> Setup {
        Setup {
            bin: self.bin(),
            cwd: self.dir.join("work"),
            temp_dir: self.dir.join("tmp"),
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
        }
    }

    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.dir.join(name)).unwrap_or_default()
    }

    fn argv(&self) -> Vec<String> {
        let raw = self.read("argv");
        let mut args: Vec<String> = raw.split('\0').map(str::to_string).collect();
        args.pop();
        args
    }

    fn config(&self) -> Value {
        serde_json::from_str(&self.read("config.json")).unwrap()
    }

    /// What is left in the folder the MCP config goes to.
    fn leftovers(&self) -> Vec<PathBuf> {
        fs::read_dir(self.dir.join("tmp")).unwrap().map(|e| e.unwrap().path()).collect()
    }

    fn pid(&self, name: &str) -> i32 {
        self.read(name).trim().parse().unwrap()
    }
}

fn alive(pid: i32) -> bool {
    // signal 0 only checks that the process exists
    unsafe { libc::kill(pid, 0) == 0 }
}

fn request(servers: Vec<(String, ServerSpec)>, builtin: Option<BuiltinEndpoint>) -> Request {
    Request {
        model: "sonnet".into(),
        servers,
        builtin,
        system_prompt: "You are the assistant in DocBro.".into(),
        text: "Summarize it".into(),
    }
}

fn builtin() -> Option<BuiltinEndpoint> {
    Some(BuiltinEndpoint { url: "http://127.0.0.1:5000/mcp".into(), token: "ASSISTANT-TOKEN-0123456789".into() })
}

fn http(url: &str, headers: &[(&str, &str)]) -> ServerSpec {
    let headers = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    ServerSpec::Http { url: url.into(), headers }
}

fn stdio(command: &str, args: &[&str], env: &[(&str, &str)]) -> ServerSpec {
    ServerSpec::Stdio {
        command: command.into(),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>(),
    }
}

fn config(id: &str, enabled: bool, spec: ServerSpec) -> ServerConfig {
    ServerConfig { id: id.into(), name: id.into(), enabled, spec }
}

fn user_servers() -> Vec<ServerConfig> {
    vec![
        config("notes", true, http("https://notes.example/mcp", &[("Authorization", "Bearer HEADER-SECRET-VALUE")])),
        config("files", true, stdio("/usr/local/bin/files-mcp", &["--root", "/tmp"], &[("API_KEY", "ENV-SECRET-VALUE")])),
        config("off", false, http("https://off.example/mcp", &[])),
    ]
}

/// Runs one message against the fake; returns the result and what was emitted.
fn run(fake: &Fake, request: &Request, session: &SessionArg) -> (Result<(), String>, Outcome, Vec<Event>) {
    let mut events = Vec::new();
    let (result, outcome) = run_message(&fake.setup(), request, session, &AtomicBool::new(false), &mut |e| events.push(e));
    (result, outcome, events)
}

fn after(argv: &[String], flag: &str) -> Vec<String> {
    let at = argv.iter().position(|a| a == flag).unwrap_or_else(|| panic!("no {flag} in {argv:?}"));
    argv[at + 1..].iter().take_while(|a| !a.starts_with("--")).cloned().collect()
}

fn is_uuid(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.iter().map(|p| p.len()).collect::<Vec<_>>() == [8, 4, 4, 4, 12]
        && id.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
        && parts[2].starts_with('4')
}

fn tool_start(id: &str, server: &str, name: &str, args: &str) -> Event {
    Event::ToolStart { id: id.into(), server: server.into(), name: name.into(), args: args.into() }
}

fn tool_end(id: &str, ok: bool, text: &str) -> Event {
    Event::ToolEnd { id: id.into(), ok, text: text.into() }
}

fn text(delta: &str) -> Event {
    Event::Text { delta: delta.into() }
}

fn feed_all(parser: &mut ClaudeCodeParser, lines: &[&str]) -> Vec<Event> {
    lines.iter().flat_map(|l| parser.feed(&l.replace("@SID@", "s-1"))).collect()
}

// -- the command line and the MCP config -----------------------------------------------

#[test]
fn args_never_carry_secrets_or_the_prompt() {
    let path = Path::new("/private/tmp/docbro-mcp-1.json");
    let servers = vec!["docbro".to_string(), "notes".to_string()];
    let start = SessionArg::Start("6f1c2c4e-8a2b-4c3d-9e4f-0123456789ab".into());
    let spec = RunSpec { model: "sonnet", mcp_config: path, servers: &servers, system_prompt: "Be brief.", session: &start };
    let expected = [
        "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--setting-sources", "", "--disable-slash-commands", "--tools", "",
        "--strict-mcp-config", "--mcp-config", "/private/tmp/docbro-mcp-1.json",
        "--allowedTools", "mcp__docbro", "mcp__notes",
        "--append-system-prompt", "Be brief.",
        "--model", "sonnet",
        "--max-turns", "12",
        "--session-id", "6f1c2c4e-8a2b-4c3d-9e4f-0123456789ab",
    ];
    assert_eq!(cli_args(&spec), expected);
    let resume = SessionArg::Resume("abc".into());
    let args = cli_args(&RunSpec { session: &resume, ..spec });
    assert_eq!(args[args.len() - 2..], ["--resume", "abc"]);
    let fork = SessionArg::Fork("abc".into());
    let args = cli_args(&RunSpec { session: &fork, servers: &[], ..spec });
    assert_eq!(args[args.len() - 3..], ["--resume", "abc", "--fork-session"]);
    // no server: no --allowedTools, which would otherwise swallow the next argument
    assert!(!args.contains(&"--allowedTools".to_string()), "{args:?}");

    // a real run: the prompt and the selection go on stdin, the secrets into the private file
    let fake = Fake::new("argv", &answered(), "");
    let mut req = request(super::pick_servers(&user_servers(), None), builtin());
    req.text = message_text("My private question\n", Some("the secret plan"));
    let (result, _, _) = run(&fake, &req, &SessionArg::Start("6f1c2c4e-8a2b-4c3d-9e4f-0123456789ab".into()));
    result.unwrap();
    let argv = fake.argv();
    let joined = argv.join(" ");
    for secret in ["HEADER-SECRET-VALUE", "ENV-SECRET-VALUE", "ASSISTANT-TOKEN", "My private question", "secret plan"] {
        assert!(!joined.contains(secret), "{secret} is on the command line: {joined}");
    }
    assert_eq!(after(&argv, "--allowedTools"), ["mcp__docbro", "mcp__notes", "mcp__files"]);
    assert_eq!(after(&argv, "--append-system-prompt"), ["You are the assistant in DocBro."]);
    // the trailing newline is gone, the selection came along
    let stdin = fake.read("stdin");
    assert!(stdin.starts_with("My private question\n\nThe user selected: \"the secret plan\""), "{stdin:?}");
    assert!(!stdin.ends_with('\n'), "{stdin:?}");
    // it ran in DocBro's own folder
    assert!(fake.read("cwd").trim().ends_with("work"), "{}", fake.read("cwd"));
    assert_eq!(message_text("Hi\n\n", None), "Hi");
}

#[test]
fn mcp_config_has_builtin_and_enabled_servers_only() {
    let picked = pick_servers(&user_servers(), None);
    assert_eq!(picked.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["notes", "files"]);
    let config = mcp_config(&picked, builtin().as_ref());
    assert_eq!(
        config,
        json!({ "mcpServers": {
            "docbro": { "type": "http", "url": "http://127.0.0.1:5000/mcp", "headers": { "Authorization": "Bearer ASSISTANT-TOKEN-0123456789" } },
            "notes": { "type": "http", "url": "https://notes.example/mcp", "headers": { "Authorization": "Bearer HEADER-SECRET-VALUE" } },
            "files": { "type": "stdio", "command": "/usr/local/bin/files-mcp", "args": ["--root", "/tmp"], "env": { "API_KEY": "ENV-SECRET-VALUE" } },
        } })
    );
    // the file the CLI got is that config, and only those servers are pre-approved
    let fake = Fake::new("config", &answered(), "");
    run(&fake, &request(picked, builtin()), &SessionArg::Resume("s-1".into())).0.unwrap();
    assert_eq!(fake.config(), config);
    assert_eq!(after(&fake.argv(), "--allowedTools"), ["mcp__docbro", "mcp__notes", "mcp__files"]);
}

#[test]
fn mention_narrows_user_servers_and_keeps_builtin() {
    let configs = user_servers();
    let only = |id: &str| pick_servers(&configs, Some(id)).into_iter().map(|(id, _)| id).collect::<Vec<_>>();
    assert_eq!(only("files"), ["files"]);
    // a server that is off is never started, even when mentioned
    assert!(only("off").is_empty());
    // @docbro: the document's own tools only
    assert!(only("docbro").is_empty());

    let fake = Fake::new("mention", &answered(), "");
    run(&fake, &request(pick_servers(&configs, Some("files")), builtin()), &SessionArg::Resume("s-1".into())).0.unwrap();
    let servers = fake.config()["mcpServers"].as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(servers, ["docbro", "files"]);
    assert_eq!(after(&fake.argv(), "--allowedTools"), ["mcp__docbro", "mcp__files"]);
}

#[test]
fn exclude_builtin_drops_docbro() {
    let configs = user_servers();
    let fake = Fake::new("exclude", &answered(), "");
    run(&fake, &request(pick_servers(&configs, None), None), &SessionArg::Resume("s-1".into())).0.unwrap();
    let servers = fake.config()["mcpServers"].as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(servers, ["files", "notes"]);
    assert_eq!(after(&fake.argv(), "--allowedTools"), ["mcp__notes", "mcp__files"]);

    // nothing at all: an empty config and no --allowedTools
    run(&fake, &request(Vec::new(), None), &SessionArg::Resume("s-1".into())).0.unwrap();
    assert_eq!(fake.config(), json!({ "mcpServers": {} }));
    assert!(!fake.argv().contains(&"--allowedTools".to_string()));
}

// -- the stream ------------------------------------------------------------------------------

#[test]
fn parser_streams_text_and_pairs_tool_cards() {
    let servers = ["docbro", "spike-b", "a", "a_"].map(String::from);
    let mut parser = ClaudeCodeParser::new(&servers);
    let events = feed_all(&mut parser, &answered());
    assert_eq!(
        events,
        [
            tool_start("toolu_01Qx", "docbro", "read_document", r#"{"from":1}"#),
            tool_end("toolu_01Qx", true, "[1] # Report"),
            text("Hel"),
            text("lo."),
            Event::Done,
        ]
    );
    assert_eq!(parser.session_id.as_deref(), Some("s-1"));
    assert!(parser.started && parser.conversed && parser.finished);

    // a failed tool (its content a plain string), a hyphenated server, a server id ending in _,
    // long arguments and a long answer
    let mut parser = ClaudeCodeParser::new(&servers);
    let long = "x".repeat(500);
    let lines = [
        json!({ "type": "assistant", "message": { "model": "m", "content": [
            { "type": "tool_use", "id": "t1", "name": "mcp__spike-b__echo", "input": { "text": long } },
        ] } }),
        json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t1", "content": "Boom", "is_error": true },
        ] } }),
        json!({ "type": "assistant", "message": { "model": "m", "content": [
            { "type": "tool_use", "id": "t2", "name": "mcp__a___get", "input": {} },
        ] } }),
        json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t2", "content": [{ "type": "text", "text": long }, { "type": "image" }] },
        ] } }),
        // the same call repeated never makes a second card
        json!({ "type": "assistant", "message": { "model": "m", "content": [
            { "type": "tool_use", "id": "t2", "name": "mcp__a___get", "input": {} },
        ] } }),
        // a name this request never offered is shown as it is, not split by guessing
        json!({ "type": "assistant", "message": { "model": "m", "content": [
            { "type": "tool_use", "id": "t3", "name": "mcp__zz__x", "input": {} },
        ] } }),
    ];
    let events: Vec<Event> = lines.iter().flat_map(|l| parser.feed(&l.to_string())).collect();
    let args = format!(r#"{{"text":"{}"#, "x".repeat(200));
    assert_eq!(
        events,
        [
            tool_start("t1", "spike-b", "echo", &format!("{}…", &args[..200])),
            tool_end("t1", false, "Boom"),
            tool_start("t2", "a_", "get", "{}"),
            tool_end("t2", true, &format!("{}…", "x".repeat(400))),
            tool_start("t3", "", "mcp__zz__x", "{}"),
        ]
    );

    // a call Claude Code refused: a failed card, from the permission_denied line or the result
    let mut parser = ClaudeCodeParser::new(&servers);
    let denied = [
        r#"{"type":"system","subtype":"permission_denied","tool_name":"mcp__docbro__undo","tool_use_id":"toolu_011s","message":"Claude requested permissions to use mcp__docbro__undo, but you haven't granted it yet."}"#,
        r#"{"type":"result","subtype":"success","is_error":false,"result":"Blocked.","permission_denials":[{"tool_name":"mcp__docbro__undo","tool_use_id":"toolu_011s","tool_input":{"x":1}}]}"#,
    ];
    let events = feed_all(&mut parser, &denied);
    assert_eq!(events.len(), 3, "{events:?}");
    assert_eq!(events[0], tool_start("toolu_011s", "docbro", "undo", r#"{"x":1}"#));
    assert!(matches!(&events[1], Event::ToolEnd { id, ok: false, .. } if id == "toolu_011s"), "{events:?}");
    assert_eq!(events[2], Event::Done);
}

#[test]
fn parser_ignores_unknown_and_non_json_lines() {
    let mut parser = ClaudeCodeParser::new(&["docbro".to_string()]);
    let noise = [
        "",
        "not json at all",
        "[1, 2]",
        "42",
        r#"{"no":"type"}"#,
        r#"{"type":"future_thing","x":1}"#,
        r#"{"type":"system","subtype":"hook_started"}"#,
        r#"{"type":"system","subtype":"hook_response"}"#,
        r#"{"type":"system","subtype":"ui_invalidate"}"#,
        r#"{"type":"system","subtype":"thinking_tokens","n":3}"#,
        STATUS,
        RATE_OK,
        r#"{"type":"assistant"}"#,
        r#"{"type":"assistant","message":{"content":"text, not blocks"}}"#,
        r#"{"type":"user","message":{"content":"a prompt"}}"#,
        r#"{"type":"user","message":{"content":[{"type":"tool_result"}]}}"#,
        r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}"#,
        r#"{"type":"stream_event"}"#,
        TEXT_WHOLE,
    ];
    let events = feed_all(&mut parser, &noise);
    assert_eq!(events, []);
    assert!(!parser.finished && !parser.started);
}

#[test]
fn result_error_becomes_error_event() {
    let feed = |lines: &[&str]| feed_all(&mut ClaudeCodeParser::new(&[]), lines);
    assert_eq!(feed(&[MAX_TURNS]), [Event::Error { message: LIMIT.into() }]);
    let unknown = feed(&[NO_SESSION]);
    assert!(matches!(&unknown[..], [Event::Error { message }] if message.contains("No conversation found with session ID: 0000")), "{unknown:?}");
    let failed = feed(&[r#"{"type":"result","subtype":"success","is_error":true,"result":"API Error: 500 Internal server error"}"#]);
    assert!(matches!(&failed[..], [Event::Error { message }] if message.contains("API Error: 500")), "{failed:?}");
    let bare = feed(&[r#"{"type":"result","is_error":true}"#]);
    assert!(matches!(&bare[..], [Event::Error { message }] if !message.is_empty()), "{bare:?}");
    assert_eq!(feed(&[DONE]), [Event::Done]);

    // through a run: the error is the result, the exit code does not matter
    let fake = Fake::new("result-error", &[INIT, MAX_TURNS], "exit 1");
    let (result, _, events) = run(&fake, &request(Vec::new(), None), &SessionArg::Resume("s-1".into()));
    assert_eq!(result, Err(LIMIT.into()));
    assert!(!events.iter().any(|e| matches!(e, Event::Error { .. } | Event::Done)), "{events:?}");
}

// -- sessions --------------------------------------------------------------------------------

fn cc_assistant(name: &str, fake: &Fake) -> Assistant {
    let dir = std::env::temp_dir().join(format!("docbro-claude-test-{}-{name}-settings", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let a = Assistant::at(Ok(dir.join("assistant.json"))).with_claude(Some(fake.bin()));
    a.save(None, "sonnet".into(), Some(Engine::ClaudeCode)).unwrap();
    a
}

/// Sends `text` in window `label` the way `assistant_send` does, without a window.
fn send(a: &Assistant, fake: &Fake, label: &str, text: &str) -> (Vec<Event>, Vec<String>) {
    let run = a.begin(label, text).unwrap();
    assert_eq!(run.engine, Engine::ClaudeCode);
    let sent = RefCell::new(Vec::new());
    let req = Request { text: run.text.clone(), ..request(Vec::new(), None) };
    settle(a, label, run, &|e| sent.borrow_mut().push(e), |run, _, emit| {
        answer_with(a, label, run, &req, &fake.setup(), emit)
    });
    (sent.into_inner(), fake.argv())
}

#[test]
fn first_message_sets_session_id_then_resumes() {
    let fake = Fake::new("session", &answered(), "");
    let a = cc_assistant("session", &fake);
    let (events, argv) = send(&a, &fake, "main", "Hi");
    assert_eq!(events.last(), Some(&Event::Done));
    let first = after(&argv, "--session-id");
    assert!(first.len() == 1 && is_uuid(&first[0]), "{argv:?}");
    assert!(!argv.contains(&"--resume".to_string()));

    let (_, argv) = send(&a, &fake, "main", "And then?");
    assert_eq!(after(&argv, "--resume"), first);
    assert!(!argv.contains(&"--session-id".to_string()) && !argv.contains(&"--fork-session".to_string()));
    // each window has a conversation of its own, and New starts over
    let (_, argv) = send(&a, &fake, "doc-1", "Hi");
    assert_ne!(after(&argv, "--session-id"), first);
    a.reset("main");
    let (_, argv) = send(&a, &fake, "main", "Hi");
    let fresh = after(&argv, "--session-id");
    assert_ne!(fresh, first);

    // a message that never reached the model (not signed in) starts a new session next time,
    // so a session id is never used twice
    let fake = Fake::new("session-signed-out", &[INIT, STATUS, SIGNED_OUT_LINE, SIGNED_OUT_RESULT], "exit 1");
    let a = cc_assistant("session-signed-out", &fake);
    let (events, argv) = send(&a, &fake, "main", "Hi");
    assert_eq!(events, [Event::Error { message: SIGNED_OUT.into() }]);
    let tried = after(&argv, "--session-id");
    fake.replay(&answered());
    let (_, argv) = send(&a, &fake, "main", "Hi");
    let next = after(&argv, "--session-id");
    assert!(is_uuid(&next[0]) && next != tried, "{tried:?} {next:?}");
}

#[test]
fn continue_forks_the_chosen_session() {
    let fake = Fake::new("fork", &answered(), "");
    let a = cc_assistant("fork", &fake);
    let picked = "5d769f48-8925-400b-85a7-6271f82177b2";
    a.continue_session("main", picked).unwrap();
    let (events, argv) = send(&a, &fake, "main", "Go on");
    assert_eq!(events.last(), Some(&Event::Done));
    assert_eq!(after(&argv, "--resume"), [picked]);
    assert!(argv.contains(&"--fork-session".to_string()), "{argv:?}");
    // later messages go on in the copy, never in the session picked
    let (_, argv) = send(&a, &fake, "main", "More");
    assert_eq!(after(&argv, "--resume"), ["forked-session-0001"]);
    assert!(!argv.contains(&"--fork-session".to_string()));

    // an id reaches the command line: only plain ids are taken
    for bad in ["", "-p", "--dangerously-skip-permissions", "a b", "../x", "id;rm", &"a".repeat(129)] {
        assert!(a.continue_session("main", bad).is_err(), "{bad:?}");
    }
    // not while answering
    let run = a.begin("main", "Hi").unwrap();
    assert!(a.continue_session("main", picked).is_err());
    assert!(a.finish("main", run.id, Vec::new()));
    assert!(a.continue_session("main", picked).is_ok());
}

#[test]
fn stop_kills_the_process_and_emits_done() {
    // the script ignores SIGTERM (so the SIGKILL that follows 2 s later is needed) and leaves a
    // child behind in the background, as an MCP server would be
    let tail = format!(
        r#"trap '' TERM
sleep 60 & echo $! > "$here/bgpid"
echo '{TEXT_1}'
sleep 60"#
    );
    let fake = Fake::new("stop", &[INIT], &tail);
    let a = cc_assistant("stop", &fake);
    let run = a.begin("main", "Hi").unwrap();
    let sent = RefCell::new(Vec::new());
    let started = Instant::now();
    let req = request(Vec::new(), None);
    settle(&a, "main", run, &|e| sent.borrow_mut().push(e), |run, _, emit| {
        answer_with(&a, "main", run, &req, &fake.setup(), &mut |e| {
            // the user presses Stop once the first words are in
            a.cancel("main");
            emit(e);
        })
    });
    let took = started.elapsed();
    assert_eq!(sent.into_inner(), [text("Hel"), Event::Done]);
    assert!(took >= Duration::from_millis(1500) && took < Duration::from_secs(10), "{took:?}");
    assert!(!alive(fake.pid("pid")), "claude is still running");
    assert!(!alive(fake.pid("bgpid")), "its child is still running");
    // the chat is free again
    assert!(a.begin("main", "Next").is_ok());
}

#[test]
fn temp_config_is_private_and_removed_on_every_exit() {
    let req = request(pick_servers(&user_servers(), None), builtin());
    let session = SessionArg::Resume("s-1".into());

    // done
    let fake = Fake::new("temp", &answered(), "");
    run(&fake, &req, &session).0.unwrap();
    assert_eq!(fake.read("config.mode").trim(), "-rw-------");
    assert!(fake.config().to_string().contains("HEADER-SECRET-VALUE"));
    assert_eq!(fake.leftovers(), Vec::<PathBuf>::new());

    // failed
    let fake_failing = Fake::new("temp-fail", &[], "echo 'Error: boom' >&2; exit 3");
    assert!(run(&fake_failing, &req, &session).0.is_err());
    assert_eq!(fake_failing.read("config.mode").trim(), "-rw-------");
    assert_eq!(fake_failing.leftovers(), Vec::<PathBuf>::new());

    // stopped
    let fake_slow = Fake::new("temp-stop", &[INIT, TEXT_1], "sleep 60");
    let cancel = AtomicBool::new(false);
    let (result, _) = run_message(&fake_slow.setup(), &req, &session, &cancel, &mut |_| cancel.store(true, Ordering::SeqCst));
    assert_eq!(result, Ok(()));
    assert_eq!(fake_slow.leftovers(), Vec::<PathBuf>::new());

    // could not start
    let mut setup = fake.setup();
    setup.bin = fake.dir.join("missing-claude");
    let (result, _) = run_message(&setup, &req, &session, &AtomicBool::new(false), &mut |_| {});
    assert_eq!(result, Err(NOT_FOUND.into()));
    assert_eq!(fake.leftovers(), Vec::<PathBuf>::new());

    // a panic while the answer streams in
    let fake_panic = Fake::new("temp-panic", &[INIT, TEXT_1], "sleep 60");
    let setup = fake_panic.setup();
    let started = Instant::now();
    let caught = panic::catch_unwind(AssertUnwindSafe(|| {
        run_message(&setup, &req, &session, &AtomicBool::new(false), &mut |_| panic!("a bug while showing the answer"))
    }));
    assert!(caught.is_err());
    assert_eq!(fake_panic.leftovers(), Vec::<PathBuf>::new());
    assert!(!alive(fake_panic.pid("pid")), "claude outlived the panic");
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn not_found_signed_out_and_usage_limit_messages() {
    // no binary at all: refused before anything starts
    let fake = Fake::new("messages", &[], "");
    let dir = std::env::temp_dir().join(format!("docbro-claude-test-{}-messages-settings", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let missing = Assistant::at(Ok(dir.join("assistant.json"))).with_claude(None);
    missing.save(None, "sonnet".into(), Some(Engine::ClaudeCode)).unwrap();
    assert_eq!(missing.begin("main", "Hi").err(), Some(NOT_FOUND.into()));

    let req = request(pick_servers(&user_servers(), None), builtin());
    let session = SessionArg::Resume("s-1".into());
    let error = |fake: &Fake| run(fake, &req, &session).0.unwrap_err();

    fake.replay(&[INIT, STATUS, SIGNED_OUT_LINE, SIGNED_OUT_RESULT]);
    assert_eq!(error(&fake), SIGNED_OUT);
    let plain = Fake::new("messages-plain", &[], "echo 'Not logged in · Please run /login' >&2; exit 1");
    assert_eq!(error(&plain), SIGNED_OUT);

    // a usage limit, matched loosely: the result's text, or a refused rate_limit_event
    fake.replay(&[INIT, r#"{"type":"result","subtype":"success","is_error":true,"result":"You've hit your limit · resets 3pm (Europe/Berlin)"}"#]);
    let limit = error(&fake);
    assert!(limit.starts_with(USAGE_LIMIT) && limit.contains("resets 3pm"), "{limit}");
    fake.replay(&[
        INIT,
        r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour"}}"#,
        r#"{"type":"result","subtype":"success","is_error":true,"result":"Request failed"}"#,
    ]);
    assert_eq!(error(&fake), USAGE_LIMIT);

    // no result line: the exit code and the last lines of stderr, with every secret hidden
    let stderr = Fake::new(
        "messages-stderr",
        &[INIT],
        "echo 'loading' >&2; echo 'Error: Session ID s-1 is already in use. Bearer ASSISTANT-TOKEN-0123456789 HEADER-SECRET-VALUE ENV-SECRET-VALUE' >&2; exit 1",
    );
    let message = error(&stderr);
    assert!(message.contains("exit code 1") && message.contains("is already in use"), "{message}");
    for secret in ["ASSISTANT-TOKEN", "HEADER-SECRET", "ENV-SECRET"] {
        assert!(!message.contains(secret), "{message}");
    }
    assert!(message.contains("[hidden]"), "{message}");

    // nothing at all, not even `init` (a very old CLI, or one that failed at once)
    let silent = Fake::new("messages-silent", &[], "exit 1");
    let message = error(&silent);
    assert!(message.contains("Claude Code") && message.contains("exit code 1"), "{message}");
    assert!(exit_error(Some(0), "", true).contains("Claude Code"));
}

// -- the session list --------------------------------------------------------------------

fn write_session(dir: &Path, id: &str, lines: &[Value], age_secs: u64) {
    fs::create_dir_all(dir).unwrap();
    let path = dir.join(format!("{id}.jsonl"));
    fs::write(&path, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
    let file = fs::File::options().write(true).open(&path).unwrap();
    file.set_modified(SystemTime::now() - Duration::from_secs(age_secs)).unwrap();
}

fn user_line(cwd: &str, content: Value) -> Value {
    json!({ "type": "user", "message": { "role": "user", "content": content }, "cwd": cwd, "sessionId": "x", "timestamp": "2026-11-01T13:11:47.162Z" })
}

#[test]
fn sessions_list_newest_first_with_titles() {
    let projects = std::env::temp_dir().join(format!("docbro-claude-test-{}-projects", std::process::id()));
    let _ = fs::remove_dir_all(&projects);
    let report = projects.join("-Users-me-Code-report");
    let site = projects.join("-Users-me-Code-site");

    // titled by the ai-title line
    write_session(&report, "11111111-1111-4111-8111-111111111111", &[
        json!({ "type": "queue-operation", "operation": "enqueue", "content": "Fix the intro" }),
        user_line("/Users/me/Code/report", json!("Fix the intro")),
        json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Done." }] } }),
        json!({ "type": "ai-title", "aiTitle": "Fixing the report intro", "sessionId": "1" }),
    ], 10);
    // the first real user message, deep in the file, after lines that are not one
    let mut lines = vec![
        json!({ "type": "mode", "mode": "x" }),
        json!({ "type": "file-history-snapshot", "snapshot": "y".repeat(600_000) }),
        json!({ "type": "user", "isMeta": true, "message": { "content": "meta" }, "cwd": "/Users/me/Code/site" }),
        user_line("/Users/me/Code/site", json!("<command-name>/clear</command-name>")),
        user_line("/Users/me/Code/site", json!([{ "type": "tool_result", "tool_use_id": "t", "content": "x" }])),
        json!({ "type": "user", "isSidechain": true, "message": { "content": "side" }, "cwd": "/Users/me/Code/site" }),
        "not json".into(),
        user_line("/Users/me/Code/site", json!([{ "type": "text", "text": format!("Build   the\nlanding page {}", "z".repeat(100)) }, { "type": "image" }])),
    ];
    lines.push(json!({ "type": "assistant" }));
    write_session(&site, "22222222-2222-4222-8222-222222222222", &lines, 5);
    // a fork of the first one (same title and prompt), older: listed once
    write_session(&projects.join("-Users-me-Library-DocBro"), "33333333-3333-4333-8333-333333333333", &[
        user_line("/Users/me/Code/report", json!("Fix the intro")),
        json!({ "type": "ai-title", "aiTitle": "Fixing the report intro", "sessionId": "3" }),
    ], 20);
    // no message at all: not listed
    write_session(&site, "44444444-4444-4444-8444-444444444444", &[json!({ "type": "last-prompt" })], 1);
    // not sessions: other files, per-session folders, a name that is not an id
    fs::write(site.join("notes.txt"), "x").unwrap();
    write_session(&site.join("22222222-2222-4222-8222-222222222222").join("subagents"), "55555555-5555-4555-8555-555555555555", &[user_line("/x", json!("sub"))], 0);
    fs::create_dir_all(site.join("memory")).unwrap();
    write_session(&site, "bad id", &[user_line("/x", json!("odd"))], 0);

    let list = list_sessions(&projects);
    let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"]);
    assert_eq!(list[1].title, "Fixing the report intro");
    assert_eq!(list[1].project, "report");
    assert_eq!(list[0].project, "site");
    // whitespace folded, cut to 80 characters
    assert_eq!(list[0].title, format!("Build the landing page {}…", "z".repeat(57)));
    assert_eq!(list[0].title.chars().count(), 81);
    let modified = &list[0].modified;
    assert!(modified.len() == 20 && modified.ends_with('Z') && modified.as_bytes()[10] == b'T', "{modified}");
    assert!(list[0].modified > list[1].modified);

    // the title on its own
    assert_eq!(session_title(&format!("{}\n{}", user_line("/a", json!("Hi there")), json!({ "type": "ai-title", "aiTitle": "Greeting" }))), Some("Greeting".into()));
    assert_eq!(session_title(&user_line("/a", json!("Hi there")).to_string()), Some("Hi there".into()));
    assert_eq!(session_title(&json!({ "type": "queue-operation", "operation": "enqueue", "content": "Queued prompt" }).to_string()), Some("Queued prompt".into()));
    assert_eq!(session_title("{\"type\":\"mode\"}\nnot json"), None);

    // at most 50, newest first
    let many = std::env::temp_dir().join(format!("docbro-claude-test-{}-many", std::process::id()));
    let _ = fs::remove_dir_all(&many);
    for n in 0..55u64 {
        let id = format!("{n:08}-0000-4000-8000-000000000000");
        write_session(&many.join("p"), &id, &[user_line("/p", json!(format!("Prompt {n}")))], n * 10);
    }
    let list = list_sessions(&many);
    assert_eq!(list.len(), 50);
    assert_eq!(list[0].title, "Prompt 0");
    assert_eq!(list[49].title, "Prompt 49");
    assert_eq!(iso_utc(SystemTime::UNIX_EPOCH + Duration::from_secs(1_793_000_000)), "2026-10-26T07:33:20Z");
    assert_eq!(iso_utc(SystemTime::UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00Z");
    // a folder that does not exist is no sessions
    assert_eq!(list_sessions(&many.join("missing")), Vec::new());
}

#[test]
fn teleport_id_is_validated() {
    let ok = |input: &str| teleport_id(input).unwrap();
    assert_eq!(ok("session_01ABCDEFGHJKMNPQRSTUVWXY"), "session_01ABCDEFGHJKMNPQRSTUVWXY");
    assert_eq!(ok("  cse_abc-123 \n"), "cse_abc-123");
    assert_eq!(ok("https://claude.ai/code/session_01ABC"), "session_01ABC");
    assert_eq!(ok("https://claude.ai/code/session_01ABC/?tab=chat#end"), "session_01ABC");
    for bad in ["", "   ", "a b", "session;rm -rf", "-p", "--resume", "https://claude.ai/code/-p", "../..", "é", &"a".repeat(129)] {
        assert!(teleport_id(bad).is_err(), "{bad:?}");
    }
    assert!(teleport_id(&"a".repeat(128)).is_ok());
    let outcome = teleport("https://claude.ai/code/session_01ABC").unwrap();
    assert_eq!(outcome, TeleportOutcome { needs_terminal: true, command: "claude --teleport session_01ABC".into() });
}

#[test]
fn claude_status_and_engine_default() {
    let fake = Fake::new("status", &[], "");
    let dir = std::env::temp_dir().join(format!("docbro-claude-test-{}-status-settings", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let a = Assistant::at(Ok(dir.join("assistant.json"))).with_claude(Some(fake.bin()));
    // found and no key: Claude Code, which needs nothing more
    let status = a.status();
    assert_eq!(status.engine, Engine::ClaudeCode);
    assert!(status.configured);
    assert_eq!(status.claude.version.as_deref(), Some("2.1.316"));
    assert_eq!(status.claude.path.as_deref(), Some(fake.bin().to_string_lossy().as_ref()));
    assert_eq!(status.claude_model, "sonnet");
    // a saved key without a choice: the API, as before
    let status = a.save(Some("sk-ant-0123456789".into()), "claude-sonnet-5-5".into(), None).unwrap();
    assert_eq!(status.engine, Engine::ApiKey);
    // a choice sticks, and the model goes to that engine
    let status = a.save(None, "opus".into(), Some(Engine::ClaudeCode)).unwrap();
    assert_eq!((status.engine, status.claude_model.as_str(), status.model.as_str()), (Engine::ClaudeCode, "opus", "claude-sonnet-5-5"));
    assert!(a.save(None, "--evil".into(), Some(Engine::ClaudeCode)).is_err());

    // not found
    let b = Assistant::at(Ok(dir.join("other.json"))).with_claude(None);
    let status = b.status();
    assert_eq!((status.engine, status.configured, status.claude.found), (Engine::ApiKey, false, false));
}
