use std::{
    cell::RefCell,
    fs,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use serde_json::{json, Value};

use super::*;
use crate::mcp_client::{
    tests::{FakeHttp, Reply},
    ToolInfo, ToolOutput,
};

const KEY: &str = "sk-ant-SECRET";

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("docbro-assistant-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir.join("nested").join("assistant.json")
}

fn assistant(name: &str) -> (Assistant, PathBuf) {
    let path = tmp(name);
    (Assistant::at(Ok(path.clone())), path)
}

fn configured(name: &str) -> Assistant {
    let (a, _) = assistant(name);
    a.save(Some(KEY.into()), DEFAULT_MODEL.into()).unwrap();
    a
}

// -- a scripted model and tools ------------------------------------------------

/// Answers round `n` (from 0) with `reply(n)` and keeps every request it was sent.
struct Script {
    reply: Box<dyn Fn(usize) -> Vec<StreamEvent>>,
    seen: RefCell<Vec<Value>>,
}

impl Script {
    fn new(replies: Vec<Vec<StreamEvent>>) -> Script {
        Script::repeat(move |n| replies.get(n).cloned().unwrap_or_else(|| answer("(the script ran out)")))
    }
    fn repeat(reply: impl Fn(usize) -> Vec<StreamEvent> + 'static) -> Script {
        Script { reply: Box::new(reply), seen: RefCell::new(Vec::new()) }
    }
    fn rounds(&self) -> usize {
        self.seen.borrow().len()
    }
}

impl Model for Script {
    fn stream(&self, request: &Value, on: &mut dyn FnMut(StreamEvent)) -> Result<(), String> {
        let n = self.rounds();
        self.seen.borrow_mut().push(request.clone());
        for event in (self.reply)(n) {
            on(event);
        }
        Ok(())
    }
}

fn answer(text: &str) -> Vec<StreamEvent> {
    vec![StreamEvent::Text(text.into()), StreamEvent::Stop("end_turn".into())]
}

fn use_tool(id: &str, name: &str, input: Value) -> StreamEvent {
    StreamEvent::ToolUse { id: id.into(), name: name.into(), input }
}

fn asks(uses: Vec<StreamEvent>) -> Vec<StreamEvent> {
    let mut reply = uses;
    reply.push(StreamEvent::Stop("tool_use".into()));
    reply
}

type Answer = Box<dyn FnMut(&str, &str, &Value) -> Result<ToolOutput, String>>;

struct Tools {
    known: Vec<(String, String)>,
    ran: Vec<(String, String, Value)>,
    answer: Answer,
}

impl Tools {
    fn new(known: &[(&str, &str)], answer: impl FnMut(&str, &str, &Value) -> Result<ToolOutput, String> + 'static) -> Tools {
        let known = known.iter().map(|(s, t)| (s.to_string(), t.to_string())).collect();
        Tools { known, ran: Vec::new(), answer: Box::new(answer) }
    }
}

impl ToolRunner for Tools {
    fn known(&self) -> &[(String, String)] {
        &self.known
    }
    fn run(&mut self, server: &str, tool: &str, args: &Value) -> Result<ToolOutput, String> {
        self.ran.push((server.into(), tool.into(), args.clone()));
        (self.answer)(server, tool, args)
    }
}

fn ok(text: &str) -> Result<ToolOutput, String> {
    Ok(ToolOutput { text: text.into(), is_error: false })
}

fn user(text: &str) -> Value {
    json!({ "role": "user", "content": text })
}

/// Runs one message; returns what `run_turn` returned and the events it emitted.
fn turn(model: &Script, tools: &mut Tools, history: &mut Vec<Value>, cancel: &AtomicBool) -> (Result<(), String>, Vec<Event>) {
    let mut events = Vec::new();
    let result = run_turn(model, tools, history, &mut |e| events.push(e), cancel);
    (result, events)
}

fn roles(history: &[Value]) -> Vec<&str> {
    history.iter().map(|m| m["role"].as_str().unwrap()).collect()
}

fn info(name: &str) -> ToolInfo {
    ToolInfo { name: name.into(), description: format!("The {name} tool"), input_schema: json!({ "type": "object", "properties": {} }) }
}

// -- pure pieces ---------------------------------------------------------------

#[test]
fn tool_names_are_safe_unique_and_map_back() {
    assert_eq!(tool_name("docbro", "read_document"), "docbro__read_document");
    // anything outside [A-Za-z0-9_-] becomes _
    assert_eq!(tool_name("notes", "search.v2 é"), "notes__search_v2__");
    let long = tool_name("notes", &"x".repeat(100));
    assert_eq!(long.len(), 64);
    assert!(long.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));

    let external = vec![
        ("notes".to_string(), info("search")),
        ("notes".to_string(), info("a.b")),
        // the same name as a.b once made safe: only the first is offered
        ("notes".to_string(), info("a_b")),
        // a tool name may hold __ itself, so a name is never split on it
        ("notes".to_string(), info("get__item")),
        ("notes".to_string(), ToolInfo { input_schema: json!("not a schema"), ..info("odd") }),
        ("long".to_string(), info(&format!("{}1", "y".repeat(80)))),
        ("long".to_string(), info(&format!("{}2", "y".repeat(80)))),
    ];
    let (defs, known) = build_tools(&crate::mcp::tool_defs(), &external);
    let names: Vec<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
    let mut unique = names.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), names.len(), "{names:?}");
    assert_eq!(names.len(), known.len());
    assert!(names.iter().all(|n| n.len() <= 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')));
    assert_eq!(names.iter().filter(|n| n.starts_with("docbro__")).count(), crate::mcp::TOOL_NAMES.len());
    assert_eq!(names.iter().filter(|n| n.starts_with("long__")).count(), 1);

    // the built-in tools keep their descriptions and schemas, in the API's shape
    let read = defs.iter().find(|d| d["name"] == "docbro__read_document").unwrap();
    assert!(read["description"].as_str().unwrap().starts_with("Reads blocks"));
    assert_eq!(read["input_schema"]["type"], "object");
    assert!(read["input_schema"]["properties"]["from"].is_object());
    assert!(read.get("inputSchema").is_none() && read.get("annotations").is_none());
    // a server's schema that is not an object schema is replaced by an empty one
    let odd = defs.iter().find(|d| d["name"] == "notes__odd").unwrap();
    assert_eq!(odd["input_schema"], json!({ "type": "object" }));

    let back = |name: &str| split_tool_name(name, &known);
    assert_eq!(back("docbro__read_document"), Some(("docbro".into(), "read_document".into())));
    assert_eq!(back("notes__a_b"), Some(("notes".into(), "a.b".into())));
    assert_eq!(back("notes__get__item"), Some(("notes".into(), "get__item".into())));
    assert_eq!(back("notes__missing"), None);
    assert_eq!(back("docbro__read_document__x"), None);
    assert_eq!(back(""), None);
}

#[test]
fn system_prompt_carries_the_document_info_and_the_selection() {
    let info = json!({
        "name": "Report.docx",
        "path": "/Users/me/Report.docx",
        "dirty": false,
        "format": "docx",
        "blocks": 12,
        "words": 340,
        "characters": 2011,
        "outline": [
            { "block": 1, "level": 1, "text": "Summary" },
            { "block": 5, "level": 2, "text": "Costs" },
        ],
    })
    .to_string();
    let prompt = build_system_prompt(&info, Some("the second paragraph"));
    for part in ["DocBro", "Report.docx", "12 blocks", "Summary", "Costs", "read_document", "user's language"] {
        assert!(prompt.contains(part), "{part} missing from:\n{prompt}");
    }
    assert!(prompt.contains("The user selected: \"the second paragraph\""), "{prompt}");

    let plain = build_system_prompt(&info, None);
    assert!(!plain.contains("The user selected"), "{plain}");
    assert!(plain.contains("Report.docx"));

    // info that is not JSON is still passed on
    assert!(build_system_prompt("{broken", None).contains("{broken"));
    // no document access (the built-in server is off): no document section
    let none = build_system_prompt("", Some("x"));
    assert!(!none.contains("read_document") && none.contains("user's language") && none.contains("The user selected: \"x\""));
}

const TEXT_STREAM: &str = "event: message_start\r\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"role\":\"assistant\",\"content\":[]}}\r\n\
\r\n\
: a comment line\r\n\
event: content_block_start\r\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\r\n\
\r\n\
event: ping\r\n\
data: {\"type\": \"ping\"}\r\n\
\r\n\
event: content_block_delta\r\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hé\"}}\r\n\
\r\n\
event: content_block_delta\r\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"llo ✓\"}}\r\n\
\r\n\
event: content_block_stop\r\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\r\n\
\r\n\
event: something_new\r\n\
data: {\"type\":\"something_new\",\"index\":0}\r\n\
\r\n\
event: message_delta\r\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":5}}\r\n\
\r\n\
event: message_stop\r\n\
data: {\"type\":\"message_stop\"}\r\n\
\r\n";

fn feed_in_chunks(stream: &str, size: usize) -> Vec<StreamEvent> {
    let mut parser = SseParser::default();
    stream.as_bytes().chunks(size).flat_map(|c| parser.feed(c)).collect()
}

#[test]
fn sse_parser_handles_events_split_across_chunks_and_crlf() {
    let want = vec![
        StreamEvent::Text("Hé".into()),
        StreamEvent::Text("llo ✓".into()),
        StreamEvent::Stop("end_turn".into()),
    ];
    // one byte at a time splits every line, and the multi-byte characters too
    for size in [1, 2, 7, 64, TEXT_STREAM.len()] {
        assert_eq!(feed_in_chunks(TEXT_STREAM, size), want, "chunks of {size}");
    }
    // plain \n line ends
    assert_eq!(feed_in_chunks(&TEXT_STREAM.replace("\r\n", "\n"), 5), want);

    let error = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
    assert_eq!(feed_in_chunks(error, 3), vec![StreamEvent::Error("Overloaded".into())]);
    // an event is only dispatched once its blank line arrives
    let mut parser = SseParser::default();
    assert_eq!(parser.feed(&error.as_bytes()[..error.len() - 1]), vec![]);
    assert_eq!(parser.feed(b"\n"), vec![StreamEvent::Error("Overloaded".into())]);
}

fn block_start(index: u32, block: Value) -> String {
    let data = json!({ "type": "content_block_start", "index": index, "content_block": block });
    format!("event: content_block_start\ndata: {data}\n\n")
}

fn json_delta(index: u32, part: &str) -> String {
    let data = json!({ "type": "content_block_delta", "index": index, "delta": { "type": "input_json_delta", "partial_json": part } });
    format!("event: content_block_delta\ndata: {data}\n\n")
}

fn text_delta(index: u32, text: &str) -> String {
    let data = json!({ "type": "content_block_delta", "index": index, "delta": { "type": "text_delta", "text": text } });
    format!("event: content_block_delta\ndata: {data}\n\n")
}

fn block_stop(index: u32) -> String {
    format!("event: content_block_stop\ndata: {}\n\n", json!({ "type": "content_block_stop", "index": index }))
}

fn stop(reason: &str) -> String {
    let data = json!({ "type": "message_delta", "delta": { "stop_reason": reason, "stop_sequence": null } });
    format!("event: message_delta\ndata: {data}\n\n")
}

fn tool_stream() -> String {
    [
        block_start(0, json!({ "type": "text", "text": "" })),
        text_delta(0, "Reading."),
        block_stop(0),
        block_start(1, json!({ "type": "tool_use", "id": "toolu_1", "name": "docbro__read_document", "input": {} })),
        json_delta(1, ""),
        json_delta(1, "{\"from\": 2,"),
        json_delta(1, " \"to\": 3}"),
        block_stop(1),
        block_start(2, json!({ "type": "tool_use", "id": "toolu_2", "name": "docbro__document_info", "input": {} })),
        block_stop(2),
        stop("tool_use"),
    ]
    .concat()
}

#[test]
fn sse_parser_assembles_tool_input_from_json_deltas() {
    let want = vec![
        StreamEvent::Text("Reading.".into()),
        use_tool("toolu_1", "docbro__read_document", json!({ "from": 2, "to": 3 })),
        // a tool called with no arguments
        use_tool("toolu_2", "docbro__document_info", json!({})),
        StreamEvent::Stop("tool_use".into()),
    ];
    for size in [1, 9, 4096] {
        assert_eq!(feed_in_chunks(&tool_stream(), size), want, "chunks of {size}");
    }
}

#[test]
fn long_tool_results_are_trimmed() {
    let exact = "a".repeat(20_000);
    assert_eq!(trim_result(&exact), exact);
    assert_eq!(trim_result(&"a".repeat(20_001)), format!("{exact}… truncated"));
    // counted in characters, never cutting one in half
    let wide = trim_result(&"é".repeat(25_000));
    assert_eq!(wide, format!("{}… truncated", "é".repeat(20_000)));

    // in the loop: the model gets the trimmed text, the events a short preview
    let model = Script::new(vec![asks(vec![use_tool("t1", "docbro__read_document", json!({ "text": "z".repeat(500) }))]), answer("Done.")]);
    let mut tools = Tools::new(&[("docbro", "read_document")], |_, _, _| ok(&"b".repeat(30_000)));
    let mut history = vec![user("Read it all")];
    let (result, events) = turn(&model, &mut tools, &mut history, &AtomicBool::new(false));
    result.unwrap();
    let content = history[2]["content"][0]["content"].as_str().unwrap();
    assert_eq!(content, format!("{}… truncated", "b".repeat(20_000)));
    let Event::ToolStart { args, .. } = &events[0] else { panic!("{events:?}") };
    assert!(args.chars().count() <= 201 && args.starts_with("{\"text\":\"zzz"), "{args}");
    let Event::ToolEnd { text, .. } = &events[1] else { panic!("{events:?}") };
    assert!(text.chars().count() <= 401 && text.starts_with("bbb"), "{text}");
}

#[test]
fn http_statuses_map_to_the_messages_above() {
    let model = "claude-nope";
    assert_eq!(http_error(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#, model),
        "The API key was rejected. Check it in MCP settings.");
    assert_eq!(http_error(429, r#"{"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}"#, model),
        "Rate limited by the Anthropic API. Try again in a moment.");
    let unknown = "The model \"claude-nope\" is not available to this key.";
    assert_eq!(http_error(400, r#"{"type":"error","error":{"type":"invalid_request_error","message":"The model claude-nope does not exist or is not available"}}"#, model), unknown);
    // what the API answers today for a model it does not know
    assert_eq!(http_error(404, r#"{"type":"error","error":{"type":"not_found_error","message":"model: claude-nope"}}"#, model), unknown);
    assert_eq!(http_error(400, r#"{"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}"#, model),
        "Anthropic API error 400: messages: text content blocks must be non-empty");
    assert_eq!(http_error(529, r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#, model),
        "Anthropic API error 529: Overloaded");
    assert_eq!(http_error(502, "Bad Gateway\n", model), "Anthropic API error 502: Bad Gateway");
    assert_eq!(http_error(500, "", model), "Anthropic API error 500.");

    // the same through the real client, against a local server
    for (status, body, want) in [
        (401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#, "The API key was rejected. Check it in MCP settings."),
        (429, r#"{"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}"#, "Rate limited by the Anthropic API. Try again in a moment."),
        (404, r#"{"type":"error","error":{"type":"not_found_error","message":"model: claude-nope"}}"#, unknown),
        (529, r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#, "Anthropic API error 529: Overloaded"),
    ] {
        let server = FakeHttp::start(move |_, _| Reply::status(status, body));
        let client = AnthropicModel::new(KEY, model, String::new(), vec![], &server.url, Arc::new(AtomicBool::new(false)));
        assert_eq!(client.stream(&json!({ "messages": [user("hi")] }), &mut |_| {}), Err(want.to_string()));
    }

    // nothing listens on the port
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let client = AnthropicModel::new(KEY, model, String::new(), vec![], &format!("http://127.0.0.1:{port}/v1/messages"), Arc::new(AtomicBool::new(false)));
    assert_eq!(client.stream(&json!({ "messages": [] }), &mut |_| {}), Err("Could not reach the Anthropic API.".into()));
}

#[test]
fn the_client_streams_a_reply_with_the_headers_and_limits_of_the_api() {
    let server = FakeHttp::start(|_, _| Reply::sse(tool_stream()));
    let tools = vec![json!({ "name": "docbro__document_info", "description": "Info", "input_schema": { "type": "object" } })];
    let client = AnthropicModel::new(KEY, "claude-test", "Be brief.".into(), tools.clone(), &server.url, Arc::new(AtomicBool::new(false)));
    let mut events = Vec::new();
    client.stream(&json!({ "messages": [user("hi")] }), &mut |e| events.push(e)).unwrap();
    assert_eq!(events.len(), 4);
    assert_eq!(events[1], use_tool("toolu_1", "docbro__read_document", json!({ "from": 2, "to": 3 })));

    let seen = &server.seen()[0];
    assert_eq!(seen.header("x-api-key"), Some(KEY));
    assert_eq!(seen.header("anthropic-version"), Some("2023-06-01"));
    assert_eq!(seen.body["model"], "claude-test");
    assert_eq!(seen.body["max_tokens"], 4096);
    assert_eq!(seen.body["stream"], true);
    assert_eq!(seen.body["system"], "Be brief.");
    assert_eq!(seen.body["tools"], json!(tools));
    assert_eq!(seen.body["messages"], json!([user("hi")]));

    // no tools: the field is left out
    let bare = AnthropicModel::new(KEY, "claude-test", String::new(), vec![], &server.url, Arc::new(AtomicBool::new(false)));
    bare.stream(&json!({ "messages": [user("hi")] }), &mut |_| {}).unwrap();
    assert!(server.seen()[1].body.get("tools").is_none());
}

// -- the loop --------------------------------------------------------------------

#[test]
fn loop_runs_a_tool_then_answers() {
    let model = Script::new(vec![
        asks(vec![StreamEvent::Text("Let me look.".into()), use_tool("toolu_1", "docbro__document_info", json!({}))]),
        answer("It has 12 blocks."),
    ]);
    let mut tools = Tools::new(&[("docbro", "document_info")], |_, _, _| ok("{\"blocks\":12}"));
    let mut history = vec![user("How many blocks?")];
    let (result, events) = turn(&model, &mut tools, &mut history, &AtomicBool::new(false));
    result.unwrap();

    assert_eq!(roles(&history), ["user", "assistant", "user", "assistant"]);
    assert_eq!(history[1]["content"], json!([
        { "type": "text", "text": "Let me look." },
        { "type": "tool_use", "id": "toolu_1", "name": "docbro__document_info", "input": {} },
    ]));
    assert_eq!(history[2]["content"], json!([
        { "type": "tool_result", "tool_use_id": "toolu_1", "content": "{\"blocks\":12}", "is_error": false },
    ]));
    assert_eq!(history[3]["content"], json!([{ "type": "text", "text": "It has 12 blocks." }]));
    assert_eq!(tools.ran, [("docbro".to_string(), "document_info".to_string(), json!({}))]);
    assert_eq!(events, [
        Event::Text { delta: "Let me look.".into() },
        Event::ToolStart { id: "toolu_1".into(), server: "docbro".into(), name: "document_info".into(), args: "{}".into() },
        Event::ToolEnd { id: "toolu_1".into(), ok: true, text: "{\"blocks\":12}".into() },
        Event::Text { delta: "It has 12 blocks.".into() },
        Event::Done,
    ]);
    // the second round sends everything so far
    assert_eq!(model.rounds(), 2);
    assert_eq!(model.seen.borrow()[1]["messages"], json!(history[..3]));
}

#[test]
fn parallel_tool_uses_come_back_in_one_user_message() {
    let model = Script::new(vec![
        asks(vec![use_tool("a", "docbro__document_info", json!({})), use_tool("b", "notes__search", json!({ "q": "x" }))]),
        answer("Both done."),
    ]);
    let mut tools = Tools::new(&[("docbro", "document_info"), ("notes", "search")], |server, _, _| ok(&format!("from {server}")));
    let mut history = vec![user("Do both")];
    let (result, _) = turn(&model, &mut tools, &mut history, &AtomicBool::new(false));
    result.unwrap();
    assert_eq!(roles(&history), ["user", "assistant", "user", "assistant"]);
    assert_eq!(history[2]["content"], json!([
        { "type": "tool_result", "tool_use_id": "a", "content": "from docbro", "is_error": false },
        { "type": "tool_result", "tool_use_id": "b", "content": "from notes", "is_error": false },
    ]));
    assert_eq!(tools.ran[1], ("notes".to_string(), "search".to_string(), json!({ "q": "x" })));
}

#[test]
fn tool_errors_go_back_to_the_model_as_error_results() {
    let model = Script::new(vec![
        asks(vec![use_tool("a", "docbro__delete_blocks", json!({ "from": 9 })), use_tool("b", "notes__search", json!({}))]),
        answer("Sorry."),
    ]);
    let mut tools = Tools::new(&[("docbro", "delete_blocks"), ("notes", "search")], |server, _, _| match server {
        "docbro" => Err("There is no block 9.".into()),
        _ => Ok(ToolOutput { text: "it broke".into(), is_error: true }),
    });
    let mut history = vec![user("Delete block 9")];
    let (result, events) = turn(&model, &mut tools, &mut history, &AtomicBool::new(false));
    result.unwrap();
    assert_eq!(history[2]["content"], json!([
        { "type": "tool_result", "tool_use_id": "a", "content": "There is no block 9.", "is_error": true },
        { "type": "tool_result", "tool_use_id": "b", "content": "it broke", "is_error": true },
    ]));
    assert!(events.contains(&Event::ToolEnd { id: "a".into(), ok: false, text: "There is no block 9.".into() }));
    assert!(events.contains(&Event::ToolEnd { id: "b".into(), ok: false, text: "it broke".into() }));
    assert_eq!(events.last(), Some(&Event::Done));
}

#[test]
fn an_unknown_tool_name_is_reported_to_the_model_not_run() {
    let model = Script::new(vec![asks(vec![use_tool("a", "nope__thing", json!({}))]), answer("I cannot do that.")]);
    let mut tools = Tools::new(&[("docbro", "document_info")], |_, _, _| ok("ran"));
    let mut history = vec![user("Go")];
    let (result, events) = turn(&model, &mut tools, &mut history, &AtomicBool::new(false));
    result.unwrap();
    assert!(tools.ran.is_empty());
    let back = &history[2]["content"][0];
    assert_eq!(back["is_error"], true);
    assert!(back["content"].as_str().unwrap().contains("nope__thing"), "{back}");
    assert!(!events.iter().any(|e| matches!(e, Event::ToolStart { .. })), "{events:?}");
    assert_eq!(roles(&history), ["user", "assistant", "user", "assistant"]);
}

#[test]
fn stops_after_12_rounds_with_a_readable_error() {
    let model = Script::repeat(|n| asks(vec![use_tool(&format!("t{n}"), "docbro__document_info", json!({}))]));
    let mut tools = Tools::new(&[("docbro", "document_info")], |_, _, _| ok("again"));
    let mut history = vec![user("Loop forever")];
    let (result, events) = turn(&model, &mut tools, &mut history, &AtomicBool::new(false));
    assert_eq!(result, Err("The assistant stopped after 12 rounds of tool calls. Send another message to let it go on.".into()));
    assert_eq!(model.rounds(), 12);
    // the 12th round's tool is not run: its result would never reach the model
    assert_eq!(tools.ran.len(), 11);
    // every tool call still has its answer, so the conversation can go on
    assert_eq!(history.len(), 1 + 12 * 2);
    let last = &history[24]["content"][0];
    assert_eq!((last["tool_use_id"].as_str(), last["is_error"].as_bool()), (Some("t11"), Some(true)));
    assert!(!events.contains(&Event::Done));
}

#[test]
fn cancel_stops_before_the_next_tool_and_emits_done() {
    let cancel = Arc::new(AtomicBool::new(false));
    let model = Script::new(vec![
        asks(vec![use_tool("a", "docbro__insert_content", json!({})), use_tool("b", "docbro__insert_content", json!({}))]),
        answer("never asked for"),
    ]);
    let stopper = cancel.clone();
    let mut tools = Tools::new(&[("docbro", "insert_content")], move |_, _, _| {
        stopper.store(true, Ordering::SeqCst);
        ok("inserted")
    });
    let mut history = vec![user("Insert twice")];
    let (result, events) = turn(&model, &mut tools, &mut history, &cancel);
    result.unwrap();
    assert_eq!(tools.ran.len(), 1);
    assert_eq!(model.rounds(), 1);
    assert_eq!(events.iter().filter(|e| matches!(e, Event::ToolStart { .. })).count(), 1);
    assert_eq!(events.last(), Some(&Event::Done));
    // the call that was not run is answered, so the next message is a valid conversation
    assert_eq!(roles(&history), ["user", "assistant", "user"]);
    let skipped = &history[2]["content"][1];
    assert_eq!((skipped["tool_use_id"].as_str(), skipped["is_error"].as_bool()), (Some("b"), Some(true)));
    assert!(skipped["content"].as_str().unwrap().contains("Stopped"), "{skipped}");

    // stopped before the first round: the model is not asked at all
    let model = Script::new(vec![answer("no")]);
    let mut history = vec![user("Hi")];
    let (result, events) = turn(&model, &mut Tools::new(&[], |_, _, _| ok("")), &mut history, &AtomicBool::new(true));
    result.unwrap();
    assert_eq!((model.rounds(), events), (0, vec![Event::Done]));
    assert_eq!(history.len(), 1);

    // stopped while the answer streams: what came after is not shown, what came before is kept
    let cancel = Arc::new(AtomicBool::new(false));
    let stopper = cancel.clone();
    let model = Script::repeat(move |_| {
        stopper.store(true, Ordering::SeqCst);
        vec![StreamEvent::Text("late".into()), StreamEvent::Stop("end_turn".into())]
    });
    let mut history = vec![user("Hi")];
    let (result, events) = turn(&model, &mut Tools::new(&[], |_, _, _| ok("")), &mut history, &cancel);
    result.unwrap();
    assert_eq!(events, vec![Event::Done]);
    assert_eq!(history.len(), 1);
}

#[test]
fn a_stream_error_or_a_stream_that_breaks_off_is_an_error() {
    let model = Script::new(vec![vec![StreamEvent::Text("Hal".into()), StreamEvent::Error("Overloaded".into())]]);
    let mut history = vec![user("Hi")];
    let (result, _) = turn(&model, &mut Tools::new(&[], |_, _, _| ok("")), &mut history, &AtomicBool::new(false));
    assert_eq!(result, Err("Anthropic API error: Overloaded".into()));

    let model = Script::new(vec![vec![StreamEvent::Text("Hal".into())]]);
    let (result, _) = turn(&model, &mut Tools::new(&[], |_, _, _| ok("")), &mut vec![user("Hi")], &AtomicBool::new(false));
    assert_eq!(result, Err("The connection to the Anthropic API broke off.".into()));
}

// -- settings and the chat of each window ------------------------------------------

#[test]
fn missing_key_and_busy_chat_give_the_exact_messages() {
    let (a, _) = assistant("busy");
    assert_eq!(a.begin("main", "Hi").err(), Some("Add your Anthropic API key in MCP settings first.".into()));
    a.save(Some(KEY.into()), DEFAULT_MODEL.into()).unwrap();

    let first = a.begin("main", "Hi").unwrap();
    assert_eq!(first.history, vec![user("Hi")]);
    assert_eq!((first.before, first.key.as_str(), first.model.as_str()), (0, KEY, DEFAULT_MODEL));
    assert_eq!(a.begin("main", "Again").err(), Some("The assistant is still answering. Stop it first.".into()));
    // each window has a chat of its own
    let other = a.begin("doc-1", "Hello").unwrap();
    assert_ne!(first.id, other.id);

    // once the answer is in, the next message goes on from it
    let mut history = first.history;
    history.push(json!({ "role": "assistant", "content": [{ "type": "text", "text": "Hello!" }] }));
    assert!(a.finish("main", first.id, history.clone()));
    let next = a.begin("main", "And now?").unwrap();
    assert_eq!(next.before, 2);
    assert_eq!(next.history[..2], history[..]);
    assert_eq!(next.history[2], user("And now?"));

    assert_eq!(a.begin("doc-2", "   ").err(), Some("Type a message first.".into()));
}

#[test]
fn stopping_and_resetting_a_chat() {
    let a = configured("reset");
    let run = a.begin("main", "Hi").unwrap();
    a.cancel("main");
    assert!(run.cancel.load(Ordering::SeqCst));
    // still answering until the loop has stopped
    assert_eq!(a.begin("main", "Hi").err(), Some(BUSY.into()));
    assert!(a.finish("main", run.id, run.history));
    assert_eq!(a.begin("main", "Next").unwrap().history.len(), 2);

    // reset drops the conversation and stops the answer; its late result is thrown away
    let (b, _) = (configured("reset-2"), ());
    let run = b.begin("main", "Hi").unwrap();
    b.reset("main");
    assert!(run.cancel.load(Ordering::SeqCst));
    let fresh = b.begin("main", "New topic").unwrap();
    assert_eq!(fresh.history, vec![user("New topic")]);
    assert!(!b.finish("main", run.id, vec![user("Hi"), user("stale")]));
    assert!(b.finish("main", fresh.id, fresh.history));
    assert_eq!(b.begin("main", "More").unwrap().history.len(), 2);
    // cancelling or resetting a window with no chat is harmless
    b.cancel("doc-9");
    b.reset("doc-9");
}

#[test]
fn assistant_config_is_private_and_status_only_shows_the_last_four() {
    let (a, path) = assistant("config");
    assert_eq!(a.status(), Status { configured: false, key_hint: None, model: DEFAULT_MODEL.into() });

    let status = a.save(Some(format!("  {KEY}\n")), " claude-opus-5-5 ".into()).unwrap();
    assert_eq!(status, Status { configured: true, key_hint: Some("CRET".into()), model: "claude-opus-5-5".into() });
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved, json!({ "api_key": KEY, "model": "claude-opus-5-5" }));

    // None (or a blank field) keeps the key; the model is required
    assert_eq!(a.save(None, "claude-sonnet-5-5".into()).unwrap().key_hint, Some("CRET".into()));
    assert_eq!(a.save(Some(" ".into()), "claude-sonnet-5-5".into()).unwrap().key_hint, Some("CRET".into()));
    assert_eq!(a.save(Some("sk-other-key".into()), "  ".into()), Err("Enter a model name.".into()));
    assert_eq!(a.status().key_hint, Some("CRET".into()));

    // what the webview gets never holds the key
    let json = serde_json::to_string(&a.status()).unwrap();
    assert!(!json.contains(KEY) && json.contains("\"key_hint\":\"CRET\""), "{json}");
    // a key too short to hide its end gets no hint
    a.save(Some("abcd1234".into()), "m".into()).unwrap();
    assert_eq!(a.status(), Status { configured: true, key_hint: None, model: "m".into() });

    let cleared = a.clear_key().unwrap();
    assert_eq!(cleared, Status { configured: false, key_hint: None, model: "m".into() });
    let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved["api_key"], "");

    // a file someone else can read is made private when it is read
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&path, json!({ "api_key": KEY, "model": "" }).to_string()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        // an empty model falls back to the default
        assert_eq!(a.status().model, DEFAULT_MODEL);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // a broken file reads as no settings
    fs::write(&path, "{not json").unwrap();
    assert!(!a.status().configured);
}

#[test]
fn errors_never_contain_the_api_key() {
    let a = configured("secret");
    let mut texts: Vec<String> = Vec::new();
    texts.push(serde_json::to_string(&a.status()).unwrap());
    texts.push(format!("{:?}", a.status()));
    texts.extend(a.save(Some(KEY.into()), "".into()).err());
    let run = a.begin("main", "Hi").unwrap();
    texts.extend(a.begin("main", "Hi").err());

    // a server that repeats the key it was sent in every answer
    let echo = |headers: &[(String, String)]| {
        headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-api-key")).map(|(_, v)| v.clone()).unwrap_or_default()
    };
    for status in [400, 401, 403, 404, 429, 500] {
        let server = FakeHttp::start(move |_, headers| {
            let message = format!("model: bad key {}", echo(headers));
            Reply::status(status, &json!({ "type": "error", "error": { "type": "x", "message": message } }).to_string())
        });
        let client = AnthropicModel::new(&run.key, &run.model, String::new(), vec![], &server.url, run.cancel.clone());
        texts.extend(client.stream(&json!({ "messages": [] }), &mut |_| {}).err());
    }
    let server = FakeHttp::start(move |_, headers| {
        let error = json!({ "type": "error", "error": { "type": "overloaded_error", "message": format!("no {}", echo(headers)) } });
        Reply::sse(format!("{}event: error\ndata: {error}\n\n", text_delta(0, "Hi")))
    });
    let client = AnthropicModel::new(&run.key, &run.model, String::new(), vec![], &server.url, run.cancel.clone());
    let mut tools = Tools::new(&[], |_, _, _| ok(""));
    let mut history = run.history.clone();
    let mut events = Vec::new();
    texts.extend(run_turn(&client, &mut tools, &mut history, &mut |e| events.push(e), &run.cancel).err());
    texts.extend(events.iter().map(|e| serde_json::to_string(e).unwrap()));
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let client = AnthropicModel::new(&run.key, &run.model, String::new(), vec![], &format!("http://127.0.0.1:{port}/"), run.cancel.clone());
    texts.extend(client.stream(&json!({ "messages": [] }), &mut |_| {}).err());

    assert!(texts.len() >= 12, "{texts:?}");
    for text in &texts {
        assert!(!text.contains(KEY), "the key leaked: {text}");
    }
    assert!(texts.iter().any(|t| t.contains("[hidden]")), "{texts:?}");
}

/// What `settle` sent to the window.
fn settled(
    a: &Assistant,
    label: &str,
    converse: impl FnOnce(&Begun, &mut Vec<Value>, &mut dyn FnMut(Event)) -> Result<(), String>,
) -> Vec<Event> {
    let run = a.begin(label, "Hi").unwrap();
    let sent = RefCell::new(Vec::new());
    settle(a, label, run, &|e| sent.borrow_mut().push(e), converse);
    sent.into_inner()
}

#[test]
fn the_chat_is_free_again_however_the_answer_ends() {
    let a = configured("settle");
    // done: the answer is kept, and done goes out once the chat is free
    let sent = settled(&a, "main", |_, history, emit| {
        emit(Event::Text { delta: "Hello".into() });
        history.push(json!({ "role": "assistant", "content": [{ "type": "text", "text": "Hello" }] }));
        emit(Event::Done);
        Ok(())
    });
    assert_eq!(sent, [Event::Text { delta: "Hello".into() }, Event::Done]);
    assert_eq!(a.begin("main", "Next").unwrap().history.len(), 3);
    a.reset("main");

    // failed before any answer: the unanswered message is dropped, so a retry does not send it twice
    let sent = settled(&a, "main", |_, _, _| Err(KEY_REJECTED.into()));
    assert_eq!(sent, [Event::Error { message: KEY_REJECTED.into() }]);
    assert_eq!(a.begin("main", "Retry").unwrap().history, vec![user("Retry")]);
    a.reset("main");

    // failed after some work: the work stays in the conversation
    let sent = settled(&a, "main", |_, history, _| {
        history.push(json!({ "role": "assistant", "content": [{ "type": "text", "text": "Partly" }] }));
        Err(LIMIT.into())
    });
    assert_eq!(sent, [Event::Error { message: LIMIT.into() }]);
    assert_eq!(a.begin("main", "Go on").unwrap().history.len(), 3);
    a.reset("main");

    // a panic in the worker: the chat is free, the conversation is as before the message
    let sent = settled(&a, "main", |_, history, _| {
        history.push(json!({ "role": "assistant", "content": [{ "type": "tool_use", "id": "t", "name": "x", "input": {} }] }));
        panic!("a bug in the loop");
    });
    assert_eq!(sent, [Event::Error { message: INTERNAL.into() }]);
    assert_eq!(a.begin("main", "Again").unwrap().history, vec![user("Again")]);
    a.reset("main");

    // reset while answering: nothing more reaches the window, and the old answer is not kept
    let resetter = &a;
    let sent = settled(&a, "main", |run, history, emit| {
        resetter.reset("main");
        assert!(run.cancel.load(Ordering::SeqCst));
        emit(Event::Text { delta: "late".into() });
        history.push(json!({ "role": "assistant", "content": [{ "type": "text", "text": "late" }] }));
        Ok(())
    });
    assert_eq!(sent, []);
    assert_eq!(a.begin("main", "Fresh").unwrap().history, vec![user("Fresh")]);
}

#[test]
fn stopping_ends_the_stream_without_waiting_for_the_rest() {
    // a server that sends the first event and then goes quiet without closing the stream
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let Ok((mut socket, _)) = listener.accept() else { return };
        let mut request = [0u8; 65536];
        let _ = socket.read(&mut request);
        let event = text_delta(0, "Hel");
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 100000\r\n\r\n";
        let _ = socket.write_all(format!("{head}{event}").as_bytes());
        std::thread::sleep(std::time::Duration::from_secs(5));
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let client = AnthropicModel::new(KEY, "m", String::new(), vec![], &url, cancel.clone());
    let started = std::time::Instant::now();
    let mut events = Vec::new();
    let result = client.stream(&json!({ "messages": [user("hi")] }), &mut |e| {
        events.push(e);
        cancel.store(true, Ordering::SeqCst);
    });
    assert_eq!(result, Ok(()));
    assert_eq!(events, [StreamEvent::Text("Hel".into())]);
    assert!(started.elapsed() < std::time::Duration::from_secs(4), "{:?}", started.elapsed());
}
