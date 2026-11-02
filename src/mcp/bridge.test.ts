import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DocSession, type SessionIO } from "../doc/session";
import { createHeadlessEditor } from "../editor/headless";
import { activity } from "./activity";
import { startBridge } from "./bridge";
import type { ToolContext } from "./tools";

/** Files in memory; a read waits while `hold` is set, so a tool that opens a file is slow. */
class SlowIO implements SessionIO {
  files = new Map<string, Uint8Array>();
  hold: Promise<void> | null = null;
  async read(path: string) {
    if (this.hold) await this.hold;
    const bytes = this.files.get(path);
    if (!bytes) throw new Error("Not found");
    return bytes;
  }
  async write(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  meta() {}
}

interface Reply {
  id: number;
  ok: boolean;
  text: string;
}

let editor: Editor;
let io: SlowIO;
let session: DocSession;
let replies: Reply[];
let stop: (() => void) | undefined;
const ctx = (): ToolContext => ({ editor, session });
const later = () => Date.now() + 30_000;
const call = (id: number, name: string, args: unknown = {}, deadline = later(), origin = "external") =>
  emit("mcp-call", { id, name, args, deadline, origin });
const answered = (n: number) => vi.waitFor(() => expect(replies).toHaveLength(n));

beforeEach(() => {
  mockWindows("main");
  replies = [];
  mockIPC(
    (cmd, payload) => {
      if (cmd === "mcp_reply") replies.push(payload as unknown as Reply);
    },
    { shouldMockEvents: true },
  );
  editor = createHeadlessEditor();
  editor.mount(document.createElement("div"));
  io = new SlowIO();
  session = new DocSession(editor, io);
  activity.clear();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  session.destroy();
  editor.destroy();
  clearMocks();
});

test("answers_each_call_with_mcp_reply", async () => {
  stop = await startBridge(ctx);
  await call(1, "insert_content", { markdown: "# Ringkasan" });
  await call(2, "nope");
  await answered(2);
  expect(replies[0]).toMatchObject({ id: 1, ok: true });
  expect(replies[1]).toEqual({ id: 2, ok: false, text: "Unknown tool: nope" });
  expect(editor.getText().trim()).toBe("Ringkasan");
});

test("runs_calls_one_at_a_time_in_order", async () => {
  io.files.set("/d/a.md", new TextEncoder().encode("# Opened\n\nFrom disk."));
  let release!: () => void;
  io.hold = new Promise((r) => (release = r));
  stop = await startBridge(ctx);
  await call(1, "open_document", { path: "/d/a.md" });
  await call(2, "document_info");
  // the second call waits for the slow first one instead of running beside it
  await new Promise((r) => setTimeout(r, 20));
  expect(replies).toEqual([]);
  release();
  await answered(2);
  expect(replies.map((r) => r.id)).toEqual([1, 2]);
  expect(replies[0].text).toBe("Opened a.md (2 blocks).");
  expect(JSON.parse(replies[1].text)).toMatchObject({ name: "a.md", blocks: 2 });
});

test("a_throwing_tool_still_answers", async () => {
  // the editor is gone, so building the tool's context throws
  stop = await startBridge(() => {
    throw new Error("The editor is not ready.");
  });
  await call(1, "document_info");
  await call(2, "document_info");
  await answered(2);
  expect(replies).toEqual([
    { id: 1, ok: false, text: "The editor is not ready." },
    { id: 2, ok: false, text: "The editor is not ready." },
  ]);
});

test("refuses_a_call_whose_deadline_has_passed", async () => {
  stop = await startBridge(ctx);
  await call(1, "insert_content", { markdown: "Too late" }, Date.now() - 1);
  await call(2, "document_info");
  await answered(2);
  expect(replies[0]).toEqual({ id: 1, ok: false, text: "The call expired before DocBro could run it." });
  expect(replies[1]).toMatchObject({ id: 2, ok: true });
  // never applied
  expect(editor.getText().trim()).toBe("");
});

test("records_every_call_in_the_activity_feed", async () => {
  stop = await startBridge(ctx);
  await call(1, "insert_content", { markdown: "Hello" });
  await call(2, "delete_blocks", { from: 9 });
  await answered(2);
  expect(activity.list()).toMatchObject([
    { tool: "insert_content", args: '{"markdown":"Hello"}', state: "done" },
    { tool: "delete_blocks", args: '{"from":9}', state: "error", message: replies[1].text },
  ]);
});

test("the_assistants_own_calls_run_but_stay_out_of_the_activity_feed", async () => {
  stop = await startBridge(ctx);
  // the chat shows these as its own tool cards
  await call(1, "insert_content", { markdown: "From the chat" }, later(), "assistant");
  await call(2, "document_info");
  await answered(2);
  expect(replies[0]).toMatchObject({ id: 1, ok: true });
  expect(editor.getText().trim()).toBe("From the chat");
  expect(activity.list()).toMatchObject([{ tool: "document_info", state: "done" }]);
});

test("tells_the_tools_who_made_the_call", async () => {
  stop = await startBridge(ctx);
  editor.commands.setContent("<p>Unsaved</p>");
  io.files.set("/d/a.md", new TextEncoder().encode("# A"));
  await call(1, "open_document", { path: "/d/a.md", discard: true }, later(), "assistant");
  await call(2, "open_document", { path: "/d/a.md", discard: true });
  await answered(2);
  expect(replies[0]).toEqual({ id: 1, ok: false, text: "The assistant can't discard unsaved changes. Ask the user to open the file." });
  expect(replies[1]).toEqual({ id: 2, ok: true, text: "Opened a.md (2 blocks)." });
});

test("stops_listening_when_unlistened", async () => {
  const unlisten = await startBridge(ctx);
  unlisten();
  await call(1, "document_info");
  await new Promise((r) => setTimeout(r, 20));
  expect(replies).toEqual([]);
  expect(activity.list()).toEqual([]);
});
