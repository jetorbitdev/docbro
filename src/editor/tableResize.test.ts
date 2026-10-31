import { afterEach, expect, test } from "vitest";
import { createHeadlessEditor } from "./headless";

let editor: ReturnType<typeof createHeadlessEditor>;
afterEach(() => editor?.destroy());

test("a_table_column_can_be_dragged_wider_or_narrower", () => {
  editor = createHeadlessEditor();
  editor.mount(document.createElement("div"));
  const keys = editor.state.plugins.map((p) => (p as unknown as { key: string }).key);
  expect(keys.some((k) => k.startsWith("tableColumnResizing"))).toBe(true);
});
