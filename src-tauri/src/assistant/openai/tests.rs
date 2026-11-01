use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde_json::{json, Value};

use super::*;
use crate::{
    assistant::{run_turn, Assistant, Engine, Event, StreamEvent, ToolRunner},
    mcp_client::{
        tests::{FakeHttp, Reply},
        ToolOutput,
    },
};

const KEY: &str = "sk-proj-SECRETKEY1234";
const OTHER_KEY: &str = "sk-or-v1-OTHERKEY5678";

fn assistant(name: &str) -> (Assistant, PathBuf) {
    let dir = std::env::temp_dir().join(format!("docbro-openai-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let path = dir.join("assistant.json");
    (Assistant::at(Ok(path.clone())), path)
}

fn endpoint(base_url: &str, preset: &str) -> Endpoint {
    let name = PRESETS.iter().find(|p| p.id == preset).map_or("Custom", |p| p.name);
    Endpoint { base_url: base_url.into(), name: name.into(), preset: preset.into() }
}

fn client(key: &str, model: &str, base_url: &str, tools: Vec<Value>) -> OpenAiModel {
    OpenAiModel::new(key, model, endpoint(base_url, "openai"), "Be brief.".into(), tools, Arc::new(AtomicBool::new(false)))
}

fn user(text: &str) -> Value {
    json!({ "role": "user", "content": text })
}

fn chunk(delta: Value, finish: Option<&str>) -> String {
    let data = json!({
        "id": "chatcmpl-1",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "m",
        "system_fingerprint": "fp",
        "choices": [{ "index": 0, "delta": delta, "logprobs": null, "finish_reason": finish }],
    });
    format!("data: {data}\n\n")
}

fn text(t: &str) -> String {
    chunk(json!({ "content": t }), None)
}

fn finish(reason: &str) -> String {
    chunk(json!({}), Some(reason))
}

const DONE: &str = "data: [DONE]\n\n";

/// A recorded reply that says something, then asks for two tools at once; the arguments of the
/// first come in pieces, interleaved with the second's start.
fn tool_stream() -> String {
    let call = |index: u32, mut fragment: Value| {
        fragment["index"] = json!(index);
        chunk(json!({ "tool_calls": [fragment] }), None)
    };
    [
        chunk(json!({ "role": "assistant", "content": "" }), None),
        text("Let me "),
        text("look."),
        call(0, json!({ "id": "call_a", "type": "function", "function": { "name": "docbro__read_document", "arguments": "" } })),
        call(0, json!({ "function": { "arguments": "{\"from\":" } })),
        call(1, json!({ "id": "call_b", "type": "function", "function": { "name": "docbro__document_info", "arguments": "" } })),
        call(0, json!({ "function": { "arguments": " 2, \"to\": 3}" } })),
        finish("tool_calls"),
        // the usage chunk some providers send last
        "data: {\"id\":\"chatcmpl-1\",\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":12}}\n\n".into(),
        DONE.into(),
    ]
    .concat()
}

fn use_tool(id: &str, name: &str, input: Value) -> StreamEvent {
    StreamEvent::ToolUse { id: id.into(), name: name.into(), input }
}

fn tool_events() -> Vec<StreamEvent> {
    vec![
        StreamEvent::Text("Let me ".into()),
        StreamEvent::Text("look.".into()),
        use_tool("call_a", "docbro__read_document", json!({ "from": 2, "to": 3 })),
        use_tool("call_b", "docbro__document_info", json!({})),
        StreamEvent::Stop("tool_use".into()),
    ]
}

fn feed_in_chunks(stream: &str, size: usize) -> (Vec<StreamEvent>, bool) {
    let mut parser = ChunkParser::default();
    let events = stream.as_bytes().chunks(size).flat_map(|c| parser.feed(c)).collect();
    (events, parser.complete())
}

