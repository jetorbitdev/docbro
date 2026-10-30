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
};
