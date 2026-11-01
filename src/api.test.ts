import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { api } = await import("./api");

describe("api", () => {
  beforeEach(() => invoke.mockReset());

  it("sends the file bytes as the body and the encoded path in x-path", async () => {
    invoke.mockResolvedValue(undefined);
    const bytes = new Uint8Array([1, 2, 3]);
    await api.writeFile("/Users/me/My Docs/näme & co.docx", bytes);
    expect(invoke).toHaveBeenCalledWith("write_file", bytes, {
      headers: { "x-path": "%2FUsers%2Fme%2FMy%20Docs%2Fn%C3%A4me%20%26%20co.docx" },
    });
  });

  it("reads a file as a Uint8Array", async () => {
    invoke.mockResolvedValue(new Uint8Array([9, 8]).buffer);
    const bytes = await api.readFile("/a.md");
    expect(invoke).toHaveBeenCalledWith("read_file", { path: "/a.md" });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([9, 8]);
  });

  it("asks Rust for the user's name", async () => {
    invoke.mockResolvedValue("gilang");
    expect(await api.userName()).toBe("gilang");
    expect(invoke).toHaveBeenCalledWith("user_name");
  });

  it("passes the window facts and the open request by the names Rust expects", async () => {
    invoke.mockResolvedValue(undefined);
    await api.setDocMeta("/a.docx", true, false);
    expect(invoke).toHaveBeenLastCalledWith("set_doc_meta", { path: "/a.docx", dirty: true, blank: false });
    await api.openInWindow("/a.docx");
    expect(invoke).toHaveBeenLastCalledWith("open_in_window", { path: "/a.docx", here: false });
    await api.openInWindow(null, true);
    expect(invoke).toHaveBeenLastCalledWith("open_in_window", { path: null, here: true });
  });

  it("passes the MCP server settings and tool answers by the names Rust expects", async () => {
    invoke.mockResolvedValue(undefined);
    await api.mcpReply(7, false, "There is no block 9.");
    expect(invoke).toHaveBeenLastCalledWith("mcp_reply", { id: 7, ok: false, text: "There is no block 9." });
    await api.mcpSetEnabled(true, 7425);
    expect(invoke).toHaveBeenLastCalledWith("mcp_set_enabled", { enabled: true, port: 7425 });
    await api.mcpRegenerateToken();
    expect(invoke).toHaveBeenLastCalledWith("mcp_regenerate_token");
  });

  it("passes the assistant settings and messages by the names Rust expects", async () => {
    invoke.mockResolvedValue(undefined);
    await api.assistantSave(null, "claude-sonnet-5-5");
    expect(invoke).toHaveBeenLastCalledWith("assistant_save", { apiKey: null, model: "claude-sonnet-5-5" });
    await api.assistantSend("Summarize", "the selection", "docbro", false);
    expect(invoke).toHaveBeenLastCalledWith("assistant_send", {
      text: "Summarize",
      context: "the selection",
      only: "docbro",
      excludeBuiltin: false,
    });
    await api.assistantCancel();
    expect(invoke).toHaveBeenLastCalledWith("assistant_cancel");
    await api.assistantReset();
    expect(invoke).toHaveBeenLastCalledWith("assistant_reset");
  });

  it("passes the engine and the Claude Code session commands by the names Rust expects", async () => {
    invoke.mockResolvedValue(undefined);
    await api.assistantSave(null, "opus", "claude_code");
    expect(invoke).toHaveBeenLastCalledWith("assistant_save", { apiKey: null, model: "opus", engine: "claude_code" });
    await api.claudeSessions();
    expect(invoke).toHaveBeenLastCalledWith("claude_sessions");
    await api.assistantContinue("5d769f48-8925-400b-85a7-6271f82177b2");
    expect(invoke).toHaveBeenLastCalledWith("assistant_continue", {
      sessionId: "5d769f48-8925-400b-85a7-6271f82177b2",
    });
    await api.assistantTeleport("https://claude.ai/code/session_01ABC");
    expect(invoke).toHaveBeenLastCalledWith("assistant_teleport", { input: "https://claude.ai/code/session_01ABC" });
  });

  it("passes the other provider's settings by the names Rust expects", async () => {
    invoke.mockResolvedValue(undefined);
    await api.assistantSaveOpenai("ollama", "", "llama3.2", null);
    expect(invoke).toHaveBeenLastCalledWith("assistant_save_openai", {
      preset: "ollama",
      baseUrl: "",
      model: "llama3.2",
      apiKey: null,
    });
    await api.assistantListModels();
    expect(invoke).toHaveBeenLastCalledWith("assistant_list_models", undefined);
    await api.assistantListModels({ preset: "custom", base_url: "https://llm.example.com/v1", api_key: null });
    expect(invoke).toHaveBeenLastCalledWith("assistant_list_models", {
      draft: { preset: "custom", base_url: "https://llm.example.com/v1", api_key: null },
    });
    await api.assistantPresets();
    expect(invoke).toHaveBeenLastCalledWith("assistant_presets");
    await api.assistantClearKey("openai_compatible");
    expect(invoke).toHaveBeenLastCalledWith("assistant_clear_key", { engine: "openai_compatible" });
    await api.assistantClearKey();
    expect(invoke).toHaveBeenLastCalledWith("assistant_clear_key", undefined);
  });
});