/// A server that writes its answer in the pieces given, one read at a time, and keeps the
/// requests it got (request line, headers and body) as text.
struct Raw {
    url: String,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Raw {
    fn start(pieces: Vec<String>) -> Raw {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        thread::spawn(move || {
            for socket in listener.incoming() {
                let Ok(mut socket) = socket else { return };
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                // the head, then the body its Content-Length announces
                while let Ok(n @ 1..) = socket.read(&mut buf) {
                    request.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                log.lock().unwrap().push(String::from_utf8_lossy(&request).to_string());
                let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
                let _ = socket.write_all(head.as_bytes());
                for piece in &pieces {
                    let _ = socket.write_all(piece.as_bytes());
                    let _ = socket.flush();
                    thread::sleep(Duration::from_millis(5));
                }
            }
        });
        Raw { url, seen }
    }

    fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

// -- request translation -------------------------------------------------------------

#[test]
fn history_translates_to_chat_completions() {
    let history = json!([
        user("How long is it?"),
        { "role": "assistant", "content": [
            { "type": "text", "text": "Checking." },
            { "type": "tool_use", "id": "t1", "name": "docbro__document_info", "input": { "x": 1 } },
        ] },
        { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "t1", "content": "{\"blocks\":12}", "is_error": false },
        ] },
        { "role": "assistant", "content": [{ "type": "text", "text": "12 blocks." }] },
        user("Thanks."),
    ]);
    let messages = chat_messages(&history, "Be brief.", true);
    assert_eq!(messages, vec![
        json!({ "role": "system", "content": "Be brief." }),
        user("How long is it?"),
        json!({ "role": "assistant", "content": "Checking.", "tool_calls": [
            { "id": "t1", "type": "function", "function": { "name": "docbro__document_info", "arguments": "{\"x\":1}" } },
        ] }),
        json!({ "role": "tool", "tool_call_id": "t1", "content": "{\"blocks\":12}" }),
        json!({ "role": "assistant", "content": "12 blocks." }),
        user("Thanks."),
    ]);
    // no system prompt: no system message
    assert_eq!(chat_messages(&json!([user("Hi")]), "", true), vec![user("Hi")]);

    // the tool list in the function shape, schemas as given
    let defs = vec![json!({ "name": "docbro__document_info", "description": "Info", "input_schema": { "type": "object", "properties": { "a": { "type": "string" } } } })];
    assert_eq!(chat_tools(&defs), vec![json!({ "type": "function", "function": {
        "name": "docbro__document_info",
        "description": "Info",
        "parameters": { "type": "object", "properties": { "a": { "type": "string" } } },
    } })]);

    // the whole request, as a provider gets it
    let server = FakeHttp::start(|_, _| Reply::sse([text("Hi"), finish("stop"), DONE.into()].concat()));
    client(KEY, "gpt-test", &server.url, defs.clone()).stream(&json!({ "messages": history }), &mut |_| {}).unwrap();
    let seen = &server.seen()[0];
    assert_eq!(seen.header("Authorization"), Some(format!("Bearer {KEY}").as_str()));
    assert_eq!(seen.header("Content-Type"), Some("application/json"));
    // only OpenRouter gets to know the app's name
    assert_eq!(seen.header("X-Title"), None);
    assert_eq!(seen.body["model"], "gpt-test");
    assert_eq!(seen.body["stream"], true);
    assert_eq!(seen.body["max_tokens"], 4096);
    assert_eq!(seen.body["messages"], json!(messages));
    assert_eq!(seen.body["tools"], json!(chat_tools(&defs)));

    let router = OpenAiModel::new(OTHER_KEY, "m", endpoint(&server.url, "openrouter"), String::new(), vec![], Arc::new(AtomicBool::new(false)));
    router.stream(&json!({ "messages": [user("Hi")] }), &mut |_| {}).unwrap();
    assert_eq!(server.seen()[1].header("X-Title"), Some("DocBro"));

    // the path is the base URL's, plus /chat/completions
    let raw = Raw::start(vec![text("Hi"), finish("stop"), DONE.into()]);
    client(KEY, "m", &raw.url, vec![]).stream(&json!({ "messages": [user("Hi")] }), &mut |_| {}).unwrap();
    assert!(raw.seen()[0].starts_with("POST /v1/chat/completions HTTP/1.1\r\n"), "{}", raw.seen()[0]);
}

#[test]
fn tool_results_become_tool_messages() {
    let history = json!([
        user("Do both"),
        { "role": "assistant", "content": [
            { "type": "tool_use", "id": "a", "name": "docbro__document_info", "input": {} },
            { "type": "tool_use", "id": "b", "name": "notes__search", "input": { "q": "x" } },
            { "type": "tool_use", "id": "c", "name": "notes__search", "input": {} },
        ] },
        // out of order, one failed, one with text blocks, one answered twice, one never answered
        // and one that answers nothing that was asked
        { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "b", "content": [{ "type": "text", "text": "no" }, { "type": "text", "text": "match" }], "is_error": true },
            { "type": "tool_result", "tool_use_id": "a", "content": "{\"blocks\":1}", "is_error": false },
            { "type": "tool_result", "tool_use_id": "a", "content": "again", "is_error": false },
            { "type": "tool_result", "tool_use_id": "zz", "content": "stray", "is_error": false },
        ] },
        { "role": "assistant", "content": [{ "type": "text", "text": "Done." }] },
    ]);
    let messages = chat_messages(&history, "", true);
    assert_eq!(messages[1]["content"], Value::Null);
    let calls: Vec<&str> = messages[1]["tool_calls"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(calls, ["a", "b", "c"]);
    // every call answered by exactly one tool message, right after it and in its order
    assert_eq!(messages[2..5], [
        json!({ "role": "tool", "tool_call_id": "a", "content": "{\"blocks\":1}" }),
        json!({ "role": "tool", "tool_call_id": "b", "content": "Error: no\nmatch" }),
        json!({ "role": "tool", "tool_call_id": "c", "content": "Error: Not run." }),
    ]);
    assert_eq!(messages[5], json!({ "role": "assistant", "content": "Done." }));
    assert_eq!(messages.len(), 6);
    assert!(!json!(messages).to_string().contains("stray"));

    // the history run_turn keeps after a stopped tool call goes out as it is: every call answered
    let stopped = json!([
        user("Insert twice"),
        { "role": "assistant", "content": [
            { "type": "tool_use", "id": "a", "name": "docbro__insert_content", "input": {} },
            { "type": "tool_use", "id": "b", "name": "docbro__insert_content", "input": {} },
        ] },
        { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "a", "content": "inserted", "is_error": false },
            { "type": "tool_result", "tool_use_id": "b", "content": "Stopped by the user before this tool ran.", "is_error": true },
        ] },
        user("Go on"),
    ]);
    let roles: Vec<String> = chat_messages(&stopped, "", true).iter().map(|m| m["role"].as_str().unwrap().to_string()).collect();
    assert_eq!(roles, ["user", "assistant", "tool", "tool", "user"]);
    // a tool that answered nothing still answers something
    let empty = json!([
        user("Go"),
        { "role": "assistant", "content": [{ "type": "tool_use", "id": "a", "name": "x", "input": {} }] },
        { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "a", "content": "", "is_error": false }] },
    ]);
    assert_eq!(chat_messages(&empty, "", true)[2]["content"], "(no output)");
}

