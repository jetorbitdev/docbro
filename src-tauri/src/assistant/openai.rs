//! The third engine: any provider with an OpenAI-compatible chat completions API (OpenAI,
//! OpenRouter, Gemini, Groq, DeepSeek, Mistral, and local models through Ollama or LM Studio).
//! Only the wire format differs from the Anthropic API: `OpenAiModel` is a `Model`, so
//! `run_turn` and everything around it are shared, and the history stays in the Anthropic
//! shape; it is translated to chat messages for each request.
//!
//! The provider's key follows the Anthropic key's rules, and one more: it only goes to the
//! origin (scheme, host and port) it was saved for. Plain http is allowed only for this computer,
//! and redirects are not followed, so the key never travels in the clear or to another host.

use std::{
    collections::{BTreeMap, HashMap},
    io::Read,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    is_about_the_model, key_hint, result_text, without_tool_blocks, Model, StreamEvent, CONNECT_TIMEOUT, MAX_TOKENS,
    READ_TIMEOUT, RESPONSE_TIMEOUT,
};
use crate::{
    mcp_client::{cut, redact},
    servers::origin,
    CmdResult,
};

const NO_PRESET: &str = "Pick a provider.";
const NO_BASE_URL: &str = "Enter the provider's base URL.";
const BAD_BASE_URL: &str = "The base URL is not a valid web address.";
const NOT_HTTPS: &str = "The base URL must start with https:// (http:// only for this computer).";
const ENDED_EARLY: &str = "The provider ended the answer early.";
// what the model reads for a tool call that has no result in the history
const NOT_RUN: &str = "Not run.";

/// A provider the user can pick; its base URL fills the form and stays editable.
#[derive(Serialize, Debug, PartialEq)]
pub struct Preset {
    pub id: &'static str,
    /// what errors call the provider
    pub name: &'static str,
    /// what the picker shows
    pub label: &'static str,
    /// empty for Custom
    pub base_url: &'static str,
    pub key_required: bool,
}

const fn preset(id: &'static str, name: &'static str, label: &'static str, base_url: &'static str, key_required: bool) -> Preset {
    Preset { id, name, label, base_url, key_required }
}

pub const PRESETS: &[Preset] = &[
    preset("openai", "OpenAI", "OpenAI", "https://api.openai.com/v1", true),
    preset("openrouter", "OpenRouter", "OpenRouter", "https://openrouter.ai/api/v1", true),
    preset("gemini", "Google Gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", true),
    preset("groq", "Groq", "Groq", "https://api.groq.com/openai/v1", true),
    preset("deepseek", "DeepSeek", "DeepSeek", "https://api.deepseek.com/v1", true),
    preset("mistral", "Mistral", "Mistral", "https://api.mistral.ai/v1", true),
    preset("ollama", "Ollama", "Ollama (on this computer)", "http://localhost:11434/v1", false),
    preset("lmstudio", "LM Studio", "LM Studio (on this computer)", "http://localhost:1234/v1", false),
    preset("custom", "Custom", "Custom", "", false),
];

fn find_preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

// -------------------------------------------------------------------- settings

/// `assistant.json`'s `openai`. No `Debug`: it carries the key.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub(crate) struct Settings {
    preset: String,
    /// as saved: never empty once saved, since a blank one takes the preset's
    base_url: String,
    model: String,
    api_key: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { preset: PRESETS[0].id.into(), base_url: String::new(), model: String::new(), api_key: String::new() }
    }
}

/// What the webview may know about the provider settings: the key's last four characters,
/// never the key.
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct OpenAiStatus {
    pub preset: String,
    pub base_url: String,
    pub model: String,
    pub key_hint: Option<String>,
    /// the base URL is valid, a model is set, and a key is saved if the preset needs one
    pub configured: bool,
}

/// The provider settings in the form, not saved yet. No `Debug`: it may carry a key.
#[derive(Deserialize)]
pub struct ProviderDraft {
    pub preset: String,
    pub base_url: String,
    /// None (or blank) uses the saved key, if the base URL has its origin
    pub api_key: Option<String>,
}

/// Where a request goes. No key in it: `Debug` is safe.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Endpoint {
    /// without a trailing `/`
    pub(crate) base_url: String,
    /// what errors call the provider: the preset's name, or the host for Custom
    pub(crate) name: String,
    pub(crate) preset: String,
}

