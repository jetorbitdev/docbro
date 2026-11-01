# Assistant on other LLM providers (OpenAI-compatible)

Date: 2026-11-01. Companion to `2026-11-01-claude-code-backend-design.md`; extends DocBro plan Tasks 16–17.

## Intent

Besides the Anthropic API key (Task 16) and Claude Code (Task 20), the Assistant chat should run on other LLM providers. The user chose **one generic OpenAI-compatible engine with presets** (decision of 2026-11-01): a base URL, an optional API key and a model name cover OpenAI, OpenRouter, Google Gemini (its OpenAI-compatible endpoint), Groq, DeepSeek, Mistral, and local models through Ollama and LM Studio.

## Goals

1. A third engine, **Other provider (OpenAI-compatible)**, selectable in McpSettings ▸ Model.
2. Same chat behaviour as the other engines: streamed text, tool cards, Stop, New, `@server`, selection chip, Insert into doc, one undo step per document tool call, the 12-round cap, 20,000-char result trim.
3. Presets fill the base URL; the model list can be loaded from the provider.

## Non-goals

- No provider-specific APIs (no native Gemini/Mistral SDK shapes), no image input, no embeddings, no "responses" API: only `POST {base}/chat/completions` with `stream: true` and `tools`, and `GET {base}/models`.
- No hard-coded model names: they change too often. The model is typed or picked from the loaded list.
- Models without tool calling are not made to work by prompt tricks; the chat says the model cannot use tools.

## Presets

| Preset | Base URL | Key |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | required |
| OpenRouter | `https://openrouter.ai/api/v1` | required |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | required |
| Groq | `https://api.groq.com/openai/v1` | required |
| DeepSeek | `https://api.deepseek.com/v1` | required |
| Mistral | `https://api.mistral.ai/v1` | required |
| Ollama (on this computer) | `http://localhost:11434/v1` | none |
| LM Studio (on this computer) | `http://localhost:1234/v1` | none |
| Custom | typed by the user | optional |

The base URL stays editable after picking a preset.

## Design

### Settings

- `assistant.json` gains `engine: "openai_compatible"` as a third value and an `openai` object: `{ preset, base_url, model, api_key }` (mode 0600 like the rest of the file). The API key follows the Task 16 rules: never sent to the webview (status shows only the last four characters), never logged, never in an error, never in argv.
- **A saved key only goes to the origin it was saved for** (same rule as Ruling 31 for MCP servers): if the base URL's origin (scheme + host + port) changes, the saved key is dropped and must be entered again; the form says "The saved key is not sent to a different server. Enter it again."
- **http is allowed only for loopback** (`localhost`, `127.0.0.1`, `::1`); any other host must use https. Redirects are not followed (as in Task 16), so a key never follows a redirect to another host.
- `assistant_status()` reports, for this engine, `{ preset, base_url, model, key_hint }`; `configured` = base URL valid, model non-empty, and a key present when the preset requires one.
- `assistant_list_models() -> CmdResult<Vec<String>>`: `GET {base}/models` with the key, returns sorted `data[].id`; errors mapped like chat errors.

### Engine

Implement Task 16's `Model` trait as `OpenAiModel` so `run_turn`, the tool runner, history, cancel, busy/settle and every event stay shared *(call: reuse the loop; only the wire format differs)*:

- **Request translation** (Anthropic-shaped history → OpenAI): system prompt → a `system` message; user text → `user`; assistant text + `tool_use` blocks → one `assistant` message with `content` and `tool_calls: [{id, type:"function", function:{name, arguments: JSON string}}]`; each `tool_result` → a `tool` message `{tool_call_id, content}` (error results prefixed `Error: `); tools → `[{type:"function", function:{name, description, parameters}}]` (schemas as given; strip keys a provider rejects only if the spike/test shows a need). `max_tokens` 4096, `stream: true`. With no tools offered, past tool blocks are flattened to text exactly like Task 16's fix (no `tools`, no `tool_calls`).
- **Stream translation** (SSE `data:` lines of `chat.completion.chunk`, ending with `data: [DONE]`) → Task 16 `StreamEvent`s: `choices[0].delta.content` → text deltas; `delta.tool_calls[i]` fragments (id/name arrive first, `arguments` in pieces, keyed by `index`) → one tool use per index when the choice finishes; `finish_reason` `tool_calls` / `stop` / `length` → the matching stop reason (`length` = cut off, as Task 16 handles). Unknown fields ignored; a stream that ends without `[DONE]` or a finish reason is an error ("The provider ended the answer early.").
- Headers: `Authorization: Bearer <key>` when a key is set; `Content-Type: application/json`. OpenRouter accepts optional `HTTP-Referer`/`X-Title`; send `X-Title: DocBro` only to OpenRouter *(call)*.
- Tool names: Task 16's `tool_name()` already yields `[A-Za-z0-9_-]{1,64}`, which OpenAI-style function names accept.
- **Error mapping** (provider name from the preset, or the host for Custom): 401/403 → "The API key was rejected by <provider>. Check it in MCP settings."; 404 or a model-not-found message → "The model \"<model>\" is not available at <provider>."; 429 → "Rate limited by <provider>. Try again in a moment."; a 400 whose message says tools/function calling is unsupported → "The model \"<model>\" cannot use tools. Pick a model with tool calling."; connection refused on a loopback URL → "Nothing is answering at <base URL>. Is Ollama/LM Studio running?"; other → "<provider> error <status>: <message, key hidden, cut to 300>".

### UI (in Task 21)

McpSettings ▸ Model shows three engine rows: Claude Code, Anthropic API key, Other provider. Other provider shows: preset picker, base URL, API key (password field, `•••• <last four>` once saved, Remove key; hidden for Ollama/LM Studio unless the user types one), model field with **Load models** (fills a picker from `assistant_list_models`; typing stays possible), and one line saying what leaves the computer ("Your messages, the document text the model reads and tool results are sent to <provider>." — for loopback presets: "Everything stays on this computer.").

## Constraints

- All DocBro Global Constraints and Task 16 rules apply (key handling, limits, sentence-case plain English UI copy).
- Tests never call a real provider: a local test HTTP server streams recorded chunks (including split `data:` lines, CRLF, tool-call argument fragments across chunks, `[DONE]`) and returns the error statuses.

## Left to the builder

- Module layout (e.g. `src-tauri/src/assistant/openai.rs`), as long as `Model` is implemented and history stays Anthropic-shaped internally.
- Whether presets live in Rust or TS (they are needed for validation in Rust: key-required and default base URL).
