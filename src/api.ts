import { invoke } from "@tauri-apps/api/core";

/** How DocBro reaches one of the user's MCP servers. Header and env values are secrets. */
export type ServerSpec =
  | { transport: "http"; url: string; headers?: Record<string, string> }
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

/**
 * A server as saved. `id` is lowercase `[a-z0-9_-]` (no `__`, at most 32 characters, not
 * `docbro`). When editing a saved server, an empty header or env value keeps the saved one, but
 * only while the URL's origin (scheme, host, port) or the command stays the same.
 */
export interface ServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  spec: ServerSpec;
}

/** What the webview may know about a server: the names of its secrets, never their values. */
export interface ServerView {
  id: string;
  name: string;
  enabled: boolean;
  transport: "http" | "stdio";
  /** the URL, or the command line that runs */
  summary: string;
  /** what the edit form is filled with: the URL of an HTTP server, the command and arguments of a stdio one */
  url: string | null;
  command: string | null;
  args: string[];
  /** header or env names */
  secret_keys: string[];
  status: "off" | "ready" | "error";
  tools: number;
  /** text the server or its connection sent: show it as plain text */
  error: string | null;
}

/** DocBro's own MCP server, which external AI clients connect to. */
export interface McpStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  /** `http://127.0.0.1:<port>/mcp` */
  url: string;
  token: string;
  /** this app's executable; stdio clients run it with `--mcp-stdio` */
  command: string;
  error: string | null;
}

/**
 * Who answers: the user's Claude Code CLI on their Claude subscription, the Anthropic API with
 * their key, or another provider through an OpenAI-compatible API.
 */
export type AssistantEngine = "claude_code" | "api_key" | "openai_compatible";

/**
 * The other provider's form before it is saved, for `assistantListModels`. `api_key` null (or
 * left out) uses the saved key, but only when `base_url` has the saved base URL's origin.
 */
export interface ProviderDraft {
  preset: string;
  base_url: string;
  api_key?: string | null;
}

/** A provider the settings offer (`assistantPresets`); its base URL fills the form and stays editable. */
export interface ProviderPreset {
  /** `openai`, `openrouter`, `gemini`, `groq`, `deepseek`, `mistral`, `ollama`, `lmstudio` or `custom` */
  id: string;
  /** what messages call the provider, e.g. "Ollama" */
  name: string;
  /** what the picker shows, e.g. "Ollama (on this computer)" */
  label: string;
  /** empty for Custom */
  base_url: string;
  key_required: boolean;
}

/**
 * The other provider's settings as the webview may know them: the key's last four characters,
 * never the key.
 */
export interface OpenAiStatus {
  /** a `ProviderPreset` id */
  preset: string;
  base_url: string;
  /** empty until the user picks one */
  model: string;
  key_hint: string | null;
  /** the base URL is valid, a model is set, and a key is saved if the preset needs one */
  configured: boolean;
}

/** The `claude` DocBro found. `version` is what `claude --version` said, e.g. "2.1.316". */
export interface ClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
}

/** The Assistant's settings as the webview may know them: the API key's last four characters, never the key. */
export interface AssistantStatus {
  /** the engine picked has what it needs: a saved key, a `claude` that was found, or a ready provider */
  configured: boolean;
  key_hint: string | null;
  /** the API's model */
  model: string;
  /** the engine picked; until the user picks one, Claude Code when it is found and no key is saved */
  engine: AssistantEngine;
  /** Claude Code's model: a CLI alias (`sonnet`, `opus`, `haiku`) or a full name */
  claude_model: string;
  claude: ClaudeStatus;
  openai: OpenAiStatus;
}

/** A Claude Code session on this Mac, for "Continue a Claude Code session". Newest first. */
export interface ClaudeSession {
  id: string;
  /** its title, or else its first message, cut to 80 characters */
  title: string;
  /** the folder it ran in */
  project: string;
  /** ISO 8601, UTC */
  modified: string;
}

/** A session from Claude Code on the web: DocBro never brings it over itself; the user runs `command` once in Terminal. */
export interface TeleportOutcome {
  needs_terminal: boolean;
  command: string;
}

/**
 * The `assistant-event` Rust sends to the window that asked. `args` is the tool's arguments as
 * JSON cut to 200 characters, `text` its answer cut to 400. A message ends with `done` or `error`.
 */
