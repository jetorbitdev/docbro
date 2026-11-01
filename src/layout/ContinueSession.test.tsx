import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ClaudeSession } from "../api";
import { ago, ContinueSession } from "./ContinueSession";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-01T12:00:00Z");
const SESSIONS: ClaudeSession[] = [
  { id: "a58cb882-e0af-47a3-abd9-215f026181a6", title: "Fix the <b>login</b> page", project: "web-app", modified: "2026-11-01T09:00:00Z" },
  { id: "3f1a5169-0000-4000-8000-000000000002", title: "Write release notes", project: "docbro", modified: "2026-10-29T12:00:00Z" },
];

let host: HTMLElement;
let root: Root;
let calls: { cmd: string; args: Record<string, unknown> }[];
let sessions: ClaudeSession[] | string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  calls = [];
  sessions = SESSIONS;
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "claude_sessions":
        if (typeof sessions === "string") throw sessions;
        return sessions;
      case "assistant_teleport":
        if (!String(args.input).includes("session_")) throw "Paste the link of a Claude Code session on the web, or its id.";
        return { needs_terminal: true, command: "claude --teleport session_01ABCDEFGHJKMNPQRSTUVWXY" };
      case "plugin:clipboard-manager|write_text":
        return null;
    }
  });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearMocks();
  vi.useRealTimers();
});

const onContinue = vi.fn<(s: ClaudeSession) => Promise<void>>();
const onClose = vi.fn();

async function render() {
  await act(async () => root.render(<ContinueSession onContinue={onContinue} onClose={onClose} />));
}
const button = (text: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in: ${host.textContent}`);
  return found;
};
const click = (text: string) => act(async () => button(text).click());
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("on_this_mac_lists_title_project_and_when_with_titles_as_text", async () => {
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Write release notes"));
  const rows = [...host.querySelectorAll(".session-row")].map((r) => r.textContent);
  expect(rows).toEqual(["Fix the <b>login</b> pageweb-app · 3 hours ago", "Write release notesdocbro · 3 days ago"]);
  expect(host.querySelector(".session-row b")).toBeNull();
});

test("choosing_a_session_hands_it_over", async () => {
  onContinue.mockResolvedValueOnce();
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Write release notes"));
  await act(async () => host.querySelectorAll<HTMLButtonElement>(".session-row")[1].click());
  expect(onContinue).toHaveBeenCalledWith(SESSIONS[1]);
});

test("a_session_that_cannot_be_continued_says_why", async () => {
  onContinue.mockRejectedValueOnce("The assistant is still answering. Stop it first.");
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Write release notes"));
  await act(async () => host.querySelectorAll<HTMLButtonElement>(".session-row")[0].click());
  await vi.waitFor(() => expect(host.textContent).toContain("The assistant is still answering. Stop it first."));
});

test("no_sessions_says_so", async () => {
  sessions = [];
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("No Claude Code sessions on this Mac yet."));
});

test("from_the_web_shows_the_command_to_run_in_terminal_with_copy", async () => {
  await render();
  await click("From the web");
  const input = host.querySelector<HTMLInputElement>('[aria-label="Session link or id"]')!;
  await type(input, "https://claude.ai/code/session_01ABCDEFGHJKMNPQRSTUVWXY");
  await click("Get the command");
  expect(calls.find((c) => c.cmd === "assistant_teleport")!.args).toEqual({ input: "https://claude.ai/code/session_01ABCDEFGHJKMNPQRSTUVWXY" });
  await vi.waitFor(() => expect(host.querySelector("code")?.textContent).toBe("claude --teleport session_01ABCDEFGHJKMNPQRSTUVWXY"));
  expect(host.textContent).toContain(
    "Run this once in Terminal, in the session's repository folder, then pick the session under On this Mac.",
  );
  await click("Copy");
  expect(calls.find((c) => c.cmd === "plugin:clipboard-manager|write_text")!.args).toMatchObject({
    text: "claude --teleport session_01ABCDEFGHJKMNPQRSTUVWXY",
  });
  expect(button("Copied")).toBeTruthy();
});

test("a_link_without_a_session_says_why", async () => {
  await render();
  await click("From the web");
  await type(host.querySelector<HTMLInputElement>('[aria-label="Session link or id"]')!, "https://example.com/<i>x</i>");
  await click("Get the command");
  await vi.waitFor(() => expect(host.textContent).toContain("Paste the link of a Claude Code session on the web, or its id."));
  expect(host.querySelector("code")).toBeNull();
});

test("escape_closes_the_sheet", async () => {
  await render();
  await act(async () => void host.querySelector(".mcp-sheet")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onClose).toHaveBeenCalled();
});

test.each([
  ["2026-11-01T11:59:40Z", "just now"],
  ["2026-11-01T11:59:00Z", "1 minute ago"],
  ["2026-11-01T11:15:00Z", "45 minutes ago"],
  ["2026-11-01T11:00:00Z", "1 hour ago"],
  ["2026-10-31T10:00:00Z", "yesterday"],
  ["2026-10-25T12:00:00Z", "7 days ago"],
])("ago(%s)", (iso, want) => {
  expect(ago(iso, NOW)).toBe(want);
});

test("ago_of_an_older_or_broken_time", () => {
  expect(ago("2026-08-01T12:00:00Z", NOW)).toBe(new Date("2026-08-01T12:00:00Z").toLocaleDateString());
  expect(ago("not a time", NOW)).toBe("");
});
