import { expect, test } from "vitest";
import { createHeadlessEditor } from "./headless";

test("the_schema_has_exactly_the_shared_node_and_mark_names", () => {
  const { schema } = createHeadlessEditor();
  expect(Object.keys(schema.nodes).sort()).toEqual(
    ["blockquote", "bulletList", "doc", "field", "hardBreak", "heading", "horizontalRule", "image", "listItem",
      "orderedList", "pageBreak", "paragraph", "table", "tableCell", "tableHeader", "tableRow", "text"]);
  expect(Object.keys(schema.marks).sort()).toEqual(
    ["bold", "highlight", "italic", "link", "strike", "textStyle", "underline"]);
});

test("a_headless_editor_edits_and_reads_back_the_document", () => {
  const editor = createHeadlessEditor({
    type: "doc",
    content: [{ type: "heading", attrs: { level: 2, textAlign: "center" }, content: [{ type: "text", text: "Hi" }] }],
  });
  editor.chain().selectAll().setColor("#112233").run();
  expect(editor.getJSON().content![0].content![0].marks).toEqual([
    { type: "textStyle", attrs: expect.objectContaining({ color: "#112233" }) },
  ]);
  expect(editor.getJSON().content![0].attrs).toEqual({ level: 2, textAlign: "center", spacing: null, firstLine: null });
  editor.destroy();
});

test("headings_stop_at_level_three", () => {
  const editor = createHeadlessEditor();
  expect(editor.can().setHeading({ level: 3 })).toBe(true);
  expect(editor.can().setHeading({ level: 4 as 3 })).toBe(false);
  editor.destroy();
});

test("a_click_on_a_link_does_not_open_it", () => {
  const editor = createHeadlessEditor();
  expect(editor.extensionManager.extensions.find((e) => e.name === "link")!.options.openOnClick).toBe(false);
  editor.destroy();
});