impl Endpoint {
    pub(crate) fn is_loopback(&self) -> bool {
        origin(&self.base_url).is_some_and(|(_, host, _)| is_loopback(&host))
    }
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// `url` trimmed and without its trailing `/`, if requests may go there: http or https, a host,
/// no user name, query or fragment, and https unless the host is this computer.
fn check_base_url(url: &str) -> CmdResult<String> {
    let url = url.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err(NO_BASE_URL.into());
    }
    let uri = url.parse::<ureq::http::Uri>().map_err(|_| BAD_BASE_URL.to_string())?;
    let (Some(scheme), Some(authority)) = (uri.scheme_str(), uri.authority()) else {
        return Err(BAD_BASE_URL.into());
    };
    let scheme = scheme.to_ascii_lowercase();
    let host = authority.host().to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") || host.is_empty() || authority.as_str().contains('@') || uri.query().is_some() || url.contains('#') {
        return Err(BAD_BASE_URL.into());
    }
    if scheme == "http" && !is_loopback(&host) {
        return Err(NOT_HTTPS.into());
    }
    Ok(url.to_string())
}

impl Settings {
    pub(crate) fn is_unset(&self) -> bool {
        self.preset == PRESETS[0].id && self.base_url.is_empty() && self.model.is_empty() && self.api_key.is_empty()
    }

    fn preset(&self) -> &'static Preset {
        find_preset(&self.preset).unwrap_or(&PRESETS[PRESETS.len() - 1])
    }

    fn base_url(&self) -> String {
        match self.base_url.trim() {
            "" => self.preset().base_url.to_string(),
            url => url.trim_end_matches('/').to_string(),
        }
    }

    pub(crate) fn key(&self) -> &str {
        &self.api_key
    }

    pub(crate) fn model(&self) -> &str {
        self.model.trim()
    }

    pub(crate) fn set_model(&mut self, model: &str) {
        self.model = model.trim().to_string();
    }

    pub(crate) fn clear_key(&mut self) {
        self.api_key.clear();
    }

    /// Where requests go, once the base URL is valid and a key is saved if the preset needs one.
    pub(crate) fn endpoint(&self) -> CmdResult<Endpoint> {
        let base_url = check_base_url(&self.base_url())?;
        let preset = self.preset();
        if preset.key_required && self.api_key.is_empty() {
            return Err(format!("Add your {} API key in MCP settings first.", preset.name));
        }
        let name = match preset.id {
            "custom" => origin(&base_url).map(|(_, host, _)| host).unwrap_or_default(),
            _ => preset.name.to_string(),
        };
        Ok(Endpoint { base_url, name, preset: preset.id.into() })
    }

    pub(crate) fn status(&self) -> OpenAiStatus {
        OpenAiStatus {
            preset: self.preset().id.into(),
            base_url: self.base_url(),
            model: self.model().to_string(),
            key_hint: key_hint(&self.api_key),
            configured: self.endpoint().is_ok() && !self.model().is_empty(),
        }
    }

    /// The form's values. A blank base URL is the preset's; `api_key` None (or blank) keeps the
    /// saved key, but only while the base URL's origin stays the same.
    pub(crate) fn update(&mut self, preset: &str, base_url: &str, model: &str, api_key: Option<String>) -> CmdResult<()> {
        let preset = find_preset(preset.trim()).ok_or_else(|| NO_PRESET.to_string())?;
        let base_url = check_base_url(if base_url.trim().is_empty() { preset.base_url } else { base_url })?;
        // a key saved for one server is never sent to another
        if origin(&base_url).is_none() || origin(&base_url) != origin(&self.base_url()) {
            self.api_key.clear();
        }
        if let Some(key) = api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
            self.api_key = key;
        }
        self.preset = preset.id.into();
        self.base_url = base_url;
        self.set_model(model);
        Ok(())
    }
}

// --------------------------------------------------------------- translation

