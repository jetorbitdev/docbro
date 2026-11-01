# Assistant via Claude Code (subscription) and session import

Date: 2026-11-01. Extends the DocBro plan (`docs/superpowers/plans/2026-10-29-docbro.md`, Tasks 16–17).

## Intent

The Assistant chat (Task 16 loop in Rust, Task 17 panel) only works with an Anthropic API key. The user has a Claude subscription and Claude Code installed, and wants the chat to run on that subscription by driving the `claude` CLI in print mode (`claude -p`). They also want to continue a Claude Code conversation they started elsewhere (the terminal, VS Code, or Claude Code on the web at claude.ai/code) inside DocBro's panel. The user asked for no further questions, so the interpretations below marked *(call)* are the controller's.

## Goals

1. A second chat engine, **Claude Code**, next to **API key**. With it, the chat needs no API key: DocBro runs the user's own `claude` CLI, which signs in with the user's subscription the way it always does.
2. The panel looks and behaves the same with either engine: streamed text, tool cards, Stop, New, `@server`, selection chip, Insert into doc, one undo step per document tool call.
3. **Continue a Claude Code session** in the panel *(call: this is what "import session" means)*:
   - a session from this Mac (terminal / IDE), picked from a list;
   - a session from Claude Code on the web, by pasting its link or id.

## Non-goals

- DocBro never reads browser cookies, the Claude Code keychain entry, OAuth tokens or `~/.claude/.credentials*`, and never calls claude.ai or the API with the user's subscription itself. All subscription use goes through the `claude` process. *(Anti-goal: anything that harvests a session from the browser.)*
- No login flow inside DocBro. If `claude` is not signed in, the panel tells the user to run `claude` once in a terminal and sign in.
- No change to the API-key engine's behaviour.
- Claude Code's own tools (Bash, Edit, Read, WebFetch …) are not offered in DocBro's chat; only DocBro's document tools and the user's MCP servers from DocBro's settings.

## What the spike established (claude 2.1.316, run on 2026-11-01)

