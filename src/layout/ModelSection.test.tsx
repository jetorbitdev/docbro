import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AssistantStatus, ProviderPreset } from "../api";
import { ModelSection } from "./ModelSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// What the webview could be sent by mistake: none of it may ever reach the page.
const KEY = "sk-ant-api03-SECRET-c0de";
const PROVIDER_KEY = "sk-proj-SECRET-9f9f";

const PRESETS: ProviderPreset[] = [
  { id: "openai", name: "OpenAI", label: "OpenAI", base_url: "https://api.openai.com/v1", key_required: true },
  { id: "openrouter", name: "OpenRouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", key_required: true },
  { id: "ollama", name: "Ollama", label: "Ollama (on this computer)", base_url: "http://localhost:11434/v1", key_required: false },
  { id: "lmstudio", name: "LM Studio", label: "LM Studio (on this computer)", base_url: "http://localhost:1234/v1", key_required: false },
  { id: "custom", name: "Custom", label: "Custom", base_url: "", key_required: false },
];

const base = (): AssistantStatus => ({
  configured: true,
  key_hint: null,
  model: "claude-sonnet-5-5",
  engine: "claude_code",
  claude_model: "sonnet",
  claude: { found: true, path: "/Users/someone/.local/bin/claude", version: "2.1.316" },
  openai: { preset: "openai", base_url: "https://api.openai.com/v1", model: "", key_hint: null, configured: false },
});

let host: HTMLElement;
let root: Root;
let calls: { cmd: string; args: Record<string, unknown> }[];
let status: AssistantStatus;
let listFails: string | null;

