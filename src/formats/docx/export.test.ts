import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import { expect, test } from "vitest";
import { createHeadlessEditor } from "../../editor/headless";
import { exportDocx } from "./export";
import { fixtureDoc } from "./fixture";

const unzip = async (doc: JSONContent) => JSZip.loadAsync(await exportDocx(doc));
const read = async (zip: JSZip, path: string) => zip.file(path)!.async("string");
const bodyOf = async (doc: JSONContent) => read(await unzip(doc), "word/document.xml");

type Mark = NonNullable<JSONContent["marks"]>[number];

const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const t = (text: string, ...marks: Mark[]): JSONContent => ({ type: "text", text, marks });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

// A PNG header is all the exporter reads to size an image; the rest is padding.
function pngOfSize(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

test("writes_styles_marks_alignment_lists_tables_links_images", async () => {
  const zip = await JSZip.loadAsync(await exportDocx(fixtureDoc()));
  const xml = await zip.file("word/document.xml")!.async("string");
  for (const s of ['w:val="Heading1"', 'w:val="Heading3"', 'w:val="Quote"', "<w:pBdr>", "<w:b/>", "<w:i/>",
                   'w:u w:val="single"', "<w:strike/>", 'w:jc w:val="center"',
                   'w:jc w:val="both"', "<w:tbl>", "<w:hyperlink", "<w:tab/>", "<w:br/>"])
    expect(xml).toContain(s);
  expect(xml).toContain("Selamat pagi!");
  expect(Object.keys(zip.files).some((f) => f.startsWith("word/media/"))).toBe(true);
  expect(await zip.file("word/numbering.xml")!.async("string")).toContain("bullet");
});

test("an_empty_document_is_still_a_valid_docx", async () => {
  const zip = await JSZip.loadAsync(await exportDocx({ type: "doc", content: [] }));
  expect(zip.file("word/document.xml")).toBeTruthy();
});

test("the_fixture_holds_every_node_mark_and_attr_of_the_schema", () => {
  const nodes = new Set<string>();
  const marks = new Set<string>();
  const levels = new Set<unknown>();
  const aligns = new Set<unknown>();
  const visit = (node: JSONContent) => {
    nodes.add(node.type!);
    for (const mark of node.marks ?? []) marks.add(mark.type);
    if (node.type === "heading") levels.add(node.attrs!.level);
    if (node.attrs?.textAlign) aligns.add(node.attrs.textAlign);
    node.content?.forEach(visit);
  };
  visit(fixtureDoc());

  expect([...nodes].sort()).toEqual(
    ["blockquote", "bulletList", "doc", "hardBreak", "heading", "horizontalRule", "image", "listItem",
     "orderedList", "paragraph", "table", "tableCell", "tableHeader", "tableRow", "text"]);
  expect([...marks].sort()).toEqual(["bold", "highlight", "italic", "link", "strike", "textStyle", "underline"]);
  expect([...levels].sort()).toEqual([1, 2, 3]);
  expect([...aligns].sort()).toEqual(["center", "justify", "left", "right"]);
  expect(JSON.stringify(fixtureDoc())).toContain("  dua spasi\\tlalu tab");
  expect(() => createHeadlessEditor().schema.nodeFromJSON(fixtureDoc()).check()).not.toThrow();
});

test("maps_alignment_to_jc_and_writes_none_when_unset", async () => {
  const xml = await bodyOf(doc(
    { type: "paragraph", attrs: { textAlign: "left" }, content: [t("a")] },
    { type: "paragraph", attrs: { textAlign: "right" }, content: [t("b")] },
    { type: "paragraph", attrs: { textAlign: "justify" }, content: [t("c")] },
  ));
  for (const s of ['w:jc w:val="start"', 'w:jc w:val="end"', 'w:jc w:val="both"']) expect(xml).toContain(s);
  expect(await bodyOf(doc({ type: "paragraph", attrs: { textAlign: null }, content: [t("d")] }))).not.toContain("<w:jc");
});

test("writes_color_and_highlight_as_hex_without_the_hash", async () => {
  const xml = await bodyOf(doc(p(
    t("x", { type: "textStyle", attrs: { color: "#cc0000" } }, { type: "highlight", attrs: { color: "#f3dc6b" } }),
  )));
  expect(xml).toContain('<w:color w:val="cc0000"/>');
  expect(xml).toMatch(/<w:shd [^>]*w:fill="f3dc6b"/);
  expect(xml).not.toContain("<w:highlight");
});

test("links_become_external_relationships", async () => {
  const zip = await unzip(fixtureDoc());
  const rels = await read(zip, "word/_rels/document.xml.rels");
  expect(rels).toMatch(/Target="https:\/\/example\.com\/docbro"[^>]*TargetMode="External"/);
});

test("lists_use_one_reference_per_kind_with_depth_as_level_and_a_new_list_per_instance", async () => {
  const list = (kind: string, start: number | undefined, ...items: string[]): JSONContent => ({
    type: kind,
    ...(start === undefined ? {} : { attrs: { start } }),
    content: items.map((text) => ({ type: "listItem", content: [p(t(text))] })),
  });
  const nested: JSONContent = {
    type: "bulletList",
    content: [{ type: "listItem", content: [p(t("outer")), list("bulletList", undefined, "inner")] }],
  };
  const zip = await unzip(doc(nested, list("orderedList", 3, "c", "d"), list("orderedList", 1, "x"), list("orderedList", 3, "y")));
  const body = await read(zip, "word/document.xml");
  const numbering = await read(zip, "word/numbering.xml");

  expect(body).toContain('<w:ilvl w:val="0"/>');
  expect(body).toContain('<w:ilvl w:val="1"/>');
  expect(numbering).toContain('w:numFmt w:val="bullet"');
  expect(numbering).toContain('w:numFmt w:val="decimal"');
  expect(numbering).toContain('<w:start w:val="3"/>');

  // Paragraphs in order: outer, inner (bullets), c, d, x, y (numbered). The two lists that start at 3 get
  // their own numId, so each counts from its own start.
  const numIds = [...body.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
  expect(numIds).toHaveLength(6);
  expect(numIds[0]).toBe(numIds[1]);
  expect(numIds[2]).toBe(numIds[3]);
  expect(new Set(numIds).size).toBe(4);
});

test("a_blockquote_writes_each_paragraph_as_a_quote_paragraph", async () => {
  const xml = await bodyOf(doc({ type: "blockquote", content: [p(t("satu")), p(t("dua"))] }));
  expect(xml.match(/w:val="Quote"/g)).toHaveLength(2);
});

test("a_horizontal_rule_is_an_empty_paragraph_with_a_bottom_border", async () => {
  const xml = await bodyOf(doc({ type: "horizontalRule" }));
  expect(xml).toMatch(/<w:p><w:pPr><w:pBdr><w:bottom [^>]*\/><\/w:pBdr><\/w:pPr><\/w:p>/);
});

test("the_first_table_row_is_marked_as_a_header_row_when_it_holds_header_cells", async () => {
  const xml = await bodyOf(fixtureDoc());
  expect(xml.match(/<w:tblHeader\/>/g)).toHaveLength(1);
  expect(xml.match(/<w:tr>/g)).toHaveLength(2);
  expect(xml).not.toContain("w:tblHeader w:val");
});

test("merged_cells_keep_their_spans", async () => {
  const cell = (colspan: number, rowspan: number, text: string): JSONContent =>
    ({ type: "tableCell", attrs: { colspan, rowspan }, content: [p(t(text))] });
  const xml = await bodyOf(doc({
    type: "table",
    content: [
      { type: "tableRow", content: [cell(2, 1, "wide")] },
      { type: "tableRow", content: [cell(1, 2, "tall"), cell(1, 1, "b")] },
      { type: "tableRow", content: [cell(1, 1, "c")] },
    ],
  }));
  expect(xml).toContain('<w:gridSpan w:val="2"/>');
  expect(xml).toContain('<w:vMerge w:val="restart"/>');
  expect(xml).toContain('<w:vMerge w:val="continue"/>');
});

test("an_image_is_sized_to_its_pixels_and_capped_at_624px_wide_keeping_the_aspect_ratio", async () => {
  const px = 9525; // EMU per pixel
  const small = await bodyOf(doc({ type: "image", attrs: { src: pngOfSize(200, 100), alt: null } }));
  expect(small).toContain(`<wp:extent cx="${200 * px}" cy="${100 * px}"/>`);
  const wide = await bodyOf(doc({ type: "image", attrs: { src: pngOfSize(1248, 624), alt: null } }));
  expect(wide).toContain(`<wp:extent cx="${624 * px}" cy="${312 * px}"/>`);
});

test("an_image_that_is_not_a_data_url_becomes_its_alt_text", async () => {
  const remote = (alt: string | null) => doc({ type: "image", attrs: { src: "https://example.com/logo.png", alt } });
  const zip = await unzip(remote("Logo kami"));
  expect(await read(zip, "word/document.xml")).toContain("Logo kami");
  expect(Object.keys(zip.files).some((f) => f.startsWith("word/media/"))).toBe(false);
  expect(await bodyOf(remote(null))).toContain("[image]");
});

test("a_mark_with_an_invalid_color_is_ignored", async () => {
  const xml = await bodyOf(doc(p(
    t("a", { type: "highlight", attrs: { color: "" } }),
    t("b", { type: "highlight", attrs: { color: "yellow" } }),
    t("c", { type: "textStyle", attrs: { color: null } }),
    t("d", { type: "textStyle", attrs: { color: "red" } }),
    t("e", { type: "textStyle", attrs: { color: "#12345" } }),
  )));
  expect(xml).toContain("<w:t xml:space=\"preserve\">e</w:t>");
  expect(xml).not.toContain("<w:shd");
  expect(xml).not.toContain("<w:color");
});

test("keeps_spaces_and_writes_a_tab_and_a_break_as_elements", async () => {
  const xml = await bodyOf(doc(p(t("  a\tb"), { type: "hardBreak" }, t("c"))));
  expect(xml).toContain('xml:space="preserve">  a</w:t>');
  expect(xml).toContain("<w:tab/>");
  expect(xml).toContain("<w:br/>");
  expect(xml).not.toContain("\t");
});