/// The Anthropic-shaped history as chat completion messages, after the system prompt. Every
/// assistant tool call is answered by exactly one `tool` message right after it, in its order,
/// as strict providers require; a call with no result in the history reads as not run. With no
/// tools offered, past tool calls and results go as text, like the Anthropic engine's.
pub(crate) fn chat_messages(history: &Value, system: &str, tools_offered: bool) -> Vec<Value> {
    let history = if tools_offered { history.clone() } else { without_tool_blocks(history) };
    let empty = Vec::new();
    let messages = history.as_array().unwrap_or(&empty);
    let mut out = Vec::new();
    if !system.is_empty() {
        out.push(json!({ "role": "system", "content": system }));
    }
    let mut i = 0;
    while i < messages.len() {
        let message = &messages[i];
        i += 1;
        if message["role"] != "assistant" {
            push_text(&mut out, "user", &message["content"]);
            continue;
        }
        let calls: Vec<&Value> = blocks(&message["content"]).filter(|b| b["type"] == "tool_use").collect();
        if calls.is_empty() {
            push_text(&mut out, "assistant", &message["content"]);
            continue;
        }
        let text = text_of(&message["content"]);
        let tool_calls: Vec<Value> = calls
            .iter()
            .map(|c| json!({ "id": c["id"], "type": "function", "function": { "name": c["name"], "arguments": c["input"].to_string() } }))
            .collect();
        let content = if text.is_empty() { Value::Null } else { json!(text) };
        out.push(json!({ "role": "assistant", "content": content, "tool_calls": tool_calls }));
        // their results are in the next message; the first one for each call counts
        let next = messages.get(i).filter(|m| m["role"] == "user");
        let mut results: HashMap<&str, &Value> = HashMap::new();
        for result in next.into_iter().flat_map(|m| blocks(&m["content"])).filter(|b| b["type"] == "tool_result") {
            results.entry(result["tool_use_id"].as_str().unwrap_or_default()).or_insert(result);
        }
        for call in &calls {
            let content = match results.get(call["id"].as_str().unwrap_or_default()) {
                Some(result) => {
                    let text = result_text(&result["content"]);
                    let text = if text.is_empty() { "(no output)".to_string() } else { text };
                    if result["is_error"] == true { format!("Error: {text}") } else { text }
                }
                None => format!("Error: {NOT_RUN}"),
            };
            out.push(json!({ "role": "tool", "tool_call_id": call["id"], "content": content }));
        }
        if let Some(next) = next {
            push_text(&mut out, "user", &next["content"]);
            i += 1;
        }
    }
    out
}

fn blocks(content: &Value) -> impl Iterator<Item = &Value> {
    content.as_array().into_iter().flatten()
}

/// A message's text: the text itself, or its text blocks one per line.
fn text_of(content: &Value) -> String {
    match content.as_str() {
        Some(text) => text.to_string(),
        None => blocks(content).filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
    }
}

/// A message with `content`'s text, unless it has none (a message of tool results only).
fn push_text(out: &mut Vec<Value>, role: &str, content: &Value) {
    let text = text_of(content);
    if !text.is_empty() {
        out.push(json!({ "role": role, "content": text }));
    }
}

/// `build_tools`' list in the function shape, schemas as given.
pub(crate) fn chat_tools(defs: &[Value]) -> Vec<Value> {
    defs.iter()
        .map(|d| json!({ "type": "function", "function": { "name": d["name"], "description": d["description"], "parameters": d["input_schema"] } }))
        .collect()
}

// ---------------------------------------------------------------- the stream

/// For tool calls that come without an id; the history needs one to pair the result.
static NEXT_CALL: AtomicU64 = AtomicU64::new(1);

/// Reads the `chat.completion.chunk` events of a streamed answer from chunks of any size.
#[derive(Default)]
pub(crate) struct ChunkParser {
    /// the start of a line whose end has not arrived yet
    line: Vec<u8>,
    /// the `data` of the event being read
    data: String,
    /// tool calls being streamed, by index: (id, name, their arguments' JSON so far)
    tools: BTreeMap<u64, (String, String, String)>,
    /// a finish reason came
    finished: bool,
    /// `[DONE]` came: nothing after it counts
    done: bool,
}