#[test]
fn no_tools_flattens_past_tool_blocks() {
    let history = json!([
        user("How long is it?"),
        { "role": "assistant", "content": [
            { "type": "text", "text": "Checking." },
            { "type": "tool_use", "id": "t1", "name": "docbro__document_info", "input": { "x": 1 } },
        ] },
        { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "t1", "content": "notes is off", "is_error": true },
        ] },
        { "role": "assistant", "content": [{ "type": "text", "text": "12 blocks." }] },
        user("Thanks."),
    ]);
    let messages = chat_messages(&history, "", false);
    let sent = json!(messages).to_string();
    assert!(!sent.contains("tool_calls") && !sent.contains("\"tool\"") && !sent.contains("tool_call_id"), "{sent}");
    let roles: Vec<&str> = messages.iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["user", "assistant", "user", "assistant", "user"]);
    assert!(messages.iter().all(|m| m["content"].is_string()));
    let called = messages[1]["content"].as_str().unwrap();
    assert!(called.contains("Checking.") && called.contains("docbro__document_info"), "{called}");
    let answered = messages[2]["content"].as_str().unwrap();
    assert!(answered.contains("notes is off") && answered.contains("failed"), "{answered}");

    // through the client: no tools field either
    let server = FakeHttp::start(|_, _| Reply::sse([text("No."), finish("stop"), DONE.into()].concat()));
    client(KEY, "m", &server.url, vec![]).stream(&json!({ "messages": history }), &mut |_| {}).unwrap();
    let body = &server.seen()[0].body;
    assert!(body.get("tools").is_none());
    assert!(!body["messages"].to_string().contains("tool_calls"));
}

// -- the stream ----------------------------------------------------------------------

#[test]
fn stream_text_and_tool_call_fragments_assemble() {
    for size in [1, 7, 64, 100_000] {
        let (events, complete) = feed_in_chunks(&tool_stream(), size);
        assert_eq!(events, tool_events(), "chunks of {size}");
        assert!(complete);
    }

    // through the client, with the stream arriving in pieces
    let server = FakeHttp::start(|_, _| Reply::sse(tool_stream()));
    let mut events = Vec::new();
    client(KEY, "m", &server.url, vec![]).stream(&json!({ "messages": [user("Hi")] }), &mut |e| events.push(e)).unwrap();
    assert_eq!(events, tool_events());

    // a provider that leaves out the call id, and one that sends a whole call in one piece with
    // `stop` as its finish reason
    let odd = [
        chunk(json!({ "tool_calls": [{ "index": 0, "function": { "name": "docbro__document_info", "arguments": "{}" } }] }), None),
        finish("stop"),
        DONE.into(),
    ]
    .concat();
    let (events, _) = feed_in_chunks(&odd, 5);
    let [StreamEvent::ToolUse { id, name, input }, StreamEvent::Stop(reason)] = &events[..] else { panic!("{events:?}") };
    assert!(!id.is_empty());
    assert_eq!((name.as_str(), input, reason.as_str()), ("docbro__document_info", &json!({}), "tool_use"));
}

#[test]
fn stream_handles_split_lines_crlf_and_done() {
    let crlf = tool_stream().replace('\n', "\r\n");
    for size in [1, 2, 3, 50] {
        let (events, complete) = feed_in_chunks(&crlf, size);
        assert_eq!(events, tool_events(), "chunks of {size}");
        assert!(complete);
    }
    // comments, other fields and unknown fields are skipped; a character split across reads
    // survives
    let mixed = format!(": OPENROUTER PROCESSING\n\nevent: x\nid: 1\n{}{}{}{DONE}", text("Hé"), chunk(json!({ "content": "llo ✓", "new_field": [1] }), None), finish("stop"));
    let want = vec![StreamEvent::Text("Hé".into()), StreamEvent::Text("llo ✓".into()), StreamEvent::Stop("end_turn".into())];
    for size in [1, 2, 9] {
        assert_eq!(feed_in_chunks(&mixed, size).0, want, "chunks of {size}");
    }
    // nothing after [DONE] counts
    let (events, complete) = feed_in_chunks(&format!("{}{DONE}{}", text("A"), text("B")), 4);
    assert_eq!(events, vec![StreamEvent::Text("A".into()), StreamEvent::Stop("end_turn".into())]);
    assert!(complete);

    // over a socket that hands the data lines out in pieces, CRLF and all
    let whole = crlf.clone();
    let pieces: Vec<String> = whole.as_bytes().chunks(11).map(|c| String::from_utf8_lossy(c).to_string()).collect();
    // pieces of 11 bytes cut no multi-byte character in this stream
    assert_eq!(pieces.concat(), crlf);
    let raw = Raw::start(pieces);
    let mut events = Vec::new();
    client(KEY, "m", &raw.url, vec![]).stream(&json!({ "messages": [user("Hi")] }), &mut |e| events.push(e)).unwrap();
    assert_eq!(events, tool_events());
}

#[test]
fn stream_without_finish_is_an_error() {
    let (events, complete) = feed_in_chunks(&[text("Hal"), text("f")].concat(), 3);
    assert_eq!(events, vec![StreamEvent::Text("Hal".into()), StreamEvent::Text("f".into())]);
    assert!(!complete);

    let server = FakeHttp::start(|_, _| Reply::sse(text("Hal")));
    let mut events = Vec::new();
    let result = client(KEY, "m", &server.url, vec![]).stream(&json!({ "messages": [user("Hi")] }), &mut |e| events.push(e));
    assert_eq!(result, Err("The provider ended the answer early.".into()));
    assert_eq!(events, vec![StreamEvent::Text("Hal".into())]);

    // half a tool call is never run
    let server = FakeHttp::start(|_, _| {
        Reply::sse(chunk(json!({ "tool_calls": [{ "index": 0, "id": "c", "function": { "name": "docbro__delete_blocks", "arguments": "{\"from\"" } }] }), None))
    });
    let mut events = Vec::new();
    let result = client(KEY, "m", &server.url, vec![]).stream(&json!({ "messages": [user("Hi")] }), &mut |e| events.push(e));
    assert_eq!(result, Err("The provider ended the answer early.".into()));
    assert!(events.is_empty(), "{events:?}");

    // an error the provider sends in the stream
    let server = FakeHttp::start(|_, _| Reply::sse(format!("{}data: {}\n\n", text("Hi"), json!({ "error": { "message": "Upstream overloaded", "code": 502 } }))));
    let result = client(KEY, "m", &server.url, vec![]).stream(&json!({ "messages": [user("Hi")] }), &mut |_| {});
    assert_eq!(result, Err("OpenAI error: Upstream overloaded".into()));

    // [DONE] with no finish reason ends the answer too
    let (events, complete) = feed_in_chunks(&[text("Hi"), DONE.into()].concat(), 4);
    assert_eq!(events, vec![StreamEvent::Text("Hi".into()), StreamEvent::Stop("end_turn".into())]);
    assert!(complete);
}

