import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AssistantEngine, AssistantEvent } from "../api";
import { createHeadlessEditor } from "../editor/headless";
import { activity } from "../mcp/activity";
import { AssistantPanel } from "./AssistantPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const notes = {
  id: "notes",
  name: "Notes",
  enabled: true,
  transport: "http",
  summary: "https://notes.example/mcp",
  url: "https://notes.example/mcp",
  command: null,
  args: [],
  secret_keys: [],
  status: "ready",
  tools: 3,
  error: null,
};

const SESSION_ID = "a58cb882-e0af-47a3-abd9-215f026181a6";

let host: HTMLElement;
let root: Root;
let editor: Editor;
let calls: { cmd: string; args: Record<string, unknown> }[];
let configured: boolean;
let engine: AssistantEngine;
let claudeFound: boolean;
let sendFails: string | null;

beforeEach(() => {
  mockWindows("main");
  calls = [];
  configured = true;
  engine = "api_key";
  claudeFound = true;
  sendFails = null;
  localStorage.clear();
  activity.clear();
  mockIPC(
    (cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args });
      switch (cmd) {
        case "assistant_status":
          return {
            configured,
            key_hint: configured ? "c0de" : null,
            model: "claude-sonnet-5-5",
            engine,
            claude_model: "sonnet",
            claude: { found: claudeFound, path: claudeFound ? "/usr/local/bin/claude" : null, version: claudeFound ? "2.1.316" : null },
            openai: { preset: "openai", base_url: "https://api.openai.com/v1", model: "", key_hint: null, configured: false },
          };
        case "claude_sessions":
          return [{ id: SESSION_ID, title: "Plan the <b>launch</b>", project: "web-app", modified: "2026-11-01T09:00:00Z" }];
        case "servers_list":
          return [notes, { ...notes, id: "off", name: "Off one", enabled: false, status: "off", tools: 0 }];
        case "servers_set_enabled":
          return [{ ...notes, enabled: args.enabled }];
        case "assistant_send":
          if (sendFails) throw sendFails;
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  editor = createHeadlessEditor();
  editor.mount(document.createElement("div"));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  host.remove();
  clearMocks();
});

const onSettings = vi.fn();
async function render() {
  await act(async () =>
    root.render(<AssistantPanel editor={editor} settingsOpen={false} onClose={() => {}} onSettings={onSettings} />),
  );
  await vi.waitFor(() => expect(calls.some((c) => c.cmd === "servers_list")).toBe(true));
}
const button = (text: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text);
  if (!found) throw new Error(`no button "${text}" in: ${host.textContent}`);
  return found;
};
const click = (text: string) => act(async () => button(text).click());
const box = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const enter = (shiftKey = false) =>
  act(async () => void box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true, cancelable: true })));
const event = (e: AssistantEvent) => act(async () => void (await emit("assistant-event", e)));
const openServers = () => act(async () => host.querySelector<HTMLButtonElement>("[aria-controls=assistant-servers]")!.click());
const sent = () => calls.filter((c) => c.cmd === "assistant_send").map((c) => c.args);

test("a_message_streams_in_and_stop_returns_to_idle_when_the_answer_ends", async () => {
  await render();
  // a reloaded window starts a fresh conversation, as its chat is empty
  expect(calls.some((c) => c.cmd === "assistant_reset")).toBe(true);
  await type("@docbro Summarize this");
  await enter(true); // Shift+Enter is a new line, not a send
  expect(sent()).toEqual([]);
  await enter();
  expect(sent()).toEqual([{ text: "Summarize this", context: null, only: "docbro", excludeBuiltin: false }]);
  expect(box().value).toBe("");
  expect(host.textContent).toContain("Working…");
  await event({ type: "tool_start", id: "t1", server: "docbro", name: "read_document", args: "{}" });
  expect(host.textContent).toContain("DocBro Docs · read_document");
  expect(host.textContent).toContain("Running…");
  await event({ type: "tool_end", id: "t1", ok: true, text: "[1] Hi" });
  await event({ type: "text", delta: "Three points." });
  expect(host.textContent).toContain("✓ Done");
  expect(host.textContent).toContain("Three points.");
  await click("Stop");
  expect(calls.some((c) => c.cmd === "assistant_cancel")).toBe(true);
  await event({ type: "done" });
  expect(button("Send")).toBeTruthy();
  expect(button("Insert into doc")).toBeTruthy();
});

test("a_send_that_fails_shows_why_and_the_chat_is_idle_again", async () => {
  sendFails = "The assistant is still answering. Stop it first.";
  await render();
  await type("Hello");
  await enter();
  await vi.waitFor(() => expect(host.textContent).toContain("The assistant is still answering. Stop it first."));
  expect(button("Send")).toBeTruthy();
});

test("an_error_event_shows_under_the_answer_as_text", async () => {
  await render();
  await type("Hello");
  await enter();
  await event({ type: "text", delta: "Part" });
  await event({ type: "error", message: "The API key was rejected. <i>Check</i> it in MCP settings." });
  expect(host.textContent).toContain("The API key was rejected. <i>Check</i> it in MCP settings.");
  expect(host.querySelector("i")).toBeNull();
  expect(button("Send")).toBeTruthy();
});

