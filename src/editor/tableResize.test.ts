import type { JSONContent } from "@tiptap/core";
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

const cell = (width: number): JSONContent => ({
  type: "tableCell",
  attrs: { colwidth: [width] },
  content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
});
const table = (indent: number): JSONContent => ({
  type: "doc",
  content: [{ type: "table", attrs: { indent }, content: [{ type: "tableRow", content: [cell(200), cell(300)] }] }],
});

test("a_tables_widths_and_indent_are_drawn_at_the_scale_of_the_sheet_so_it_shrinks_with_the_page", () => {
  editor = createHeadlessEditor(table(24));
  editor.mount(document.createElement("div"));
  const el = editor.view.dom.querySelector("table")!;
  const cols = Array.from(el.querySelectorAll("col")).map((col) => col.style.width);
  expect(cols).toEqual(["calc(200px * var(--look-scale, 1))", "calc(300px * var(--look-scale, 1))"]);
  expect(el.style.width).toBe("calc(500px * var(--look-scale, 1))");
  expect(el.style.marginLeft).toBe("calc(24px * var(--look-scale, 1))");
});

test("a_column_width_written_while_its_border_is_dragged_is_scaled_too", async () => {
  editor = createHeadlessEditor(table(0));
  editor.mount(document.createElement("div"));
  const col = editor.view.dom.querySelector("col")!;
  col.style.width = "260px";
  await Promise.resolve();
  expect(col.style.width).toBe("calc(260px * var(--look-scale, 1))");
});
