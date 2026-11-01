import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import { expect, test } from "vitest";
import { createHeadlessEditor } from "../../editor/headless";
import { exportDocx } from "./export";
import { importDocx } from "./import";
import { buildDocx, normalize } from "./testing";

const WHITE_RUN = '<w:r><w:rPr><w:b/><w:color w:val="ffffff"/></w:rPr><w:t>No</w:t></w:r>';
const cellXml = (fill: string | null, run = "<w:r><w:t>x</w:t></w:r>") =>
  `<w:tc><w:tcPr>${fill ? `<w:shd w:fill="${fill}" w:val="clear"/>` : ""}</w:tcPr><w:p>${run}</w:p></w:tc>`;
const tableXml = (cells: string[], props = '<w:tblW w:w="3000" w:type="dxa"/>') =>
  `<w:tbl><w:tblPr>${props}</w:tblPr><w:tblGrid>${cells.map(() => '<w:gridCol w:w="1500"/>').join("")}</w:tblGrid><w:tr>${cells.join("")}</w:tr></w:tbl>`;
const readTable = async (body: string) => (await importDocx(await buildDocx({ document: body }))).doc.content![0];

test("a_shaded_cell_keeps_its_fill_and_its_white_text_while_white_or_auto_shading_is_no_fill", async () => {
  const table = await readTable(tableXml([cellXml("3C78D8", WHITE_RUN), cellXml("ffffff"), cellXml("auto")]));
  const cells = table.content![0].content!;
  expect(cells.map((c) => c.attrs!.background ?? null)).toEqual(["#3c78d8", null, null]);
  expect(cells[0].content![0].content![0].marks).toEqual(expect.arrayContaining([{ type: "bold" }, { type: "textStyle", attrs: { color: "#ffffff", fontFamily: null } }]));
});

test("white_text_outside_a_shaded_cell_is_still_the_sources_default_and_dropped", async () => {
  const table = await readTable(tableXml([cellXml(null, WHITE_RUN)]));
  expect(table.content![0].content![0].content![0].content![0].marks).toEqual([{ type: "bold" }]);
});

test("a_table_keeps_its_indent_or_a_floating_tables_offset_within_the_text", async () => {
  const indent = async (props: string) => (await readTable(tableXml([cellXml(null)], '<w:tblW w:w="3000" w:type="dxa"/>' + props))).attrs?.indent ?? 0;
  expect(await indent('<w:tblInd w:w="285.0" w:type="dxa"/>')).toBe(19);
  expect(await indent('<w:tblInd w:w="-108" w:type="dxa"/>')).toBe(0); // Word's own, lining the cell text up with the margin
  expect(await indent('<w:tblpPr w:horzAnchor="text" w:tblpX="1185" w:tblpY="0"/><w:tblInd w:w="1470" w:type="dxa"/>')).toBe(79);
  expect(await indent('<w:tblpPr w:horzAnchor="page" w:tblpX="1185"/>')).toBe(0);
  // Letter's text is 624px wide and the table's one column 100px: no further than its right edge
  expect(await indent('<w:tblInd w:w="9000" w:type="dxa"/>')).toBe(524);
  // a table as wide as the page has no room to move
  const auto = await readTable(tableXml([cellXml(null)], '<w:tblW w:w="0" w:type="auto"/><w:tblInd w:w="285" w:type="dxa"/>'));
  expect(auto.attrs?.indent ?? 0).toBe(0);
});

const filledDoc: JSONContent = {
  type: "doc",
  content: [{
    type: "table",
    attrs: { indent: 19 },
    content: [{
      type: "tableRow",
      content: [
        { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [100], background: "#3c78d8" }, content: [{ type: "paragraph", content: [{ type: "text", text: "No", marks: [{ type: "textStyle", attrs: { color: "#ffffff" } }] }] }] },
        { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [100] }, content: [{ type: "paragraph", content: [{ type: "text", text: "Nama" }] }] },
      ],
    }],
  }],
};

test("a_cells_fill_and_a_tables_indent_are_written_and_survive_a_save_and_reopen", async () => {
  const bytes = await exportDocx(filledDoc);
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  expect(xml).toMatch(/<w:shd [^>]*w:fill="3c78d8"/);
  expect(xml).toMatch(/<w:tblInd [^>]*w:w="285"/);
  const { doc, dropped } = await importDocx(bytes);
  expect(doc).toEqual(normalize(filledDoc));
  expect(dropped).toEqual([]);
});

test("a_shaded_cell_is_drawn_with_the_text_color_that_reads_on_it", () => {
  const editor = createHeadlessEditor(filledDoc);
  const html = editor.getHTML();
  expect(html).toMatch(/<td[^>]*data-background="#3c78d8"[^>]*style="background-color: rgb\(60, 120, 216\); color: rgb\(255, 255, 255\)/);
  expect(html).toMatch(/<table[^>]*style="[^"]*margin-left: 19px/);
  editor.destroy();
});
