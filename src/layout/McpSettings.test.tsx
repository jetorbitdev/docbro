import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ServerConfig } from "../api";
import { McpSettings } from "./McpSettings";
import { commandLine, splitArgs } from "./ServerForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// What the webview could be sent by mistake: none of it may ever reach the page.
const KEY = "sk-ant-api03-SECRET-c0de";
const HEADER = "Bearer tok-SECRET-1234";

const sheetbro = {
  id: "sheetbro",
  name: "SheetBro",
  enabled: true,
  transport: "http",
  summary: "http://127.0.0.1:7424/mcp",
  url: "http://127.0.0.1:7424/mcp",
  command: null,
  args: [],
  secret_keys: ["Authorization"],
  status: "error",
  tools: 0,
  error: "<b>401</b> Unauthorized",
  // fields the real ServerView does not have
  headers: { Authorization: HEADER },
};

let host: HTMLElement;
let root: Root;
let calls: { cmd: string; args: Record<string, unknown> }[];

beforeEach(() => {
  mockWindows("main");
  calls = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "mcp_status":
        return { enabled: false, running: false, port: 7425, url: "http://127.0.0.1:7425/mcp", token: "t", command: "/x", error: null };
      case "assistant_status":
        return { configured: true, key_hint: "c0de", model: "claude-sonnet-5-5", api_key: KEY };
      case "servers_list":
        return [sheetbro];
      case "servers_save":
        return [sheetbro];
      case "servers_test":
        return ["read_range", "write_range"];
    }
  });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearMocks();
});

async function render(addServer = false) {
  await act(async () => root.render(<McpSettings onClose={() => {}} addServer={addServer} />));
  await vi.waitFor(() => expect(host.textContent).toContain("SheetBro"));
}
const button = (text: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in: ${host.textContent}`);
  return found;
};
const click = (text: string) => act(async () => button(text).click());
const field = (label: string) => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
/** Types into a React-controlled input. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** Everything the page shows or holds, input values included. */
const everything = () => host.innerHTML + [...host.querySelectorAll("input")].map((i) => i.value).join("\n");

test("settings_never_render_a_saved_key_or_header_value", async () => {
  await render();
  expect(host.textContent).toContain("•••• c0de");
  // a server's error is its own text, shown as text
  expect(host.textContent).toContain("<b>401</b> Unauthorized");
  expect(host.querySelector(".mcp-sheet b")).toBeNull();
  await click("Edit");
  // the saved header shows by name, with an empty value that keeps it
  expect(field("Header 1 name").value).toBe("Authorization");
  expect(field("Header 1 value").value).toBe("");
  expect(field("URL").value).toBe("http://127.0.0.1:7424/mcp");
  for (const secret of [KEY, HEADER, "tok-SECRET"]) expect(everything()).not.toContain(secret);
});

test("a_command_server_says_what_will_run_and_waits_for_the_confirm", async () => {
  await render(true);
  await type(field("Name"), "Files");
  await click("Command");
  await type(field("Command"), "npx");
  await type(field("Arguments"), `-y "@scope/files server" --dir '/My Docs'`);
  await click("Save");
  expect(host.textContent).toContain(
    `DocBro will run: npx -y "@scope/files server" --dir "/My Docs" on this computer whenever this server is on. Continue?`,
  );
  expect(calls.some((c) => c.cmd === "servers_save")).toBe(false);
  await click("Cancel");
  expect(calls.some((c) => c.cmd === "servers_save")).toBe(false);
  await click("Save");
  await click("Run it");
  const saved = calls.find((c) => c.cmd === "servers_save")!.args.config as ServerConfig;
  expect(saved).toEqual({
    id: "files",
    name: "Files",
    enabled: true,
    spec: { transport: "stdio", command: "npx", args: ["-y", "@scope/files server", "--dir", "/My Docs"], env: {} },
  });
});

test("testing_a_command_server_also_needs_the_confirm", async () => {
  await render(true);
  await type(field("Name"), "Files");
  await click("Command");
  await type(field("Command"), "files-mcp");
  await click("Test");
  expect(calls.some((c) => c.cmd === "servers_test")).toBe(false);
  await click("Run it");
  await vi.waitFor(() => expect(host.textContent).toContain("read_range, write_range"));
});

test("save_waits_for_valid_fields_and_the_sheetbro_preset_needs_its_token", async () => {
  await render(true);
  expect(button("Save").disabled).toBe(true);
  await click("SheetBro preset");
  expect(field("URL").value).toBe("http://127.0.0.1:7424/mcp");
  expect(field("Header 1 name").value).toBe("Authorization");
  expect(field("Header 1 value").value).toBe("Bearer ");
  // the id sheetbro is taken, so the new one gets another
  expect(host.textContent).toContain("@sheetbro-2");
  expect(button("Save").disabled).toBe(true);
  await type(field("Header 1 value"), "Bearer abc123");
  expect(button("Save").disabled).toBe(false);
  await type(field("URL"), "ftp://nope");
  expect(button("Save").disabled).toBe(true);
});

test("an_http_server_is_saved_without_a_confirm", async () => {
  await render(true);
  await type(field("Name"), "Notes");
  await type(field("URL"), "https://notes.example/mcp");
  await click("Save");
  const saved = calls.find((c) => c.cmd === "servers_save")!.args.config as ServerConfig;
  expect(saved).toEqual({ id: "notes", name: "Notes", enabled: true, spec: { transport: "http", url: "https://notes.example/mcp", headers: {} } });
});

test.each([
  [`a b  c`, ["a", "b", "c"]],
  [`-y "two words" 'single quoted'`, ["-y", "two words", "single quoted"]],
  [`--x="a b" ""`, ["--x=a b", ""]],
  [`  `, []],
])("splitArgs(%j)", (text, want) => {
  expect(splitArgs(text)).toEqual(want);
});

test("the_command_line_quotes_what_a_shell_would_split", () => {
  expect(commandLine("npx", ["-y", "a b", `say "hi"`, ""])).toBe(`npx -y "a b" "say \\"hi\\"" ""`);
});