#[test]
fn length_finish_is_cut_off() {
    let cut = [
        text("Writing"),
        chunk(json!({ "tool_calls": [{ "index": 0, "id": "c", "type": "function", "function": { "name": "docbro__insert_content", "arguments": "{\"content\": \"lo" } }] }), None),
        finish("length"),
        DONE.into(),
    ]
    .concat();
    let (events, complete) = feed_in_chunks(&cut, 6);
    assert!(complete);
    // the broken call comes with no input, and the reply says it was cut off
    assert_eq!(events, vec![
        StreamEvent::Text("Writing".into()),
        use_tool("c", "docbro__insert_content", json!({})),
        StreamEvent::Stop("max_tokens".into()),
    ]);

    // in the loop the call is answered without being run
    let server = FakeHttp::start(move |_, _| Reply::sse(cut.clone()));
    let mut tools = Runner::new(&[("docbro", "insert_content")]);
    let mut history = vec![user("Write")];
    let mut events = Vec::new();
    run_turn(&client(KEY, "m", &server.url, vec![]), &mut tools, &mut history, &mut |e| events.push(e), &AtomicBool::new(false)).unwrap();
    assert!(tools.ran.is_empty());
    assert_eq!(history[2]["content"][0]["is_error"], true);
    assert!(history[2]["content"][0]["content"].as_str().unwrap().contains("cut off"));
    assert_eq!(events.last(), Some(&Event::Done));
}

/// Answers every tool with what it was called with.
struct Runner {
    known: Vec<(String, String)>,
    ran: Vec<(String, String, Value)>,
}

impl Runner {
    fn new(known: &[(&str, &str)]) -> Runner {
        Runner { known: known.iter().map(|(s, t)| (s.to_string(), t.to_string())).collect(), ran: Vec::new() }
    }
}

impl ToolRunner for Runner {
    fn known(&self) -> &[(String, String)] {
        &self.known
    }
    fn run(&mut self, server: &str, tool: &str, args: &Value) -> Result<ToolOutput, String> {
        self.ran.push((server.into(), tool.into(), args.clone()));
        Ok(ToolOutput { text: format!("{tool} ran"), is_error: false })
    }
}

#[test]
fn loop_runs_a_tool_then_answers_over_openai() {
    let server = FakeHttp::start(|body, _| {
        let answered = body["messages"].as_array().unwrap().iter().any(|m| m["role"] == "tool");
        match answered {
            false => Reply::sse([
                text("Let me look."),
                chunk(json!({ "tool_calls": [{ "index": 0, "id": "call_a", "type": "function", "function": { "name": "docbro__document_info", "arguments": "" } }] }), None),
                chunk(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "{}" } }] }), None),
                finish("tool_calls"),
                DONE.into(),
            ]
            .concat()),
            true => Reply::sse([text("It has 12 blocks."), finish("stop"), DONE.into()].concat()),
        }
    });
    let defs = vec![json!({ "name": "docbro__document_info", "description": "Info", "input_schema": { "type": "object" } })];
    let model = client(KEY, "m", &server.url, defs);
    let mut tools = Runner::new(&[("docbro", "document_info")]);
    let mut history = vec![user("How many blocks?")];
    let mut events = Vec::new();
    run_turn(&model, &mut tools, &mut history, &mut |e| events.push(e), &AtomicBool::new(false)).unwrap();

    // the history stays in the Anthropic shape
    assert_eq!(history, vec![
        user("How many blocks?"),
        json!({ "role": "assistant", "content": [
            { "type": "text", "text": "Let me look." },
            { "type": "tool_use", "id": "call_a", "name": "docbro__document_info", "input": {} },
        ] }),
        json!({ "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "call_a", "content": "document_info ran", "is_error": false },
        ] }),
        json!({ "role": "assistant", "content": [{ "type": "text", "text": "It has 12 blocks." }] }),
    ]);
    assert_eq!(tools.ran, [("docbro".to_string(), "document_info".to_string(), json!({}))]);
    assert_eq!(events, [
        Event::Text { delta: "Let me look.".into() },
        Event::ToolStart { id: "call_a".into(), server: "docbro".into(), name: "document_info".into(), args: "{}".into() },
        Event::ToolEnd { id: "call_a".into(), ok: true, text: "document_info ran".into() },
        Event::Text { delta: "It has 12 blocks.".into() },
        Event::Done,
    ]);
    // the second round sends the call and its answer the OpenAI way
    let second = &server.seen()[1].body["messages"];
    assert_eq!(second[2]["tool_calls"][0]["id"], "call_a");
    assert_eq!(second[3], json!({ "role": "tool", "tool_call_id": "call_a", "content": "document_info ran" }));
}