impl ChunkParser {
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
            if self.done {
                break;
            }
            self.take_line(&line, &mut events);
        }
        events
    }

    /// The answer came to its end: a finish reason or `[DONE]` arrived.
    pub(crate) fn complete(&self) -> bool {
        self.finished || self.done
    }

    fn take_line(&mut self, line: &str, events: &mut Vec<StreamEvent>) {
        if line.is_empty() {
            let data = std::mem::take(&mut self.data);
            if !data.is_empty() {
                self.dispatch(&data, events);
            }
            return;
        }
        // comments (`:`, as OpenRouter's keep-alives) and other fields are not needed
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        if field == "data" {
            if !self.data.is_empty() {
                self.data.push('\n');
            }
            self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }

    fn dispatch(&mut self, data: &str, events: &mut Vec<StreamEvent>) {
        if data.trim() == "[DONE]" {
            self.done = true;
            if !self.finished {
                self.finish(None, events);
            }
            return;
        }
        let Ok(msg) = serde_json::from_str::<Value>(data) else { return };
        if !msg["error"].is_null() {
            events.push(StreamEvent::Error(error_message(&msg)));
            return;
        }
        // one answer was asked for; a usage chunk has no choices at all
        let Some(choice) = msg["choices"].as_array().and_then(|c| c.iter().find(|c| c["index"].as_u64().unwrap_or(0) == 0)) else {
            return;
        };
        if self.finished {
            return;
        }
        let delta = &choice["delta"];
        if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            events.push(StreamEvent::Text(text.to_string()));
        }
        for (position, call) in delta["tool_calls"].as_array().into_iter().flatten().enumerate() {
            let index = call["index"].as_u64().unwrap_or_else(|| self.index_of(call, position));
            let (id, name, arguments) = self.tools.entry(index).or_default();
            // the id and name come with the first piece; some providers repeat them
            if let Some(v) = call["id"].as_str().filter(|_| id.is_empty()) {
                v.clone_into(id);
            }
            if let Some(v) = call["function"]["name"].as_str().filter(|_| name.is_empty()) {
                v.clone_into(name);
            }
            match &call["function"]["arguments"] {
                Value::String(piece) => arguments.push_str(piece),
                // a provider that sends the arguments as an object, whole
                Value::Object(_) => *arguments = call["function"]["arguments"].to_string(),
                _ => {}
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish(Some(reason), events);
        }
    }

    /// Where a piece of a tool call that came without an index goes: a call of its own when it
    /// is not the first in its chunk or carries another id than the last call (as Gemini sends
    /// each call whole in a chunk of its own), else the last call.
    fn index_of(&self, call: &Value, position: usize) -> u64 {
        let Some((&last, (last_id, _, _))) = self.tools.last_key_value() else { return 0 };
        let other_id = call["id"].as_str().is_some_and(|id| !id.is_empty() && !last_id.is_empty() && id != last_id);
        if position > 0 || other_id { last + 1 } else { last }
    }

    /// The tool calls, one per index, then the reason in the Anthropic API's words.
    fn finish(&mut self, reason: Option<&str>, events: &mut Vec<StreamEvent>) {
        self.finished = true;
        let wanted_tools = !self.tools.is_empty();
        for (_, (id, name, arguments)) in std::mem::take(&mut self.tools) {
            let id = if id.is_empty() { format!("call_docbro_{}", NEXT_CALL.fetch_add(1, Ordering::Relaxed)) } else { id };
            // no arguments at all are an empty object; broken ones (a reply cut off) are too, and
            // such a call is never run
            let input = serde_json::from_str::<Value>(&arguments).ok().filter(Value::is_object).unwrap_or_else(|| json!({}));
            events.push(StreamEvent::ToolUse { id, name, input });
        }
        let stop = match reason {
            Some("length") => "max_tokens",
            // some providers say `stop` even when they ask for tools
            _ if wanted_tools => "tool_use",
            Some("stop") | None => "end_turn",
            Some(other) => other,
        };
        events.push(StreamEvent::Stop(stop.into()));
    }
}

/// What a provider says went wrong, in any of the shapes they use: `{"error": {"message"}}`,
/// `{"error": "..."}`, `{"message": "..."}`, a list of those (Gemini), or plain text.
fn error_message(v: &Value) -> String {
    let v = v.as_array().and_then(|a| a.first()).unwrap_or(v);
    v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).unwrap_or_default().to_string()
}