test("the_built_in_server_switched_off_is_left_out_of_the_next_message", async () => {
  await render();
  expect(host.textContent).toContain("2 of 3 on");
  await openServers();
  await click("DocBro Docs");
  expect(localStorage.getItem("docbro-builtin")).toBe("off");
  expect(host.textContent).toContain("1 of 3 on");
  await type("Find the plan");
  await enter();
  expect(sent()).toEqual([{ text: "Find the plan", context: null, only: null, excludeBuiltin: true }]);
});

test("a_user_server_switch_turns_it_on_or_off_in_rust", async () => {
  await render();
  await openServers();
  await click("Notes");
  expect(calls.find((c) => c.cmd === "servers_set_enabled")?.args).toEqual({ id: "notes", enabled: false });
});

test("the_selection_goes_with_the_next_message_once", async () => {
  editor.commands.setContent("<p>Pick these words please</p>");
  editor.commands.setTextSelection({ from: 6, to: 17 });
  await render();
  await click("+ Selection");
  expect(host.textContent).toContain("“these words”");
  await type("Rewrite it");
  await enter();
  expect(sent()[0]).toMatchObject({ text: "Rewrite it", context: "these words" });
  expect(host.textContent).not.toContain("“these words”");
});

test("typing_an_at_sign_offers_the_servers_that_are_on", async () => {
  await render();
  await type("@");
  const options = [...host.querySelectorAll("[role=option]")].map((o) => o.textContent);
  expect(options).toEqual(["@docbroDocBro Docs", "@notesNotes"]);
  await act(async () => (host.querySelectorAll<HTMLElement>("[role=option]")[1]).click());
  expect(box().value).toBe("@notes ");
});

test("without_an_api_key_the_composer_points_to_the_settings", async () => {
  configured = false;
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Add your Anthropic API key to start chatting."));
  expect(host.querySelector("textarea")).toBeNull();
});

test("new_clears_the_chat_and_the_conversation_in_rust", async () => {
  await render();
  await type("Hello");
  await enter();
  await event({ type: "done" });
  const resets = calls.filter((c) => c.cmd === "assistant_reset").length;
  await click("New");
  expect(calls.filter((c) => c.cmd === "assistant_reset").length).toBe(resets + 1);
  expect(host.textContent).not.toContain("Hello");
  expect(host.textContent).toContain("Summarize this document in three bullets");
});

test("a_suggestion_sends_itself", async () => {
  await render();
  await click("@docbroSummarize this document in three bullets");
  expect(sent()).toEqual([{ text: "Summarize this document in three bullets", context: null, only: "docbro", excludeBuiltin: false }]);
});

test("claude_code_not_found_says_to_install_it_or_switch", async () => {
  engine = "claude_code";
  claudeFound = false;
  configured = false;
  await render();
  await vi.waitFor(() =>
    expect(host.textContent).toContain("Claude Code was not found. Install it from claude.com/code, or switch to an API key in MCP settings."),
  );
  expect(host.querySelector("textarea")).toBeNull();
});

test("a_provider_not_set_up_says_to_finish_its_settings", async () => {
  engine = "openai_compatible";
  configured = false;
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Finish the other provider's settings to start chatting."));
  expect(host.querySelector("textarea")).toBeNull();
});

test("claude_code_found_needs_no_key_to_chat", async () => {
  engine = "claude_code";
  configured = true;
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Continue a Claude Code session…"));
  expect(host.querySelector("textarea")).not.toBeNull();
});

test("continue_a_session_is_offered_with_claude_code_only", async () => {
  await render();
  await vi.waitFor(() => expect(calls.some((c) => c.cmd === "assistant_status")).toBe(true));
  expect(host.textContent).not.toContain("Continue a Claude Code session…");
});

test("continuing_a_session_starts_afresh_in_a_copy_and_says_so_until_new", async () => {
  engine = "claude_code";
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Continue a Claude Code session…"));
  await type("Hello");
  await enter();
  await event({ type: "done" });
  await click("New");
  await click("Continue a Claude Code session…");
  await vi.waitFor(() => expect(host.querySelector(".session-row")).not.toBeNull());
  const resets = calls.filter((c) => c.cmd === "assistant_reset").length;
  await act(async () => host.querySelector<HTMLButtonElement>(".session-row")!.click());
  await vi.waitFor(() => expect(host.textContent).toContain("Continuing “Plan the <b>launch</b>”"));
  expect(host.querySelector(".continuing b")).toBeNull();
  // the sheet is closed, the panel's chat is new, and the next message goes on in a copy
  expect(host.querySelector(".session-row")).toBeNull();
  const after = calls.map((c) => c.cmd).slice(calls.findIndex((c, i) => c.cmd === "assistant_reset" && calls.slice(0, i).filter((x) => x.cmd === "assistant_reset").length === resets));
  expect(after.filter((c) => c === "assistant_reset" || c === "assistant_continue")).toEqual(["assistant_reset", "assistant_continue"]);
  expect(calls.find((c) => c.cmd === "assistant_continue")!.args).toEqual({ sessionId: SESSION_ID });
  await type("Go on");
  await enter();
  expect(host.textContent).toContain("Continuing “Plan the <b>launch</b>”");
  await event({ type: "done" });
  await click("New");
  expect(host.textContent).not.toContain("Continuing");
});
