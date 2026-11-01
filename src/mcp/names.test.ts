import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { TOOL_NAMES } from "./tools";

// Rust advertises the tools to MCP clients and refuses unknown ones before they reach the
// webview, so its list has to be the very list the webview runs, in the same order.
test("rust_advertises_exactly_the_tools_the_webview_runs", () => {
  const rust = readFileSync("src-tauri/src/mcp/tools.rs", "utf8");
  const found = rust.match(/TOOL_NAMES: \[&str; (\d+)\] = \[([^\]]*)\];/);
  expect(found, "TOOL_NAMES not found in mcp/tools.rs").not.toBeNull();
  const [, count, body] = found!;
  const names = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  expect(names).toEqual([...TOOL_NAMES]);
  expect(Number(count)).toBe(TOOL_NAMES.length);
});
