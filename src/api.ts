import { invoke } from "@tauri-apps/api/core";

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
};
