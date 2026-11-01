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

## Spike findings (Task 19)

Run on 2026-11-01 against `claude` 2.1.316 (`/Users/gilang/.local/bin/claude`), signed in with the user's subscription (`init.apiKeySource` is `"none"`), `--model haiku` (resolves to `claude-haiku-5-5`). About 15 short runs; no credential, keychain or token file was read; no sign-in or sign-out. Throwaway MCP server: a 40-line Python stdio server (`python3 -I echo_mcp.py`, newline-delimited JSON-RPC: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`) with one tool `echo` that returns `echo: <text>`. Its config, `mcp.json`: `{"mcpServers":{"spikeecho":{"command":"/usr/bin/python3","args":["-I","<scratch>/echo_mcp.py"]}}}`.

Every run used an empty working folder, `< /dev/null` or a pipe on stdin, a 90 s `perl -e 'alarm shift; exec @ARGV'` guard, and (except the first run) a clean environment (`env -i HOME=… PATH=/usr/bin:/bin:… claude …`), which is what an app started from Finder looks like. `BASE` below means:

```
claude -p --output-format stream-json --verbose --include-partial-messages \
  --setting-sources "" --disable-slash-commands --tools "" \
  --strict-mcp-config --mcp-config mcp.json --model haiku
```

### 1. `--allowedTools mcp__<server>` lets print mode call the server's tools

```
echo 'Call the echo tool with text "ping" and then reply with just the tool output.' \
  | claude -p … (BASE) --allowedTools mcp__spikeecho --no-session-persistence
```

Exit 0, no stderr. `init` shows the server connected and only its tool:

```
{"type":"system","subtype":"init","session_id":"8cfd1e44-…","tools":["mcp__spikeecho__echo"],"mcp_servers":[{"name":"spikeecho","status":"connected","source":"dynamic"}],"model":"claude-haiku-5-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.316", …}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01Qx…","name":"mcp__spikeecho__echo","input":{}}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"text\": \"ping"}}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01Qx…","name":"mcp__spikeecho__echo","input":{"text":"ping"},"caller":{"type":"direct"}}],"stop_reason":null},"session_id":"8cfd1e44-…"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01Qx…","type":"tool_result","content":[{"type":"text","text":"echo: ping"}]}]},"tool_use_result":[{"type":"text","text":"echo: ping"}],"tool_result_meta":[{"id":"toolu_01Qx…","permission_decision":{"decision":"accept","source":"config","reason_type":"rule"}}]}
{"type":"result","subtype":"success","is_error":false,"result":"echo: ping","stop_reason":"end_turn","session_id":"8cfd1e44-…","num_turns":2,"total_cost_usd":0.00097817,"permission_denials":[],"terminal_reason":"completed", …}
```

Contrast, same command without `--allowedTools`: the call is refused (exit 0, `result.is_error` false):

```
{"type":"system","subtype":"permission_denied","tool_name":"mcp__spikeecho__echo","tool_use_id":"toolu_011s…","message":"Claude requested permissions to use mcp__spikeecho__echo, but you haven't granted it yet."}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Claude requested permissions to use mcp__spikeecho__echo, but you haven't granted it yet.","is_error":true,"tool_use_id":"toolu_011s…"}]},"tool_result_meta":[{"id":"toolu_011s…","non_execution_kind":"user-rejected","permission_decision":{"decision":"reject","source":"config"}}]}
{"type":"result","subtype":"success","is_error":false,"result":"The echo tool was blocked by a permission prompt, …","permission_denials":[{"tool_name":"mcp__spikeecho__echo","tool_use_id":"toolu_011s…","tool_input":{"text":"ping"}}], …}
```

Two servers, `--allowedTools mcp__spikeecho mcp__spike-b` (separate argv entries, no positional prompt so the variadic flag is safe) and `--mcp-config` naming `spikeecho` and `spike-b`: both calls accepted (`mcp__spikeecho__echo`, `mcp__spike-b__echo`; the hyphen in the server name is kept), `permission_denials: []`.

Shapes to rely on:

- Tool name is `mcp__<server>__<tool>` with the server name exactly as given in the config (hyphens kept); split it with the per-request table, not by guessing.
- `content_block_start` for a tool has `input:{}`; the arguments arrive as `input_json_delta` pieces, and the whole `input` object is in the following `assistant` line. One `assistant` line carries one content block (observed: `thinking`, `tool_use`, `tool_use`, `text` each on its own line). `assistant` lines also arrive for plain text, so text must come from `text_delta` only, or it is shown twice.
- A `tool_result`'s `content` is a list of `{type:"text",text}` blocks when the tool ran, but a plain string when the CLI itself produced the result (denial). Handle both.
- `tool_result.is_error` is true for MCP `isError` results and for denials. `result.is_error` stays false in both cases; a non-empty `permission_denials` on `result` is the only run-level sign of a refusal.