beforeEach(() => {
  calls = [];
  status = base();
  listFails = null;
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "assistant_status":
        // fields the real status does not have
        return { ...status, api_key: KEY, openai: { ...status.openai, api_key: PROVIDER_KEY } };
      case "assistant_presets":
        return PRESETS;
      case "assistant_save":
        return { ...status, engine: args.engine ?? status.engine };
      case "assistant_save_openai":
        return { ...status, engine: "openai_compatible" };
      case "assistant_clear_key":
        return status;
      case "assistant_list_models":
        if (listFails) throw listFails;
        return ["gpt-5.5", "gpt-5.5-mini"];
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

async function render() {
  await act(async () => root.render(<ModelSection />));
  await vi.waitFor(() => expect(host.querySelector<HTMLInputElement>("input[type=radio]:checked")).not.toBeNull());
}
const button = (text: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in: ${host.textContent}`);
  return found;
};
const click = (text: string) => act(async () => button(text).click());
const field = (label: string) => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
const radio = (label: string) =>
  [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim() === label)!.querySelector<HTMLInputElement>("input")!;
const pick = (label: string) => act(async () => radio(label).click());
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(label: string, value: string) {
  const el = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const saves = () => calls.filter((c) => c.cmd.startsWith("assistant_save"));
const everything = () => host.innerHTML + [...host.querySelectorAll("input")].map((i) => i.value).join("\n");

const CLAUDE = "Claude Code — uses your Claude subscription";
const API = "Anthropic API key";
const OTHER = "Other provider (OpenAI-compatible)";

test("claude_code_found_shows_its_version_and_path_and_saves_its_model_with_the_engine", async () => {
  await render();
  expect(radio(CLAUDE).checked).toBe(true);
  expect(host.textContent).toContain("Claude Code 2.1.316 found at ~/.local/bin/claude");
  expect(host.textContent).toContain("through your Claude Code and your Claude subscription");
  // the Anthropic key fields belong to the API key engine only
  expect(field("API key")).toBeNull();
  expect(field("Model")!.placeholder).toBe("sonnet");
  expect(field("Model")!.value).toBe("sonnet");
  expect(button("Save").disabled).toBe(true);
  await type(field("Model")!, "opus");
  await click("Save");
  expect(saves()).toEqual([{ cmd: "assistant_save", args: { apiKey: null, model: "opus", engine: "claude_code" } }]);
});

test("claude_code_not_found_says_where_to_get_it", async () => {
  status = { ...base(), configured: false, claude: { found: false, path: null, version: null } };
  await render();
  expect(host.textContent).toContain("Claude Code was not found. Install it from claude.com/code.");
  expect(host.textContent).not.toContain("found at");
});

test("switching_to_the_api_key_saves_that_engine_with_the_key_and_the_api_model", async () => {
  await render();
  await pick(API);
  expect(host.textContent).toContain("Save to use this engine.");
  expect(field("Model")!.value).toBe("claude-sonnet-5-5");
  await type(field("API key")!, " sk-ant-new-key-1234 ");
  await click("Save");
  expect(saves()).toEqual([{ cmd: "assistant_save", args: { apiKey: "sk-ant-new-key-1234", model: "claude-sonnet-5-5", engine: "api_key" } }]);
  // the typed key is gone from the form once saved
  expect(field("API key")!.value).toBe("");
});

test("only_the_engine_changing_is_enough_to_save", async () => {
  status = { ...base(), engine: "api_key", key_hint: "c0de" };
  await render();
  expect(radio(API).checked).toBe(true);
  expect(host.textContent).toContain("•••• c0de");
  await pick(CLAUDE);
  await click("Save");
  expect(saves()).toEqual([{ cmd: "assistant_save", args: { apiKey: null, model: "sonnet", engine: "claude_code" } }]);
});

test("the_provider_form_saves_with_its_own_command_and_never_sends_its_key_with_assistant_save", async () => {
  await render();
  await pick(OTHER);
  expect(field("Base URL")!.value).toBe("https://api.openai.com/v1");
  await choose("Provider", "openrouter");
  expect(field("Base URL")!.value).toBe("https://openrouter.ai/api/v1");
  expect(host.textContent).toContain("Your messages, the document text the model reads and tool results are sent to OpenRouter.");
  await type(field("API key")!, "sk-or-typed-5678");
  await type(field("Model")!, "anthropic/claude-sonnet-5.5");
  await click("Save");
  expect(saves()).toEqual([
    {
      cmd: "assistant_save_openai",
      args: { preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5.5", apiKey: "sk-or-typed-5678" },
    },
  ]);
});

test("a_typed_key_is_cleared_when_another_provider_is_picked", async () => {
  await render();
  await pick(OTHER);
  await type(field("API key")!, "sk-proj-typed-for-openai");
  // a key for one provider must not go to the next one picked
  await choose("Provider", "openrouter");
  expect(field("API key")!.value).toBe("");
  await type(field("Model")!, "anthropic/claude-sonnet-5.5");
  await click("Save");
  expect(saves()).toEqual([
    { cmd: "assistant_save_openai", args: { preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5.5", apiKey: null } },
  ]);
  expect(everything()).not.toContain("sk-proj-typed-for-openai");
});

test("load_models_asks_with_the_unsaved_form_and_never_saves_or_switches", async () => {
  await render();
  await pick(OTHER);
  await type(field("API key")!, "sk-typed-0000");
  await click("Load models");
  expect(calls.find((c) => c.cmd === "assistant_list_models")!.args).toEqual({
    draft: { preset: "openai", base_url: "https://api.openai.com/v1", api_key: "sk-typed-0000" },
  });
  expect(saves()).toEqual([]);
  await vi.waitFor(() => expect(host.querySelector('select[aria-label="Loaded models"]')).not.toBeNull());
  await choose("Loaded models", "gpt-5.5-mini");
  expect(field("Model")!.value).toBe("gpt-5.5-mini");
  // typing stays possible
  await type(field("Model")!, "gpt-5.5-custom");
  expect(field("Model")!.value).toBe("gpt-5.5-custom");
  expect(saves()).toEqual([]);
  expect(calls.some((c) => c.cmd === "assistant_clear_key")).toBe(false);
});

test("load_models_without_a_typed_key_leaves_the_saved_one_to_rust", async () => {
  status = { ...base(), engine: "openai_compatible", openai: { ...base().openai, key_hint: "9f9f", model: "gpt-5.5", configured: true } };
  await render();
  await click("Load models");
  expect(calls.find((c) => c.cmd === "assistant_list_models")!.args).toEqual({
    draft: { preset: "openai", base_url: "https://api.openai.com/v1", api_key: null },
  });
});

test("a_provider_error_is_shown_as_text", async () => {
  listFails = "The API key was rejected by <b>OpenAI</b>. Check it in MCP settings.";
  await render();
  await pick(OTHER);
  await click("Load models");
  await vi.waitFor(() => expect(host.textContent).toContain("The API key was rejected by <b>OpenAI</b>."));
  expect(host.querySelector("b")).toBeNull();
});

test("the_saved_provider_key_is_not_kept_for_another_origin", async () => {
  status = { ...base(), engine: "openai_compatible", openai: { ...base().openai, key_hint: "9f9f", model: "gpt-5.5", configured: true } };
  await render();
  const note = "The saved key is not sent to a different server. Enter it again.";
  expect(host.textContent).toContain("•••• 9f9f");
  expect(host.textContent).not.toContain(note);
  await type(field("Base URL")!, "https://api.openai.com/v2");
  expect(host.textContent).not.toContain(note);
  await type(field("Base URL")!, "https://proxy.example/v1");
  expect(host.textContent).toContain(note);
  expect(host.textContent).not.toContain("•••• 9f9f");
  await type(field("Base URL")!, "https://api.openai.com:443/v1");
  expect(host.textContent).not.toContain(note);
});

test("a_preset_on_this_computer_keeps_everything_here_and_hides_the_key_until_asked", async () => {
  await render();
  await pick(OTHER);
  await choose("Provider", "ollama");
  expect(field("Base URL")!.value).toBe("http://localhost:11434/v1");
  expect(host.textContent).toContain("Everything stays on this computer.");
  expect(field("API key")).toBeNull();
  await click("+ API key");
  expect(field("API key")).not.toBeNull();
});

test("custom_names_the_host_it_sends_to", async () => {
  await render();
  await pick(OTHER);
  await choose("Provider", "custom");
  expect(field("Base URL")!.value).toBe("");
  await type(field("Base URL")!, "https://llm.example.com/v1");
  expect(host.textContent).toContain("are sent to llm.example.com.");
});

test("remove_key_on_the_provider_form_removes_the_providers_key", async () => {
  status = { ...base(), engine: "openai_compatible", openai: { ...base().openai, key_hint: "9f9f", model: "gpt-5.5", configured: true } };
  await render();
  await click("Remove key");
  expect(calls.find((c) => c.cmd === "assistant_clear_key")!.args).toEqual({ engine: "openai_compatible" });
});

test("remove_key_on_the_api_key_form_removes_the_anthropic_key", async () => {
  status = { ...base(), engine: "api_key", key_hint: "c0de" };
  await render();
  await click("Remove key");
  expect(calls.find((c) => c.cmd === "assistant_clear_key")!.args).toEqual({});
});

test("no_key_material_reaches_the_page_beyond_the_last_four", async () => {
  status = { ...base(), engine: "api_key", key_hint: "c0de", openai: { ...base().openai, key_hint: "9f9f" } };
  await render();
  await pick(OTHER);
  await pick(CLAUDE);
  await pick(API);
  for (const secret of [KEY, PROVIDER_KEY, "SECRET"]) expect(everything()).not.toContain(secret);
});
