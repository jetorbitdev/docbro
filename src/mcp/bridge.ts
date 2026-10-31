import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../api";
import { activity } from "./activity";
import { runTool, type ToolContext, type ToolResult } from "./tools";

/** The `mcp-call` event Rust sends this window (calls.rs, `call_payload`). */
interface McpCall {
  id: number;
  name: string;
  args: Record<string, unknown>;
  /** Unix ms; a call whose turn comes after it is refused, because Rust has already told the client it timed out */
  deadline: number;
}

const EXPIRED = "The call expired before DocBro could run it.";

/**
 * Runs the tool calls Rust forwards to this window, one at a time in the order they came, and
 * answers every one of them, even when the tool throws. Each shows up in the activity feed.
 * Resolves to the function that stops listening.
 */
export async function startBridge(ctx: () => ToolContext): Promise<() => void> {
  let queue = Promise.resolve();
  return getCurrentWindow().listen<McpCall>("mcp-call", ({ payload: call }) => {
    const entry = activity.begin(call.name, call.args);
    queue = queue.then(() => answer(call, entry, ctx));
  });
}

async function answer(call: McpCall, entry: number, ctx: () => ToolContext) {
  let result: ToolResult;
  try {
    result = Date.now() > call.deadline ? { ok: false, text: EXPIRED } : await runTool(ctx(), call.name, call.args);
  } catch (e) {
    result = { ok: false, text: (e instanceof Error && e.message) || String(e) };
  }
  activity.finish(entry, result.ok, result.text);
  // a reply that fails (the call already timed out in Rust) must not stop the calls queued behind it
  await api.mcpReply(call.id, result.ok, result.text).catch(() => {});
}