export type AssistantEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; server: string; name: string; args: string }
  | { type: "tool_end"; id: string; ok: boolean; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Wrappers for the Rust commands, so no other file spells a command name or its arguments. */
export const api = {
  /** Rejects with "Not found" when the file does not exist. */
  readFile: async (path: string): Promise<Uint8Array> =>
    new Uint8Array(await invoke<ArrayBuffer>("read_file", { path })),
  /** Replaces the file in one step, so a failed save never leaves half a file. */
  writeFile: (path: string, bytes: Uint8Array) =>
    invoke<void>("write_file", bytes, { headers: { "x-path": encodeURIComponent(path) } }),
  fileExists: (path: string) => invoke<boolean>("file_exists", { path }),
  /**
   * Tells the shell what this window shows. `blank` is the empty document a window starts
   * with: while it is untouched, a file opened from Finder replaces it.
   */
  setDocMeta: (path: string | null, dirty: boolean, blank: boolean) =>
    invoke<void>("set_doc_meta", { path, dirty, blank }),
  /** Files waiting for this window, handed over once. */
  takePendingOpen: () => invoke<string[]>("take_pending_open"),
  /**
   * Opens another window, empty or showing `path`, or focuses the window that has `path` open.
   * With `here`, true means this window should load `path` itself.
   */
  openInWindow: (path: string | null, here = false) =>
    invoke<boolean>("open_in_window", { path, here }),
  /** The editor is mounted and can run `mcp-call` requests. */
  editorReady: () => invoke<void>("editor_ready"),
  /** The answer to the `mcp-call` with this id; `ok` false makes `text` an error the AI reads. */
  mcpReply: (id: number, ok: boolean, text: string) => invoke<void>("mcp_reply", { id, ok, text }),
  mcpStatus: () => invoke<McpStatus>("mcp_status"),
  /** Starts the server on `port` (the saved one when left out), or stops it. Rejects with a readable error. */
  mcpSetEnabled: (enabled: boolean, port?: number) => invoke<McpStatus>("mcp_set_enabled", { enabled, port }),
  /** Locks out every client that has the old token. */
  mcpRegenerateToken: () => invoke<McpStatus>("mcp_regenerate_token"),
  /** The user's MCP servers for the Assistant. */
  serversList: () => invoke<ServerView[]>("servers_list"),
  /** Adds the server, or replaces the one with its id (which then restarts on next use). */
  serversSave: (config: ServerConfig) => invoke<ServerView[]>("servers_save", { config }),
  serversRemove: (id: string) => invoke<ServerView[]>("servers_remove", { id }),
  /** Switching a server on connects to it at once; a failure shows in its status. */
  serversSetEnabled: (id: string, enabled: boolean) =>
    invoke<ServerView[]>("servers_set_enabled", { id, enabled }),
  /** Connects without saving; resolves to the server's tool names. */
  serversTest: (config: ServerConfig) => invoke<string[]>("servers_test", { config }),
  assistantStatus: () => invoke<AssistantStatus>("assistant_status"),
  /**
   * `apiKey` is the Anthropic key; null keeps the saved one. Without `engine` the engine stays and
   * `model` is the API's; with it, `engine` is picked and `model` is that engine's. Rejects when
   * `model` is empty (or, for Claude Code, not a plain model name), and rejects any `apiKey` with
   * `openai_compatible`: the provider's key is saved with `assistantSaveOpenai`.
   */
  assistantSave: (apiKey: string | null, model: string, engine?: AssistantEngine) =>
    invoke<AssistantStatus>("assistant_save", engine ? { apiKey, model, engine } : { apiKey, model }),
  /** Removes the Anthropic key, or with `openai_compatible` the other provider's key. */
  assistantClearKey: (engine?: AssistantEngine) =>
    invoke<AssistantStatus>("assistant_clear_key", engine ? { engine } : undefined),
  /**
   * Saves the other provider's settings and picks that engine. An empty `baseUrl` is the preset's;
   * plain http is refused except for this computer. `apiKey` null keeps the saved key, but only
   * while the base URL's origin (scheme, host, port) stays the same: otherwise it is dropped, and
   * the form says "The saved key is not sent to a different server. Enter it again." `model` may
   * stay empty until the models are loaded.
   */
  assistantSaveOpenai: (preset: string, baseUrl: string, model: string, apiKey: string | null) =>
    invoke<AssistantStatus>("assistant_save_openai", { preset, baseUrl, model, apiKey }),
  /**
   * The provider's models, sorted: the saved provider's, or with `draft` the form's, unsaved (saves
   * nothing and keeps the engine). Rejects with a readable error.
   */
  assistantListModels: (draft?: ProviderDraft) =>
    invoke<string[]>("assistant_list_models", draft ? { draft } : undefined),
  /** The providers the settings offer, in their order; the last is Custom. */
  assistantPresets: () => invoke<ProviderPreset[]>("assistant_presets"),
  /**
   * Resolves at once; the answer comes as `assistant-event`s to this window. `context` is the
   * selected text, `only` the server id of an @mention, `excludeBuiltin` true when the built-in
   * document server is switched off. Rejects while this window's chat is still answering, or
   * when no API key is saved.
   */
  assistantSend: (text: string, context: string | null, only: string | null, excludeBuiltin: boolean) =>
    invoke<void>("assistant_send", { text, context, only, excludeBuiltin }),
  /** Stops the answer; it still ends with `done`. */
  assistantCancel: () => invoke<void>("assistant_cancel"),
  /** Drops this window's conversation and stops its answer, which then sends nothing more. */
  assistantReset: () => invoke<void>("assistant_reset"),
  /** Recent Claude Code sessions on this Mac, newest first, at most 50. Read only. */
  claudeSessions: () => invoke<ClaudeSession[]>("claude_sessions"),
  /**
   * Claude Code: this window's next message goes on in a copy of the session, which itself stays
   * as it was. Rejects while the chat is answering, or for an id that is not a plain session id.
   */
  assistantContinue: (sessionId: string) => invoke<void>("assistant_continue", { sessionId }),
  /** Reads a claude.ai/code link or a session id; rejects when it holds no plain session id. */
  assistantTeleport: (input: string) => invoke<TeleportOutcome>("assistant_teleport", { input }),
};
