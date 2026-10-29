import { expect, test } from "vitest";
import { createHeadlessEditor } from "../editor/headless";
import { activeHeading, crumbs, docStats, outlineOf } from "./outline";

const h = (level: number, text?: string) => ({
  type: "heading",
  attrs: { level },
  content: text ? [{ type: "text", text }] : [],
});
const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

test("outline_lists_headings_with_levels_and_names_empty_ones_untitled", () => {
  const editor = createHeadlessEditor({
    type: "doc",
    content: [
      h(1, "Q4 brief"),
      p("Intro"),
      h(2, "  Summary  "),
      h(3),
      { type: "blockquote", content: [h(2, "Quoted")] },
      p("End"),
    ],
  });
  const doc = editor.state.doc;
  const outline = outlineOf(doc);
  expect(outline.map(({ text, level }) => ({ text, level }))).toEqual([
    { text: "Q4 brief", level: 1 },
    { text: "Summary", level: 2 },
    { text: "Untitled", level: 3 },
    { text: "Quoted", level: 2 },
  ]);
  // each entry points at its heading node
  for (const { pos, level } of outline) {
    const node = doc.nodeAt(pos)!;
    expect(node.type.name).toBe("heading");
    expect(node.attrs.level).toBe(level);
  }
  editor.destroy();
});

test("a_document_without_headings_has_an_empty_outline", () => {
  const editor = createHeadlessEditor({ type: "doc", content: [p("Just text")] });
  expect(outlineOf(editor.state.doc)).toEqual([]);
  editor.destroy();
});

test("stats_count_words_and_round_read_time_at_230_wpm", () => {
  expect(docStats("one two  three\nfour")).toMatchObject({ words: 4, readMinutes: 1 });
  expect(docStats("word ".repeat(690)).readMinutes).toBe(3);
  expect(docStats("")).toEqual({ words: 0, characters: 0, readMinutes: 1 });
  // line breaks between blocks are not characters; an emoji is one
  expect(docStats("ab\ncd 😀").characters).toBe(6);
});

test("breadcrumb_names_the_folder_and_untitled_documents", () => {
  expect(crumbs("/Users/a/Reports/q4.docx")).toEqual({ folder: "Reports", name: "q4.docx" });
  expect(crumbs("C:\\Users\\a\\Notes\\todo.md")).toEqual({ folder: "Notes", name: "todo.md" });
  expect(crumbs("/q4.docx")).toEqual({ folder: null, name: "q4.docx" });
  expect(crumbs(null)).toEqual({ folder: null, name: "Untitled" });
});

test("active_heading_is_the_last_one_above_140px", () => {
  expect(activeHeading([-300, 20, 139, 400])).toBe(2);
  expect(activeHeading([200, 400])).toBe(0);
  expect(activeHeading([])).toBe(0);
});
