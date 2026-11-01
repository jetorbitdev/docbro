import { expect, test } from "vitest";
import { emptyChat, parseMention, reduceChat, sendUser, type ChatEvent, type ChatState, type Msg } from "./chat";

const run = (s: ChatState, ...events: ChatEvent[]) => events.reduce(reduceChat, s);
const last = (s: ChatState) => s.msgs[s.msgs.length - 1] as Extract<Msg, { role: "bot" }>;

test("text_deltas_append_to_the_last_bot_message", () => {
  let s = sendUser(emptyChat, 10, "Summarize");
  expect(s.busy).toBe(true);
  expect(s.msgs).toEqual([
    { id: 10, role: "user", text: "Summarize" },
    { id: 11, role: "bot", text: "", tools: [] },
  ]);
  s = run(s, { type: "text", delta: "Three " }, { type: "text", delta: "points." });
  expect(last(s).text).toBe("Three points.");
  // the user's message is left as it was
  expect(s.msgs[0]).toEqual({ id: 10, role: "user", text: "Summarize" });
});

test("a_tool_start_then_end_updates_the_same_card", () => {
  let s = sendUser(emptyChat, 1, "Read it");
  s = run(
    s,
    { type: "tool_start", id: "t1", server: "docbro", name: "read_document", args: "{}" },
    { type: "tool_start", id: "t2", server: "notes", name: "search", args: '{"q":"x"}' },
  );
  expect(last(s).tools.map((t) => t.state)).toEqual(["running", "running"]);
  s = run(s, { type: "tool_end", id: "t1", ok: true, text: "[1] Hello" }, { type: "tool_end", id: "t2", ok: false, text: "Not found" });
  expect(last(s).tools).toEqual([
    { id: "t1", server: "docbro", name: "read_document", args: "{}", state: "done", text: "[1] Hello" },
    { id: "t2", server: "notes", name: "search", args: '{"q":"x"}', state: "error", text: "Not found" },
  ]);
  expect(s.busy).toBe(true);
});

test("an_error_event_keeps_partial_text_and_stops_busy", () => {
  let s = sendUser(emptyChat, 1, "Hi");
  s = run(s, { type: "text", delta: "Half an ans" }, { type: "error", message: "The connection to the Anthropic API broke off." });
  expect(s.busy).toBe(false);
  expect(last(s)).toMatchObject({ text: "Half an ans", error: "The connection to the Anthropic API broke off." });
});

test("done_clears_busy_and_a_new_message_can_be_sent", () => {
  let s = run(sendUser(emptyChat, 1, "One"), { type: "text", delta: "First." }, { type: "done" });
  expect(s.busy).toBe(false);
  s = run(sendUser(s, 3, "Two"), { type: "text", delta: "Second." });
  expect(s.msgs.map((m) => m.text)).toEqual(["One", "First.", "Two", "Second."]);
  expect(s.busy).toBe(true);
});

test("events_after_the_answer_ended_change_nothing", () => {
  // a chat that was cleared with New, or an answer that already ended
  const s = run(sendUser(emptyChat, 1, "One"), { type: "done" });
  expect(run(s, { type: "text", delta: "late" }, { type: "error", message: "late" })).toBe(s);
  expect(reduceChat(emptyChat, { type: "text", delta: "late" })).toBe(emptyChat);
});

test.each([
  ["@docbro summarize", ["docbro", "notes"], { text: "summarize", only: "docbro" }],
  ["@nobody hi", ["docbro"], { text: "@nobody hi", only: null }],
  ["mail me @docbro", ["docbro"], { text: "mail me @docbro", only: null }],
  ["@notes\nfind the plan", ["docbro", "notes"], { text: "find the plan", only: "notes" }],
  ["@docbro", ["docbro"], { text: "@docbro", only: null }],
] as const)("parseMention(%j)", (t, ids, want) => {
  expect(parseMention(t, [...ids])).toEqual(want);
});