fn says_no_tools(message: &str) -> bool {
    let m = message.to_lowercase();
    let says_no = ["not support", "unsupported", "doesn't support", "no endpoints found that support", "not enabled"];
    (m.contains("tool") || m.contains("function call")) && says_no.iter().any(|s| m.contains(s))
}

/// The message in a provider's answer to a failed request.
fn body_message(body: &str) -> String {
    serde_json::from_str::<Value>(body).map(|v| error_message(&v)).unwrap_or_else(|_| body.trim().to_string())
}

/// What a failed request is shown as. `body` is the provider's answer; `model` is None for the
/// model list.
#[cfg(test)]
pub(crate) fn http_error(status: u16, body: &str, name: &str, model: Option<&str>) -> String {
    describe(status, &body_message(body), name, model)
}

/// `message` is what the provider said, with the key already hidden.
fn describe(status: u16, message: &str, name: &str, model: Option<&str>) -> String {
    match (status, model) {
        (400 | 404 | 422, Some(model)) if says_no_tools(message) => {
            format!("The model \"{model}\" cannot use tools. Pick a model with tool calling.")
        }
        (401 | 403, _) => format!("The API key was rejected by {name}. Check it in MCP settings."),
        (429, _) => format!("Rate limited by {name}. Try again in a moment."),
        (404, Some(model)) => format!("The model \"{model}\" is not available at {name}."),
        (400 | 422, Some(model)) if is_about_the_model(message) => format!("The model \"{model}\" is not available at {name}."),
        _ if message.is_empty() => format!("{name} error {status}."),
        _ => format!("{name} error {status}: {}", cut(message, 300)),
    }
}

// ------------------------------------------------------------------ the API

/// The client for `endpoint`, with the system's proxy (`HTTP_PROXY` and the like).
pub(crate) fn agent(endpoint: &Endpoint) -> ureq::Agent {
    agent_with(endpoint, ureq::Proxy::try_from_env())
}

pub(crate) fn agent_with(endpoint: &Endpoint, system_proxy: Option<ureq::Proxy>) -> ureq::Agent {
    ureq::Agent::config_builder()
        // a redirect could carry the key to another host
        .max_redirects(0)
        // plain http to this computer must not go through a proxy, which would read it all
        .proxy(if endpoint.is_loopback() { None } else { system_proxy })
        .http_status_as_error(false)
        .user_agent(concat!("DocBro/", env!("CARGO_PKG_VERSION")))
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(RESPONSE_TIMEOUT))
        .timeout_per_read(Some(READ_TIMEOUT))
        .build()
        .into()
}

/// Whatever the provider says back never shows the key, even if it repeats it.
fn hide_key(text: String, key: &str) -> String {
    match key.is_empty() {
        true => text,
        false => redact(&text, &[key.to_string()]),
    }
}

/// A request that got no answer. The error could name the address, never the key, but the
/// user needs neither.
fn unreachable(error: &ureq::Error, endpoint: &Endpoint) -> String {
    match error {
        ureq::Error::Io(e) if e.kind() == std::io::ErrorKind::ConnectionRefused && endpoint.is_loopback() => {
            format!("Nothing is answering at {}. Is Ollama/LM Studio running?", endpoint.base_url)
        }
        _ => format!("Could not reach {}.", endpoint.name),
    }
}

/// A failed answer's status and message, from at most 64 KiB of it. The key is hidden before
/// `describe` cuts the message, so a cut never leaves part of the key, and both in the raw text
/// and in the message read from it, which may have spelled the key with JSON escapes.
fn failure(res: ureq::http::Response<ureq::Body>, key: &str) -> (u16, String) {
    let status = res.status().as_u16();
    let mut answer = Vec::new();
    let _ = res.into_body().into_reader().take(64 * 1024).read_to_end(&mut answer);
    let answer = hide_key(String::from_utf8_lossy(&answer).into_owned(), key);
    (status, hide_key(body_message(&answer), key))
}

