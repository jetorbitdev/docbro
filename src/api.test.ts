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
});