- `claude -p "<text>" --output-format stream-json --verbose --include-partial-messages` prints one JSON object per line:
  - `{"type":"system","subtype":"init", session_id, model, apiKeySource, mcp_servers:[{name,status}], tools:[…]}` first (`apiKeySource:"none"` = subscription sign-in);
  - `{"type":"stream_event","event":{…}}` wrapping the Anthropic stream events (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`) — the same shapes Task 16's `SseParser` already turns into `StreamEvent`s;
  - `{"type":"assistant","message":{content:[…]}}` and `{"type":"user","message":{content:[tool_result…]}}` for whole messages;
  - `{"type":"result", subtype, is_error, result, session_id, stop_reason, num_turns, total_cost_usd, permission_denials}` last.
  - other `system` subtypes (`status`, `hook_started`, `hook_response`, `ui_invalidate`) and `rate_limit_event` appear and must be ignored.
- `--setting-sources ""` stops the user's hooks, skills and settings from loading; `--tools ""` removes all built-in tools; `--strict-mcp-config --mcp-config '<json>'` loads only the given servers (they show in `init.mcp_servers` with `source:"dynamic"`). `--safe-mode` is NOT usable: it also drops `--mcp-config` servers.
- `--allowedTools mcp__<server>` pre-approves a server's tools in print mode. Still to verify: that a call is actually allowed this way (see Spike task).
- `--session-id <uuid>`, `-r/--resume <id>`, `--fork-session`, `--no-session-persistence`, `--append-system-prompt`, `--model` exist. `--teleport` exists (it "cannot be combined with --resume, --continue"); `claude -p "msg" --cloud <session-id>` messages a cloud session where it runs (its tools run in the cloud).

## Design

### Engine choice

- McpSettings ▸ **Model** gets an engine choice: **Claude Code (your Claude subscription)** or **Anthropic API key**. Stored in `assistant.json` as `"engine": "claude_code" | "api_key"` (default: `claude_code` when a `claude` binary is found and no key is saved, else `api_key`) *(call)*. The model field stays; for Claude Code it takes a CLI alias or full name (`sonnet`, `opus`, `haiku`, …), default `sonnet` *(call)*.
- `assistant_status()` grows `engine`, `claude: { found: bool, path: Option<String>, version: Option<String> }`. `configured` is true for Claude Code when the binary is found.
- Finding `claude`: the user's PATH is minimal when DocBro starts from Finder, so look in PATH plus `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.claude/local` (reuse Task 15's `child_path` logic for the child's PATH so `node`/`npx` resolve for stdio MCP servers). A `claude_path` override in `assistant.json` is allowed but not required in the UI *(call: no field; detection only)*.

### Running one message (Claude Code engine)

Rust spawns, on a worker thread, with cwd = a DocBro-owned empty folder under the app data dir (no project `CLAUDE.md`):

```
claude -p --output-format stream-json --verbose --include-partial-messages
  --setting-sources "" --disable-slash-commands --tools ""
  --strict-mcp-config --mcp-config <0600 temp file>
  --allowedTools mcp__docbro mcp__<id> …        (enabled servers only)
  --append-system-prompt <build_system_prompt(doc info, selection)>
  --model <model>
  (--session-id <new uuid> | --resume <id> [--fork-session])
```

The user's text goes on **stdin** (not argv), so it does not show in `ps`. The MCP config is a temp file (mode 0600, deleted when the run ends, even on error/cancel/panic) because header and env values are secrets; argv never carries secrets.

- **MCP config contents:** the built-in `docbro` server (unless switched off / `exclude_builtin`) plus each enabled user server translated to Claude Code's format (`{"type":"http","url",headers}` / `{"command","args","env"}`). With an `@id` mention only that user server is included (Ruling 27: docbro stays unless switched off).
- **Reaching the document:** the built-in server is DocBro's own HTTP MCP endpoint. The CLI must reach it even when **Serve DocBro** is off, without opening it to other clients: the server gets a second, in-memory **assistant token** (new random value per app run, never written to disk, never shown). While a Claude Code chat runs, the endpoint listens on 127.0.0.1 and accepts the assistant token; the user's token is accepted only when Serve DocBro is on. Calls authenticated with the assistant token carry `origin: "assistant"` (Ruling 30), so they do not appear as External cards. All existing Host/Origin/bearer guards stay. If the port is taken, the chat shows "DocBro could not start its document tools for Claude Code: <reason>." *(call: this is the builder's to design in detail; the constraints above are binding.)*
- **Events:** a `ClaudeCodeParser` turns the JSON lines into the existing `assistant-event` payloads: text deltas from `stream_event` `text_delta`; a `tool_start` per `tool_use` block (server/tool split from `mcp__<server>__<tool>` using the table built for this request, never by guessing), `tool_end` from the matching `tool_result` (ok = !is_error, text cut to 400); `done` on `result` with `is_error:false`; `error` on `result` with `is_error:true` (use `result` text) or a non-zero exit (last stderr lines, API-key-free). Unknown lines and non-JSON lines are ignored. Cut args/text exactly as Task 16 does.
- **Rounds:** pass `--max-turns 12` if the flag exists in the found version, else rely on the CLI *(call)*.
- **Stop:** kill the process (SIGTERM, then SIGKILL after 2 s), emit `done`. **New:** forget the session id. A window reload resets as today.
- **Busy/one-at-a-time per window, error mapping, no secrets in errors** follow Task 16's rules. New messages: not found → "Claude Code was not found. Install it from claude.com/code, or switch to an API key in MCP settings."; not signed in (detect from the result/stderr) → "Claude Code is not signed in. Run `claude` in a terminal once and sign in."; rate/usage limit → "Your Claude plan's usage limit was reached. Try again later." (show the CLI's own reset text if present).
- **Session continuity:** first message `--session-id <uuid>`; every later message `--resume <that id>`. Sessions DocBro starts are normal Claude Code sessions (they show in `claude --resume`) *(call: persistence on, so a DocBro chat can also be continued in the terminal)*.

### Continue a Claude Code session

The panel's New menu (or the empty state) gets **Continue a Claude Code session…** (Claude Code engine only), opening a small sheet:

1. **On this Mac:** a list of recent sessions read from `~/.claude/projects/*/*.jsonl` (read-only, newest first, up to 50): first user message (cut to 80 chars), project folder name, last modified time. Choosing one sets the window's session to `--resume <id> --fork-session` for the next message, so the original session is never changed *(call: always fork)*. The panel shows "Continuing “<first message>”" above the stream; earlier messages are not replayed into the panel *(call: v1 shows only new messages; a later version may render the transcript)*.
2. **From Claude Code on the web:** a field for a claude.ai/code session link or id. DocBro then brings it to this Mac with the CLI (`claude --teleport <id>`, run non-interactively if the spike shows it can be; it creates a local session) and continues it as in 1. If teleport cannot run without a terminal, the sheet shows the exact command to run once in Terminal (`claude --teleport <id>`, with a Copy button) and says the session then appears under "On this Mac" *(call; decided by the spike)*. Not used: `--cloud`, because the conversation's tools would run in the cloud and could not reach the open document.

The session files are only read to list and label sessions; they are never written. The file contents (other projects' conversations) never leave the machine and are not sent to the model by DocBro.

## Constraints

- Every Global Constraint of the DocBro plan still applies; specifically: secrets never in argv, logs, errors or the webview; a stdio server only starts when switched on; UI copy sentence case, plain English; one undo step per document tool call.
- The CLI's flags and stream format are an external contract: the code must tolerate unknown fields and event types, and report a readable error if `init` never arrives (e.g. a very old CLI). Record the tested CLI version (2.1.316) in a comment.
- Tests must not run the real `claude` or touch `~/.claude`: inject the binary path (a fake script that replays recorded JSON lines) and the projects folder.

## Left to the builder

- How the assistant token is threaded through `mcp.rs` (separate listener vs. same server), as long as the binding constraints hold.
- Whether the Claude Code runner implements Task 16's `Model` trait or sits beside `run_turn` (the CLI runs its own tool loop, so most likely beside it, sharing the event emitter, busy state and settle logic).
- Exact sheet layout, within the mock's tokens and the Task 17 panel style.

## Plan for the work

1. **Spike (throwaway, report only):** with the real CLI and a local MCP server, confirm `--allowedTools mcp__x` lets print-mode call x's tools; whether stdin prompt works with stream-json output; whether `--max-turns` exists; how not-signed-in and usage-limit failures look; whether `--teleport <id>` can run non-interactively and what it leaves behind. Writes findings into this file.
2. **Rust engine:** engine setting + detection, assistant token / origin, runner, parser, session continuity, errors; tests with a fake `claude` script.
3. **UI:** engine choice in McpSettings ▸ Model, Claude Code status line (found / version / sign-in hint), Continue-a-session sheet; tests.