#[test]
fn newer_openai_models_get_max_completion_tokens() {
    let server = FakeHttp::start(|body, _| match body.get("max_tokens") {
        Some(_) => Reply::status(400, &json!({ "error": {
            "message": "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            "type": "invalid_request_error", "param": "max_tokens", "code": "unsupported_parameter",
        } }).to_string()),
        None => Reply::sse([text("Hi"), finish("stop"), DONE.into()].concat()),
    });
    let mut events = Vec::new();
    client(KEY, "gpt-next", &server.url, vec![]).stream(&json!({ "messages": [user("Hi")] }), &mut |e| events.push(e)).unwrap();
    assert_eq!(events, vec![StreamEvent::Text("Hi".into()), StreamEvent::Stop("end_turn".into())]);
    let seen = server.seen();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1].body["max_completion_tokens"], 4096);
}

// -- settings ------------------------------------------------------------------------

#[test]
fn openai_settings_are_saved_privately_and_pick_the_engine() {
    let (a, path) = assistant("settings");
    // nothing set up: the engine is not picked on its own, and reads as not configured
    let status = a.status();
    assert_eq!(status.engine, Engine::ApiKey);
    assert_eq!(status.openai, OpenAiStatus { preset: "openai".into(), base_url: "https://api.openai.com/v1".into(), model: String::new(), key_hint: None, configured: false });

    let status = a.save_openai("openrouter".into(), " ".into(), " openai/gpt-test ".into(), Some(format!(" {KEY}\n"))).unwrap();
    assert_eq!(status.engine, Engine::OpenAiCompatible);
    assert!(status.configured);
    assert_eq!(status.openai, OpenAiStatus {
        preset: "openrouter".into(),
        base_url: "https://openrouter.ai/api/v1".into(),
        model: "openai/gpt-test".into(),
        key_hint: Some("1234".into()),
        configured: true,
    });
    let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved["engine"], "openai_compatible");
    assert_eq!(saved["openai"], json!({ "preset": "openrouter", "base_url": "https://openrouter.ai/api/v1", "model": "openai/gpt-test", "api_key": KEY }));
    // the other engines' settings stay as they were
    assert_eq!((saved["api_key"].as_str(), saved["model"].as_str()), (Some(""), Some("claude-sonnet-5-5")));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // what the webview gets never holds the key
    let json = serde_json::to_string(&a.status()).unwrap();
    assert!(!json.contains(KEY) && json.contains("\"key_hint\":\"1234\""), "{json}");
    assert!(json.contains("\"engine\":\"openai_compatible\""), "{json}");

    // the engine's model through the general save; the Anthropic key stays the Anthropic key
    let status = a.save(None, "openai/gpt-other".into(), Some(Engine::OpenAiCompatible)).unwrap();
    assert_eq!((status.openai.model.as_str(), status.model.as_str()), ("openai/gpt-other", "claude-sonnet-5-5"));
    // a model may be left empty until the list is loaded, but then the engine is not ready
    let status = a.save_openai("openrouter".into(), String::new(), String::new(), None).unwrap();
    assert!(!status.configured && !status.openai.configured && status.openai.key_hint.is_some());
    assert_eq!(a.begin("main", "Hi").err(), Some("Enter a model name.".into()));
    assert_eq!(a.save_openai("nope".into(), String::new(), "m".into(), None).err(), Some("Pick a provider.".into()));
    assert_eq!(a.save_openai("custom".into(), " ".into(), "m".into(), None).err(), Some("Enter the provider's base URL.".into()));

    // ready to answer: the message carries the key, model and where it goes
    a.save_openai("openrouter".into(), String::new(), "openai/gpt-test".into(), None).unwrap();
    let run = a.begin("main", "Hi").unwrap();
    assert_eq!((run.engine, run.key.as_str(), run.model.as_str()), (Engine::OpenAiCompatible, KEY, "openai/gpt-test"));
    assert_eq!(run.endpoint, Some(Endpoint { base_url: "https://openrouter.ai/api/v1".into(), name: "OpenRouter".into(), preset: "openrouter".into() }));
    assert_eq!(run.history, vec![user("Hi")]);
    assert!(a.finish("main", run.id, run.history));

    // removing the key leaves the rest
    let status = a.clear_openai_key().unwrap();
    assert_eq!((status.openai.key_hint, status.configured), (None, false));
    assert_eq!(a.begin("main", "Hi").err(), Some("Add your OpenRouter API key in MCP settings first.".into()));

    // every preset of the spec, in its order
    let presets: Vec<(&str, &str, bool)> = PRESETS.iter().map(|p| (p.id, p.base_url, p.key_required)).collect();
    assert_eq!(presets, [
        ("openai", "https://api.openai.com/v1", true),
        ("openrouter", "https://openrouter.ai/api/v1", true),
        ("gemini", "https://generativelanguage.googleapis.com/v1beta/openai", true),
        ("groq", "https://api.groq.com/openai/v1", true),
        ("deepseek", "https://api.deepseek.com/v1", true),
        ("mistral", "https://api.mistral.ai/v1", true),
        ("ollama", "http://localhost:11434/v1", false),
        ("lmstudio", "http://localhost:1234/v1", false),
        ("custom", "", false),
    ]);
}

