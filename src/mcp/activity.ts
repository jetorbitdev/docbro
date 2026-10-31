/**
 * The tool calls AI clients made in this window, newest last, for the Assistant panel. A plain
 * store outside React: the bridge writes to it, the panel reads it with `useSyncExternalStore`.
 */

export interface ActivityEntry {
  id: number;
  tool: string;
  /** the arguments as JSON, cut to `MAX_ARGS` characters */
  args: string;
  state: "running" | "done" | "error";
  /** the tool's answer, or why it failed */
  message?: string;
  /** when the call came in, Unix ms */
  at: number;
}

const KEEP = 50;
const MAX_ARGS = 200;

const cut = (text: string) => (text.length > MAX_ARGS ? `${text.slice(0, MAX_ARGS - 1)}…` : text);

let entries: ActivityEntry[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

// every change makes a new array, so a snapshot taken before it stays as it was
function set(next: ActivityEntry[]) {
  entries = next;
  listeners.forEach((fn) => fn());
}

export const activity = {
  list: (): ActivityEntry[] => entries,

  /** Records a call that starts now; returns its id for `finish`. */
  begin(tool: string, args: unknown): number {
    const id = ++nextId;
    const entry: ActivityEntry = { id, tool, args: cut(JSON.stringify(args ?? {}) ?? ""), state: "running", at: Date.now() };
    set([...entries, entry].slice(-KEEP));
    return id;
  },

  /** A call that was cleared away or pushed out meanwhile is not brought back. */
  finish(id: number, ok: boolean, message: string): void {
    if (!entries.some((e) => e.id === id)) return;
    set(entries.map((e) => (e.id === id ? { ...e, state: ok ? "done" : "error", message } : e)));
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },

  clear(): void {
    set([]);
  },
};