/// The provider's models, sorted: `GET {base}/models`.
pub(crate) fn list_models(key: &str, endpoint: &Endpoint) -> CmdResult<Vec<String>> {
    let mut request = agent(endpoint).get(format!("{}/models", endpoint.base_url));
    if !key.is_empty() {
        request = request.header("Authorization", format!("Bearer {key}"));
    }
    let res = request.call().map_err(|e| unreachable(&e, endpoint))?;
    if !res.status().is_success() {
        let (status, message) = failure(res, key);
        return Err(describe(status, &message, &endpoint.name, None));
    }
    let no_list = || format!("{} did not send a list of models.", endpoint.name);
    let text = res.into_body().read_to_string().map_err(|_| no_list())?;
    let list: Value = serde_json::from_str(&text).map_err(|_| no_list())?;
    let data = list["data"].as_array().ok_or_else(no_list)?;
    let mut ids: Vec<String> = data.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// Chat completions, streamed with `ureq`'s blocking reader: run it on a worker thread.
/// No `Debug`: it carries the key.
pub(crate) struct OpenAiModel {
    agent: ureq::Agent,
    /// empty for a provider that needs none
    key: String,
    model: String,
    endpoint: Endpoint,
    system: String,
    /// in the function shape
    tools: Vec<Value>,
    cancel: Arc<AtomicBool>,
}

impl OpenAiModel {
    /// `tools` is `build_tools`' list, in the Anthropic shape.
    pub(crate) fn new(key: &str, model: &str, endpoint: Endpoint, system: String, tools: Vec<Value>, cancel: Arc<AtomicBool>) -> OpenAiModel {
        let tools = chat_tools(&tools);
        OpenAiModel { agent: agent(&endpoint), key: key.into(), model: model.into(), endpoint, system, tools, cancel }
    }

    fn send(&self, body: &Value) -> Result<ureq::http::Response<ureq::Body>, String> {
        let mut request = self.agent.post(format!("{}/chat/completions", self.endpoint.base_url)).header("Content-Type", "application/json");
        if !self.key.is_empty() {
            request = request.header("Authorization", format!("Bearer {}", self.key));
        }
        // OpenRouter shows which app asked; no one else needs to know
        if self.endpoint.preset == "openrouter" {
            request = request.header("X-Title", "DocBro");
        }
        request.send(body.to_string()).map_err(|e| unreachable(&e, &self.endpoint))
    }

    fn broke_off(&self) -> String {
        format!("The connection to {} broke off.", self.endpoint.name)
    }
}

impl Model for OpenAiModel {
    fn stream(&self, request: &Value, on: &mut dyn FnMut(StreamEvent)) -> Result<(), String> {
        let messages = chat_messages(&request["messages"], &self.system, !self.tools.is_empty());
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "max_tokens": MAX_TOKENS,
            "stream": true,
        });
        if !self.tools.is_empty() {
            body["tools"] = json!(self.tools);
        }
        let mut res = self.send(&body)?;
        if !res.status().is_success() {
            let (status, message) = failure(res, &self.key);
            // OpenAI's newer models only take the newer name of the same limit
            if status != 400 || !message.contains("max_completion_tokens") {
                return Err(describe(status, &message, &self.endpoint.name, Some(&self.model)));
            }
            let limit = body.as_object_mut().and_then(|b| b.remove("max_tokens"));
            body["max_completion_tokens"] = limit.unwrap_or(json!(MAX_TOKENS));
            res = self.send(&body)?;
            if !res.status().is_success() {
                let (status, message) = failure(res, &self.key);
                return Err(describe(status, &message, &self.endpoint.name, Some(&self.model)));
            }
        }
        let mut reader = res.into_body().into_reader();
        let (mut parser, mut chunk) = (ChunkParser::default(), [0u8; 8192]);
        while !self.cancel.load(Ordering::SeqCst) {
            let n = match reader.read(&mut chunk) {
                Ok(n) => n,
                // a server that keeps the connection open after the answer's end
                Err(_) if parser.complete() => break,
                Err(_) => return Err(self.broke_off()),
            };
            if n == 0 {
                break;
            }
            for event in parser.feed(&chunk[..n]) {
                match event {
                    StreamEvent::Error(message) => {
                        // hidden before the cut, as above
                        let name = &self.endpoint.name;
                        return Err(match cut(&hide_key(message, &self.key), 300) {
                            message if message.is_empty() => format!("{name} error."),
                            message => format!("{name} error: {message}"),
                        });
                    }
                    event => on(event),
                }
            }
            if parser.done {
                break;
            }
        }
        if !self.cancel.load(Ordering::SeqCst) && !parser.complete() {
            return Err(ENDED_EARLY.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