#[test]
fn key_is_dropped_when_the_origin_changes() {
    let (a, path) = assistant("origin");
    let hint = |s: crate::assistant::Status| s.openai.key_hint;
    assert_eq!(hint(a.save_openai("openai".into(), String::new(), "m".into(), Some(KEY.into())).unwrap()), Some("1234".into()));
    // the same origin with another path, another case or its default port spelled out: kept
    for same in ["https://api.openai.com/v2", "https://API.OpenAI.com/v1/", "https://api.openai.com:443/v1", "HTTPS://api.openai.com"] {
        assert_eq!(hint(a.save_openai("custom".into(), same.into(), "m".into(), None).unwrap()), Some("1234".into()), "{same}");
    }
    // another host: the key is not sent there, and is gone from the file too
    assert_eq!(hint(a.save_openai("custom".into(), "https://proxy.example.com/v1".into(), "m".into(), None).unwrap()), None);
    let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved["openai"]["api_key"], "");
    assert!(!fs::read_to_string(&path).unwrap().contains(KEY));
    // a key typed along with the new address belongs to it
    assert_eq!(hint(a.save_openai("custom".into(), "https://proxy.example.com/v1".into(), "m".into(), Some(OTHER_KEY.into())).unwrap()), Some("5678".into()));
    // another port, another scheme, another preset's address: dropped each time
    assert_eq!(hint(a.save_openai("custom".into(), "https://proxy.example.com:8443/v1".into(), "m".into(), None).unwrap()), None);
    a.save_openai("custom".into(), "https://localhost:8443/v1".into(), "m".into(), Some(OTHER_KEY.into())).unwrap();
    assert_eq!(hint(a.save_openai("custom".into(), "http://localhost:8443/v1".into(), "m".into(), None).unwrap()), None);
    a.save_openai("openai".into(), String::new(), "m".into(), Some(KEY.into())).unwrap();
    assert_eq!(hint(a.save_openai("ollama".into(), String::new(), "m".into(), None).unwrap()), None);
    // a failed save changes nothing
    a.save_openai("openai".into(), String::new(), "m".into(), Some(KEY.into())).unwrap();
    assert!(a.save_openai("custom".into(), "http://evil.example.com/v1".into(), "m".into(), None).is_err());
    assert_eq!(a.status().openai.key_hint, Some("1234".into()));
    assert_eq!(a.status().openai.base_url, "https://api.openai.com/v1");
}

#[test]
fn http_only_for_loopback() {
    let (a, path) = assistant("loopback");
    let https = "The base URL must start with https:// (http:// only for this computer).";
    let invalid = "The base URL is not a valid web address.";
    for (bad, want) in [
        ("http://api.example.com/v1", https),
        ("http://192.168.1.10:11434/v1", https),
        ("http://localhost.example.com/v1", https),
        ("http://127.0.0.2:1234/v1", https),
        ("ftp://localhost/v1", invalid),
        ("localhost:11434/v1", invalid),
        ("not a url", invalid),
        ("https://user:pw@api.example.com/v1", invalid),
        ("https://api.example.com/v1?key=1", invalid),
        ("https:///v1", invalid),
    ] {
        assert_eq!(a.save_openai("custom".into(), bad.into(), "m".into(), None).err().as_deref(), Some(want), "{bad}");
    }
    for good in ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080/v1", "HTTP://LocalHost:11434/v1", "https://api.example.com/v1", "https://api.example.com"] {
        let status = a.save_openai("custom".into(), good.into(), "m".into(), None).unwrap();
        assert!(status.configured, "{good}");
    }
    // a file edited by hand to plain http elsewhere: not configured, and nothing is sent
    fs::write(&path, json!({ "engine": "openai_compatible", "openai": { "preset": "custom", "base_url": "http://api.example.com/v1", "model": "m", "api_key": KEY } }).to_string()).unwrap();
    assert!(!a.status().configured);
    assert_eq!(a.begin("main", "Hi").err().as_deref(), Some(https));
    assert_eq!(a.list_models().err().as_deref(), Some(https));
}

#[test]
fn redirects_are_not_followed() {
    let target = FakeHttp::start(|_, _| Reply::sse([text("Hi"), finish("stop"), DONE.into()].concat()));
    let to = target.url.clone();
    let redirect = FakeHttp::start(move |_, _| Reply::status(307, "").header("Location", &format!("{to}/chat/completions")));
    let result = client(KEY, "m", &redirect.url, vec![]).stream(&json!({ "messages": [user("Hi")] }), &mut |_| {});
    assert_eq!(result, Err("OpenAI error 307.".into()));
    assert!(list_models(KEY, &endpoint(&redirect.url, "openai")).is_err());
    assert_eq!(redirect.seen().len(), 2);
    assert!(target.seen().is_empty(), "the redirect was followed");
}

