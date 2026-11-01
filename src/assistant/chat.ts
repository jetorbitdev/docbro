/**
 * The Assistant's chat as plain data: the messages, and how each `assistant-event` from Rust
 * changes them. The panel keeps a `ChatState` and runs every event through `reduceChat`.
 */
import type { AssistantEvent } from "../api";

export type ChatEvent = AssistantEvent;

export interface ToolCard {
  id: string;
  /** the server id: `docbro` for the document's own tools */
  server: string;
  name: string;
  /** the arguments as JSON, cut by Rust to 200 characters */
  args: string;
  state: "running" | "done" | "error";
  /** the tool's answer, or why it failed */
  text?: string;
}

/** `id` is when the message was sent (Unix ms), so external tool calls can be put between messages by time. */
export type Msg =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "bot"; text: string; tools: ToolCard[]; error?: string };

export interface ChatState {
  msgs: Msg[];
  /** an answer is on its way: it ends with `done` or `error` */
  busy: boolean;
}

export const emptyChat: ChatState = { msgs: [], busy: false };

/** Adds the user's message (`id`) and the empty answer that the events fill (`id + 1`). */
export function sendUser(s: ChatState, id: number, text: string): ChatState {
  return { msgs: [...s.msgs, { id, role: "user", text }, { id: id + 1, role: "bot", text: "", tools: [] }], busy: true };
}

/** Applies the event to the last bot message. Events that come when no answer is on its way change nothing. */
export function reduceChat(s: ChatState, e: ChatEvent): ChatState {
  const bot = s.msgs[s.msgs.length - 1];
  if (!s.busy || bot?.role !== "bot") return s;
  const put = (next: Partial<Extract<Msg, { role: "bot" }>>, busy = true): ChatState => ({
    msgs: [...s.msgs.slice(0, -1), { ...bot, ...next }],
    busy,
  });
  switch (e.type) {
    case "text":
      return put({ text: bot.text + e.delta });
    case "tool_start":
      return put({ tools: [...bot.tools, { id: e.id, server: e.server, name: e.name, args: e.args, state: "running" }] });
    case "tool_end":
      return put({
        tools: bot.tools.map((t) => (t.id === e.id ? { ...t, state: e.ok ? "done" : "error", text: e.text } : t)),
      });
    case "done":
      return { ...s, busy: false };
    case "error":
      return put({ error: e.message }, false);
  }
}

/**
 * A leading `@id ` (a known server, `docbro` included) picks the server whose tools the message
 * may use, and is taken out of the text. Anything else, an unknown `@word` too, stays as typed.
 */
export function parseMention(text: string, serverIds: string[]): { text: string; only: string | null } {
  const m = /^@([a-z0-9_-]+)\s+/.exec(text);
  if (!m || !serverIds.includes(m[1])) return { text, only: null };
  return { text: text.slice(m[0].length), only: m[1] };
}