Conclusion: `--allowedTools mcp__<server> [mcp__<server> …]` pre-approves the whole server in print mode with no prompt and no denial; leaving a server out of it makes its calls fail with `permission_denied` and a non-empty `permission_denials`.

### 2. The prompt on stdin works with stream-json output

Every run above fed the prompt on stdin (`echo '…' | claude -p …`, no positional argument). Output was complete stream-json (init through result), exit 0. The stored user message keeps the trailing newline (`"…just the word.\n"`).

Conclusion: stdin works; write the text without a trailing newline (or trim) and close stdin so the CLI starts.

### 3. `--max-turns` exists, but is missing from `--help`

`claude --help | grep max-turns` finds nothing (only `--max-budget-usd`), yet the flag is accepted and enforced:

```
echo 'Call the echo tool with text "one", then call it again with text "two", then reply done.' \
  | claude -p … (BASE minus --include-partial-messages) --allowedTools mcp__spikeecho --no-session-persistence --max-turns 1
```

Exit code 1; stdout ends with (no `result` text field, the reason is in `errors`):

```
{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":2,"stop_reason":"tool_use","terminal_reason":"max_turns","errors":["Reached maximum number of turns (1)"],"permission_denials":[], …}
```

`--max-turns 12` was accepted in every later run with no effect on normal answers (a tool call plus the final answer counts as 2 turns).

Conclusion: pass `--max-turns 12`; the flag cannot be feature-detected from `--help`. Map `result.subtype == "error_max_turns"` (exit 1) to a readable "Claude Code stopped after 12 steps" message.

### 4. Session continuity: `--session-id`, `--resume`, `--resume --fork-session`

```
echo 'Call the echo tool with text "kumquat". Then remember the secret word: kumquat. Reply with one short sentence.' \
  | claude -p … (BASE) --allowedTools mcp__spikeecho --max-turns 12 --session-id a58cb882-e0af-47a3-abd9-215f026181a6
echo 'What was the secret word? Answer with just the word.' \
  | claude -p … (BASE) --allowedTools mcp__spikeecho --max-turns 12 --resume a58cb882-e0af-47a3-abd9-215f026181a6
echo 'What was the secret word? …' | claude -p … (BASE) … --resume a58cb882-… --fork-session
```

- Message 1: `init.session_id` is exactly the uuid passed; message 2 (`--resume`): `init.session_id` is the same uuid, answer `kumquat`, `result.session_id` the same; both turns are in the same file (38 lines, 57 130 bytes).
- `--resume … --fork-session`: `init.session_id` is a new uuid (`5d769f48-8925-400b-85a7-6271f82177b2`), `result.session_id` the same new one, answer `kumquat` (history carried over). The original file kept its mtime, size and 38 lines.
- A resume works from a different working folder than the one the session was made in: `--resume a58cb882-… --fork-session` run from another folder succeeded (answer `kumquat`, new id `3f1a5169-…`), and the new session file was written under the new folder's project directory, the original stayed where it was. So DocBro's own folder does not need to equal the session's `cwd`; the forked copy lands in DocBro's folder.
- Failure shapes (both exit 1):
  - `--resume <unknown uuid>`: stderr `No conversation found with session ID: <id>`; stdout one line `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"<the id given>","errors":["No conversation found with session ID: <id>"], …}` (no `init`).
  - `--session-id <uuid already used>`: stderr `Error: Session ID <uuid> is already in use.`, stdout empty.
- All flags (`--allowedTools`, `--mcp-config`, …) were passed on every message; whether a session remembers them was not tested.

Conclusion: first message `--session-id <new uuid>`, later messages `--resume <same id>` (`init.session_id` stays the same); picking an existing session uses `--resume <id> --fork-session` and the id to keep for later messages is the new `init.session_id`, not the one picked.

### 5. Session files (read-only survey)

Layout: `~/.claude/projects/<folder>/<session-id>.jsonl`. `<folder>` is the session's `cwd` with every `/` and `.` replaced by `-` (lossy: read the real `cwd` from a line instead). Besides the `.jsonl` files a project folder holds `memory/` and per-session directories `<session-id>/` (`subagents`, `tool-results`, …); list only the top-level `*.jsonl`. File stem = `sessionId`. (A survey of the machine found 80 project folders and 251 session files; only structure was read.)