#[test]
fn list_models_sorted() {
    let server = FakeHttp::start(|_, _| {
        Reply::json(json!({ "object": "list", "data": [
            { "id": "gpt-b", "object": "model" }, { "id": "gpt-a" }, { "id": "gpt-c", "owned_by": "x" }, { "id": "gpt-a" }, { "no": "id" },
        ] }))
    });
    assert_eq!(list_models(KEY, &endpoint(&server.url, "openai")).unwrap(), ["gpt-a", "gpt-b", "gpt-c"]);
    assert_eq!(server.seen()[0].header("Authorization"), Some(format!("Bearer {KEY}").as_str()));
    // no key: no Authorization header
    list_models("", &endpoint(&server.url, "ollama")).unwrap();
    assert_eq!(server.seen()[1].header("Authorization"), None);

    // with the saved settings
    let (a, _) = assistant("models");
    a.save_openai("custom".into(), server.url.clone(), String::new(), Some(KEY.into())).unwrap();
    assert_eq!(a.list_models().unwrap(), ["gpt-a", "gpt-b", "gpt-c"]);
    // a key the preset needs and does not have
    a.save_openai("openai".into(), String::new(), String::new(), None).unwrap();
    a.clear_openai_key().unwrap();
    assert_eq!(a.list_models().err(), Some("Add your OpenAI API key in MCP settings first.".into()));

    // GET on the base URL's path, plus /models
    let raw = Raw::start(vec![json!({ "data": [{ "id": "llama3.2" }] }).to_string()]);
    assert_eq!(list_models("", &endpoint(&raw.url, "ollama")).unwrap(), ["llama3.2"]);
    assert!(raw.seen()[0].starts_with("GET /v1/models HTTP/1.1\r\n"), "{}", raw.seen()[0]);

    // errors, as for the chat
    let rejected = FakeHttp::start(|_, _| Reply::status(401, r#"{"error":{"message":"Incorrect API key provided"}}"#));
    assert_eq!(list_models(KEY, &endpoint(&rejected.url, "openai")).err(), Some("The API key was rejected by OpenAI. Check it in MCP settings.".into()));
    let odd = FakeHttp::start(|_, _| Reply::json(json!({ "models": [] })));
    assert_eq!(list_models(KEY, &endpoint(&odd.url, "openai")).err(), Some("OpenAI did not send a list of models.".into()));
}

#[test]
fn error_statuses_map_to_messages() {
    let m = Some("gpt-nope");
    assert_eq!(http_error(401, r#"{"error":{"message":"Incorrect API key provided: sk-..."}}"#, "OpenAI", m), "The API key was rejected by OpenAI. Check it in MCP settings.");
    assert_eq!(http_error(403, "Forbidden", "Groq", m), "The API key was rejected by Groq. Check it in MCP settings.");
    assert_eq!(http_error(404, r#"{"error":{"message":"The model `gpt-nope` does not exist or you do not have access to it.","code":"model_not_found"}}"#, "OpenAI", m),
        "The model \"gpt-nope\" is not available at OpenAI.");
    assert_eq!(http_error(400, r#"{"error":{"message":"model 'gpt-nope' not found"}}"#, "Ollama", m), "The model \"gpt-nope\" is not available at Ollama.");
    assert_eq!(http_error(429, r#"{"error":{"message":"Rate limit reached"}}"#, "Mistral", m), "Rate limited by Mistral. Try again in a moment.");
    let no_tools = "The model \"gpt-nope\" cannot use tools. Pick a model with tool calling.";
    // what Ollama, OpenRouter and Groq say
    assert_eq!(http_error(400, r#"{"error":{"message":"registry.ollama.ai/library/gemma:2b does not support tools","type":"api_error"}}"#, "Ollama", m), no_tools);
    assert_eq!(http_error(404, r#"{"error":{"message":"No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs","code":404}}"#, "OpenRouter", m), no_tools);
    assert_eq!(http_error(400, r#"{"error":{"message":"tools is not supported with this model","type":"invalid_request_error"}}"#, "Groq", m), no_tools);
    // Gemini answers with a list
    assert_eq!(http_error(400, r#"[{"error":{"code":400,"message":"Invalid JSON payload received.","status":"INVALID_ARGUMENT"}}]"#, "Google Gemini", m),
        "Google Gemini error 400: Invalid JSON payload received.");
    assert_eq!(http_error(503, r#"{"error":"Model is loading"}"#, "llm.example.com", m), "llm.example.com error 503: Model is loading");
    assert_eq!(http_error(500, r#"{"message":"boom"}"#, "DeepSeek", m), "DeepSeek error 500: boom");
    assert_eq!(http_error(502, "Bad Gateway\n", "OpenAI", m), "OpenAI error 502: Bad Gateway");
    assert_eq!(http_error(502, "", "OpenAI", m), "OpenAI error 502.");
    let long = http_error(500, &"x".repeat(400), "OpenAI", m);
    assert_eq!(long, format!("OpenAI error 500: {}…", "x".repeat(300)));
    // the model list has no model to blame
    assert_eq!(http_error(404, "Not Found", "OpenAI", None), "OpenAI error 404: Not Found");

    // through the client, with the preset's name, or the host for Custom
    for (status, body, preset, want) in [
        (401, r#"{"error":{"message":"bad key"}}"#, "openai", "The API key was rejected by OpenAI. Check it in MCP settings."),
        (429, r#"{"error":{"message":"slow"}}"#, "groq", "Rate limited by Groq. Try again in a moment."),
        (404, r#"{"error":{"message":"model not found"}}"#, "gemini", "The model \"gpt-nope\" is not available at Google Gemini."),
    ] {
        let server = FakeHttp::start(move |_, _| Reply::status(status, body));
        let model = OpenAiModel::new(KEY, "gpt-nope", endpoint(&server.url, preset), String::new(), vec![], Arc::new(AtomicBool::new(false)));
        assert_eq!(model.stream(&json!({ "messages": [user("hi")] }), &mut |_| {}), Err(want.to_string()));
    }
    let (a, _) = assistant("custom-name");
    let server = FakeHttp::start(|_, _| Reply::status(500, r#"{"error":{"message":"boom"}}"#));
    a.save_openai("custom".into(), server.url.clone(), "m".into(), None).unwrap();
    let run = a.begin("main", "Hi").unwrap();
    let custom = run.endpoint.clone().unwrap();
    assert_eq!(custom.name, "127.0.0.1");
    let model = OpenAiModel::new(&run.key, &run.model, custom, String::new(), vec![], run.cancel.clone());
    assert_eq!(model.stream(&json!({ "messages": run.history }), &mut |_| {}), Err("127.0.0.1 error 500: boom".into()));

    // nothing listens on this computer's port
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let base = format!("http://127.0.0.1:{port}/v1");
    let want = format!("Nothing is answering at {base}. Is Ollama/LM Studio running?");
    let model = OpenAiModel::new("", "llama3.2", endpoint(&base, "ollama"), String::new(), vec![], Arc::new(AtomicBool::new(false)));
    assert_eq!(model.stream(&json!({ "messages": [user("hi")] }), &mut |_| {}), Err(want.clone()));
    assert_eq!(list_models("", &endpoint(&base, "ollama")), Err(want));
}

#[test]
fn errors_never_contain_the_key() {
    let (a, _) = assistant("secret");
    let mut texts: Vec<String> = Vec::new();
    a.save_openai("openai".into(), String::new(), "gpt-test".into(), Some(KEY.into())).unwrap();
    texts.push(serde_json::to_string(&a.status()).unwrap());
    texts.push(format!("{:?}", a.status()));
    texts.extend(a.save_openai("custom".into(), format!("http://example.com/{KEY}"), "m".into(), None).err());
    texts.extend(a.save_openai("nope".into(), String::new(), "m".into(), None).err());
    let run = a.begin("main", "Hi").unwrap();
    texts.push(format!("{:?}", run.endpoint));
    texts.extend(a.begin("main", "Hi").err());

    // a server that repeats the key it was sent in every answer
    let echo = |headers: &[(String, String)]| {
        headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.clone()).unwrap_or_default()
    };
    let model = |url: &str| OpenAiModel::new(&run.key, &run.model, endpoint(url, "openai"), String::new(), vec![], run.cancel.clone());
    for status in [400, 401, 403, 404, 429, 500, 503] {
        let server = FakeHttp::start(move |_, headers| {
            let message = format!("model not found, tools not supported, bad key {}", echo(headers));
            Reply::status(status, &json!({ "error": { "message": message } }).to_string())
        });
        texts.extend(model(&server.url).stream(&json!({ "messages": [user("hi")] }), &mut |_| {}).err());
        texts.extend(list_models(&run.key, &endpoint(&server.url, "openai")).err());
    }
    // an error message cut at 300 characters, with the key repeated across the cut
    for start in 285..=300 {
        let server = FakeHttp::start(move |_, headers| {
            let message = format!("{}{} and more", "x".repeat(start), echo(headers));
            Reply::status(500, &json!({ "error": { "message": message } }).to_string())
        });
        let error = model(&server.url).stream(&json!({ "messages": [] }), &mut |_| {}).unwrap_err();
        assert!(error.starts_with("OpenAI error 500: xxx"), "{error}");
        texts.push(error);
    }
    // in the stream, and through the loop
    let server = FakeHttp::start(move |_, headers| {
        let error = json!({ "error": { "message": format!("no {}", echo(headers)) } });
        Reply::sse(format!("{}data: {error}\n\n", text("Hi")))
    });
    let mut history = run.history.clone();
    let mut events = Vec::new();
    texts.extend(run_turn(&model(&server.url), &mut Runner::new(&[]), &mut history, &mut |e| events.push(e), &run.cancel).err());
    texts.extend(events.iter().map(|e| serde_json::to_string(e).unwrap()));
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    texts.extend(model(&format!("http://127.0.0.1:{port}/v1")).stream(&json!({ "messages": [] }), &mut |_| {}).err());

    assert!(texts.len() >= 34, "{texts:?}");
    for text in &texts {
        // not even partly: no 8 or more of its first characters
        assert!(!text.contains(&KEY[..8]), "the key leaked: {text}");
    }
    assert!(texts.iter().any(|t| t.contains("[hidden]")), "{texts:?}");
}

#[test]
fn ollama_preset_needs_no_key() {
    let (a, _) = assistant("ollama");
    let status = a.save_openai("ollama".into(), String::new(), "llama3.2".into(), None).unwrap();
    assert!(status.configured);
    assert_eq!(status.engine, Engine::OpenAiCompatible);
    assert_eq!((status.openai.base_url.as_str(), status.openai.key_hint.as_deref()), ("http://localhost:11434/v1", None));
    let run = a.begin("main", "Hi").unwrap();
    assert_eq!((run.key.as_str(), run.model.as_str()), ("", "llama3.2"));
    assert_eq!(run.endpoint.as_ref().map(|e| e.name.as_str()), Some("Ollama"));
    assert!(a.finish("main", run.id, run.history));
    // LM Studio neither
    assert!(a.save_openai("lmstudio".into(), String::new(), "qwen".into(), None).unwrap().configured);
    // OpenAI does
    let status = a.save_openai("openai".into(), String::new(), "gpt-test".into(), None).unwrap();
    assert!(!status.configured);
    assert_eq!(a.begin("main", "Hi").err(), Some("Add your OpenAI API key in MCP settings first.".into()));

    // no key: no Authorization header at all
    let server = FakeHttp::start(|_, _| Reply::sse([text("Hi"), finish("stop"), DONE.into()].concat()));
    let model = OpenAiModel::new("", "llama3.2", endpoint(&server.url, "ollama"), String::new(), vec![], Arc::new(AtomicBool::new(false)));
    model.stream(&json!({ "messages": [user("hi")] }), &mut |_| {}).unwrap();
    assert_eq!(server.seen()[0].header("Authorization"), None);
}

#[test]
fn stopping_ends_the_stream_without_waiting_for_the_rest() {
    // a server that sends the first chunk and then goes quiet without closing the stream
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    thread::spawn(move || {
        let Ok((mut socket, _)) = listener.accept() else { return };
        let mut request = [0u8; 65536];
        let _ = socket.read(&mut request);
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 100000\r\n\r\n";
        let _ = socket.write_all(format!("{head}{}", text("Hel")).as_bytes());
        thread::sleep(Duration::from_secs(5));
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let model = OpenAiModel::new(KEY, "m", endpoint(&url, "openai"), String::new(), vec![], cancel.clone());
    let started = std::time::Instant::now();
    let mut events = Vec::new();
    let result = model.stream(&json!({ "messages": [user("hi")] }), &mut |e| {
        events.push(e);
        cancel.store(true, Ordering::SeqCst);
    });
    assert_eq!(result, Ok(()));
    assert_eq!(events, [StreamEvent::Text("Hel".into())]);
    assert!(started.elapsed() < Duration::from_secs(4), "{:?}", started.elapsed());
}
