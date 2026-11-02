import { expect, test } from "vitest";
import { createHeadlessEditor } from "../editor/headless";
import { docToMarkdown, markdownToDoc } from "./markdown";

test("round_trips_headings_marks_lists_links_tables_quotes_dividers", () => {
  const md = [
    "# Title", "", "## Section", "",
    "Plain **bold** *italic* ~~gone~~ [site](https://example.com)", "",
    "> quoted", "", "---", "",
    "- one", "- two", "  - nested", "", "3. three", "4. four", "",
    "| A | B |", "| --- | --- |", "| 1 | 2 |",
  ].join("\n");
  const doc = markdownToDoc(md);
  expect(doc.content!.map((n) => n.type)).toEqual(
    ["heading", "heading", "paragraph", "blockquote", "horizontalRule", "bulletList", "orderedList", "table"]);
  expect(doc.content![6].attrs!.start).toBe(3);
  expect(docToMarkdown(markdownToDoc(docToMarkdown(doc)))).toBe(docToMarkdown(doc));
});

test("drops_what_the_schema_does_not_have_instead_of_failing", () => {
  const doc = markdownToDoc("```js\nx()\n```\n\n#### deep");
  expect(doc.content!.every((n) => n.type === "paragraph")).toBe(true);
  expect(docToMarkdown(doc)).toContain("x()");
});

test("keeps_the_text_of_inline_code", () => {
  const doc = markdownToDoc("call `x()` now");
  expect(doc.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "call x() now" }] }]);
});

test("always_returns_a_document_the_schema_accepts", () => {
  const schema = createHeadlessEditor().schema;
  const inputs = [
    "",
    "text ![pic](data:image/png;base64,AAAA) more",
    "- [ ] todo\n- [x] done",
    "-\n- \n\n|a|b|\n|-|-|\n||x|",
    "- # heading in a list\n- ![pic](data:image/png;base64,AAAA)",
    "```\ncode\n```\n\n###### six",
  ];
  for (const md of inputs) {
    expect(() => schema.nodeFromJSON(markdownToDoc(md)).check(), md).not.toThrow();
  }
});

test("a_page_break_is_kept_in_markdown_and_read_back", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "one" }] },
      { type: "pageBreak" },
      { type: "paragraph", content: [{ type: "text", text: "two" }] },
    ],
  };
  const md = docToMarkdown(doc);
  expect(md).toContain("data-page-break");
  expect(markdownToDoc(md).content!.map((n) => n.type)).toEqual(["paragraph", "pageBreak", "paragraph"]);
});

test("a_picture_linked_by_address_keeps_its_link_through_a_round_trip", () => {
  const md = "![Quarterly chart](https://tracker.example/p.png?d=1 \"Q3\")";
  const doc = markdownToDoc(md);
  const image = doc.content!.find((n) => n.type === "image")!;
  expect(image.attrs).toMatchObject({ src: "https://tracker.example/p.png?d=1", alt: "Quarterly chart", title: "Q3" });
  expect(docToMarkdown(doc)).toContain(md);
  // in an editor, where the window would draw it, the node still has the address
  const editor = createHeadlessEditor(doc);
  editor.mount(document.createElement("div"));
  expect(docToMarkdown(editor.getJSON())).toContain(md);
  expect(editor.view.dom.querySelector("img")).toBeNull();
  editor.destroy();
});