Line shape facts (from the spike's own sessions, cross-checked on the type/key names of 40 recent sessions):

- Every line is one JSON object with `type`. The first line is not always a message: seen first-line types are `queue-operation`, `mode`, `last-prompt`, `tools-used`. Other types: `user`, `assistant`, `attachment`, `ai-title`, `last-prompt`, `file-history-snapshot`, `permission-mode`, `cost-state`, `api-request*`, `atis-latch`.
- `user` / `assistant` lines carry `sessionId`, `cwd`, `timestamp` (ISO 8601 UTC), `uuid`, `parentUuid`, `isSidechain`, `version`, `gitBranch`, `entrypoint` (`sdk-cli` for `claude -p`), `message`.
- First prompt: the first `type:"user"` line with no `isSidechain` and no `isMeta`, whose `message.content` is a string (a `-p`/stdin prompt: `{"type":"user","message":{"role":"user","content":"Call the echo tool …"},"timestamp":"2026-11-01T13:11:47.162Z","cwd":"…","sessionId":"a58cb882-…","promptSource":"sdk",…}`) or a list of blocks (`[{type:"text",text}]`, sometimes with `image` blocks, for interactive sessions). Skip tool results (`content` is a list with `tool_result`) and wrapper lines whose text starts with `<command-name>`, `<local-command-stdout>`, `<local-command-caveat>` or `<ide_opened_file>`. That line can be far down: among 60 recent sessions it was at line index up to 37 and byte offset up to about 555 KB. Scan line by line, never a fixed head size, and stop at the first hit.
- Labels without scanning for a user line: `{"type":"ai-title","aiTitle":"…","sessionId":"…"}` (present in about 85% of 60 recent sessions, usually around line 22-30) and `{"type":"last-prompt","lastPrompt":"…","leafUuid":"…","sessionId":"…"}`. A leading `queue-operation` line (`operation:"enqueue"`, `content` = the prompt, `timestamp`) also holds the first prompt for `-p` sessions.
- Time: use the file mtime for "last modified"; `timestamp` on the first/last `user`/`assistant` line for start/end.
- A fork is a full copy of the history in a new file whose every line carries the new `sessionId`; there is no `forkedFrom` marker. Forks (including the ones DocBro makes) show up as separate sessions with the same first prompt; DocBro's own project folder will fill with them.
- Non-JSON or oversized lines are possible: parse per line and skip failures.

Conclusion: list `~/.claude/projects/*/*.jsonl` newest first; label = `ai-title` if seen, else the first real user text (cut to 80 chars); `cwd` and folder from the first `user` line; stop reading each file at the first real user line (and the title, if within a small line budget).

### 6. `claude --teleport` without a real id, with and without `-p`

```
claude --teleport 00000000-0000-4000-8000-000000000001 < /dev/null > out 2> err
echo hi | claude -p --teleport 00000000-0000-4000-8000-000000000001 --model haiku --no-session-persistence
echo hi | claude -p --output-format stream-json --verbose --setting-sources "" --disable-slash-commands --tools "" \
    --teleport session_01ABCDEFGHJKMNPQRSTUVWXY --model haiku --no-session-persistence --debug-file dbg.log
```

All three: exit 1, stdout 0 bytes, stderr 0 bytes (no `init` line either, even with stream-json). No TTY was needed for the CLI to reach the id check, so it is not a "needs a terminal" failure; it is a silent failure. The only reason is in the debug log (`--debug-file`), captured for two other fake ids (a first debug run used `session_01AbCdEfGhIjKlMnOpQrStUv`, which has the letters I and l; the bare uuid runs had no debug log, so their reason is assumed to be the same as the first line):

```
[ERROR] Teleport in print mode failed: invalid session ID: must be a cse_… or session_… tagged ID      (session_01AbCdEfGhIjKlMnOpQrStUv: right prefix, malformed body)
[ERROR] Teleport in print mode failed: Session not found: session_01ABCDEFGHJKMNPQRSTUVWXY              (well-formed id, in an empty folder and in a fresh git repo without a remote)
```

What the CLI does (read from the strings in the 2.1.316 bundle, not run end to end): print mode has its own teleport branch (`tengu_teleport_print`): it fetches the cloud session (transcript and branch), validates git state, checks out the session's branch in the working folder's repo (the interactive path offers to stash uncommitted changes first), then runs the prompt on top of the cloud transcript in the same invocation. Not verified with a real cloud session: none was available without creating one on the user's account, and the spike did not do that.

Conclusion: `--teleport` needs no terminal in print mode (`-p --teleport <cse_… | session_… id>`), but failures are silent (exit 1, empty output, reason only via `--debug-file`), it only accepts well-formed `session_…` / `cse_…` ids, and (per the bundle strings) it switches git branches in the cwd's repo, which is the wrong thing to do from DocBro's empty folder; success with a real cloud session is unverified. Use the terminal fallback for v1.

### 7. Not signed in (`CLAUDE_CONFIG_DIR=<empty temp dir>`)

```
echo 'Say hi' | CLAUDE_CONFIG_DIR=/tmp/emptycfg claude -p --output-format stream-json --verbose --include-partial-messages \
    --setting-sources "" --disable-slash-commands --tools "" --model haiku --no-session-persistence --max-turns 12
```

Exit 1, stderr empty, stdout four lines: `init` (still `"apiKeySource":"none"`, `mcp_servers:[]`, so `init` cannot tell signed-in from signed-out), a `status` line, then:

```
{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed","is_api_error_message":true,"session_id":"c888b0ef-…"}
{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","terminal_reason":"api_error","api_error_status":null,"stop_reason":"stop_sequence","num_turns":1,"total_cost_usd":0,"permission_denials":[],"session_id":"c888b0ef-…"}
```

Plain text mode (`-p` without `--output-format`): stdout `Not logged in · Please run /login`, exit 1. The CLI created `.claude.json`, `backups/`, `plugins/`, `projects/`, `sessions/` inside the empty config dir. A usage-limit failure was not triggered; the bundle contains "You've hit your …" / "Usage limit reached" strings, and every run emits a `rate_limit_event` line (`rate_limit_info.status` was `"allowed"`, with `rateLimitType`, `resetsAt` and `unifiedWindows.five_hour|seven_day.utilization`).

Conclusion: detect "not signed in" from `assistant.error == "authentication_failed"`, or `result.is_error == true` with `result` starting `Not logged in` (note `subtype` is `"success"`, so do not key on it); never from stderr (empty) or `init`.

### Consequences for Task 20/21

- Build the command exactly as in the Design, plus `--max-turns 12` (the flag exists in 2.1.316 though `--help` omits it). Treat `result.subtype == "error_max_turns"` (exit 1, text in `errors[0]`) as a readable "stopped after 12 steps" error. Do not feature-detect it by reading `--help`.
- `--allowedTools mcp__docbro mcp__<id> …` works as written, passed as separate argv entries; pass all of them on every message, including `--resume` (the spike did not test whether a session remembers them).
- Parser: text from `stream_event` `text_delta` only (ignore `assistant` text); `tool_start` from the `assistant` `tool_use` block (full `input`), or from `content_block_start` with name only; `tool_end` from `user` `tool_result` matched by `tool_use_id`, text taken from either a string or a list of text blocks, `ok = !is_error`. Ignore `system` subtypes `status`, `thinking_tokens`, `permission_denied`, and `rate_limit_event`. A non-empty `result.permission_denials` with `is_error:false` means a server was missing from `--allowedTools` (a builder bug, not a user error).
- Done/error: `result.is_error:false` is `done`. `result.is_error:true` is `error` using `result` (auth: "Not logged in…") or `errors[0]` (max turns, unknown session). Exit code 1 with no `result` line (e.g. `--session-id` reuse: stderr `Error: Session ID … is already in use.`) is an `error` from the last stderr lines.
- Not signed in: show the "Claude Code is not signed in" message when an `assistant` line has `error:"authentication_failed"` or `result.result` starts with `Not logged in`.
- Sessions: `--session-id <uuid>` on the first message, `--resume <same uuid>` after; pick-and-fork is `--resume <picked> --fork-session`, then use the new `init.session_id` for later messages. Resume works across working folders, so DocBro's own empty cwd is fine; the fork is written under DocBro's cwd project folder.
- Task 21 list: read only top-level `~/.claude/projects/*/*.jsonl`, scan lines until the first real user message (up to ~555 KB deep in the sample), prefer the `ai-title` line for the label, take `cwd` from a line (do not decode the folder name), mtime for recency; expect forks as duplicate-looking entries (consider hiding DocBro's own project folder or de-duplicating by first prompt).
- Teleport: do not run it headless. It has a print-mode path but fails silently (exit 1, empty output), takes only `session_…` / `cse_…` ids, and checks out the session's branch in the cwd's git repo. Task 21 ships the terminal fallback: show `claude --teleport <session id>` with a Copy button (to be run inside the repo the web session worked on), and say the session then appears under "On this Mac". Validate the pasted value as `session_…` or `cse_…` (take the last path segment of a claude.ai/code link; link shape assumed, not tested).
