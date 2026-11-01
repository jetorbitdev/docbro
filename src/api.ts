import { invoke } from "@tauri-apps/api/core";

/** How DocBro reaches one of the user's MCP servers. Header and env values are secrets. */
export type ServerSpec =
  | { transport: "http"; url: string; headers?: Record<string, string> }
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

/**
 * A server as saved. `id` is lowercase `[a-z0-9_-]` (no `__`, at most 32 characters, not
 * `docbro`). When editing a saved server, an empty header or env value keeps the saved one.
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
  /** header or env names */
  secret_keys: string[];
  status: "off" | "ready" | "error";
  tools: number;
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

/** The Assistant's settings as the webview may know them: the API key's last four characters, never the key. */
export interface AssistantStatus {
  configured: boolean;
  key_hint: string | null;
  model: string;
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
  /** `apiKey` null keeps the saved key. Rejects when `model` is empty. */
  assistantSave: (apiKey: string | null, model: string) =>
    invoke<AssistantStatus>("assistant_save", { apiKey, model }),
  assistantClearKey: () => invoke<AssistantStatus>("assistant_clear_key"),
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
};
