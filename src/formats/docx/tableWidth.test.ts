import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import { expect, test } from "vitest";
import { exportDocx } from "./export";
import { importDocx } from "./import";
import { buildDocx, normalize } from "./testing";

const cellXml = (text: string, span = 0) =>
  `<w:tc><w:tcPr>${span ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const rowXml = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const FIXED_WIDE = '<w:tblW w:w="9000" w:type="dxa"/>';
const tableXml = (grid: number[], rows: string[], props = FIXED_WIDE) =>
  `<w:tbl><w:tblPr>${props}</w:tblPr><w:tblGrid>${grid.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`;

const widths = async (body: string): Promise<(number[] | null)[][]> => {
  const { doc } = await importDocx(await buildDocx({ document: body }));
  return doc.content![0].content!.map((row) => row.content!.map((cell) => cell.attrs!.colwidth));
};

test("reads_the_column_widths_of_a_table_with_a_fixed_width_from_its_grid", async () => {
  // twips to px: 15 to the px
  expect(await widths(tableXml([3000, 6000], [rowXml(cellXml("a"), cellXml("b"))]))).toEqual([[[200], [400]]]);
});

test("a_cell_that_spans_columns_gets_the_width_of_each", async () => {
  const body = tableXml([3000, 3000, 3000], [rowXml(cellXml("a", 2), cellXml("b")), rowXml(cellXml("c"), cellXml("d"), cellXml("e"))]);
  expect(await widths(body)).toEqual([[[200, 200], [200]], [[200], [200], [200]]]);
});

test("a_table_that_is_auto_or_percent_wide_is_left_to_the_browser", async () => {
  for (const props of ['<w:tblW w:w="0" w:type="auto"/>', '<w:tblW w:w="5000" w:type="pct"/>']) {
    expect(await widths(tableXml([3000, 6000], [rowXml(cellXml("a"), cellXml("b"))], props))).toEqual([[null, null]]);
  }
});

test("a_table_wider_than_the_text_of_the_page_is_scaled_down_to_fit_it", async () => {
  // Letter's text is 9360 twips wide; this grid is 18000, so every column is cut to 9360/18000 of what it was
  expect(await widths(tableXml([9000, 9000], [rowXml(cellXml("a"), cellXml("b"))], '<w:tblW w:w="18000" w:type="dxa"/>'))).toEqual([[[312], [312]]]);
  // a table that fits is left as it was
  expect(await widths(tableXml([4000, 5000], [rowXml(cellXml("a"), cellXml("b"))]))).toEqual([[[267], [333]]]);
});

test("a_table_in_fixed_layout_is_read_from_its_grid_whatever_its_width", async () => {
  const props = '<w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/>';
  expect(await widths(tableXml([1500, 4500], [rowXml(cellXml("a"), cellXml("b"))], props))).toEqual([[[100], [300]]]);
});

// ---------------------------------------------------------------- export

const cell = (text: string, colwidth: number[] | null, rowspan = 1): JSONContent => ({
  type: "tableCell",
  attrs: { colspan: colwidth?.length ?? 1, rowspan, colwidth },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const tableDoc = (...rows: JSONContent[][]): JSONContent => ({
  type: "doc",
  content: [{ type: "table", content: rows.map((cells) => ({ type: "tableRow", content: cells })) }],
});
const bodyXml = async (doc: JSONContent) => (await (await JSZip.loadAsync(await exportDocx(doc))).file("word/document.xml")!.async("string"));
const grid = (xml: string) => [...xml.matchAll(/<w:gridCol w:w="(\d+)"/g)].map((m) => Number(m[1]));
// The library writes an element's attributes in an order of its own, so look at them one by one.
const tag = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]);
const attrOf = (element: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(element)?.[1];

test("dragged_widths_are_written_as_a_fixed_grid_and_as_the_width_of_each_cell", async () => {
  const xml = await bodyXml(tableDoc([cell("a", [200]), cell("b", [400])]));
  expect(grid(xml)).toEqual([3000, 6000]);
  expect(tag(xml, "w:tblLayout").map((t) => attrOf(t, "w:type"))).toEqual(["fixed"]);
  const [table] = tag(xml, "w:tblW");
  expect([attrOf(table, "w:type"), attrOf(table, "w:w")]).toEqual(["dxa", "9000"]);
  const cells = tag(xml, "w:tcW");
  expect(cells.map((t) => [attrOf(t, "w:type"), Number(attrOf(t, "w:w"))])).toEqual([["dxa", 3000], ["dxa", 6000]]);
});

test("a_table_nobody_resized_is_still_as_wide_as_the_page", async () => {
  const xml = await bodyXml(tableDoc([cell("a", null), cell("b", null)]));
  expect(tag(xml, "w:tblLayout")).toEqual([]);
  const [table] = tag(xml, "w:tblW");
  expect([attrOf(table, "w:type"), attrOf(table, "w:w")]).toEqual(["pct", "5000"]);
});

test("a_column_nobody_resized_takes_what_the_others_leave_of_the_page", async () => {
  // Letter's text is 9360 twips wide; the first column is 3000 of it
  expect(grid(await bodyXml(tableDoc([cell("a", [200]), cell("b", null)])))).toEqual([3000, 6360]);
});

test("widths_are_counted_by_grid_column_below_a_cell_that_spans_rows", async () => {
  const xml = await bodyXml(tableDoc([cell("a", [100], 2), cell("b", [300])], [cell("c", [300])]));
  expect(grid(xml)).toEqual([1500, 4500]);
});

test("dragged_widths_survive_a_save_and_reopen", async () => {
  const original = tableDoc([cell("a", [200, 100]), cell("b", [300])], [cell("c", [200]), cell("d", [100]), cell("e", [300])]);
  const { doc, dropped } = await importDocx(await exportDocx(original));
  expect(doc).toEqual(normalize(original));
  expect(dropped).toEqual([]);
});

// ---------------------------------------------------------------- row heights

const tall = (height: number | null): JSONContent => ({
  type: "tableRow",
  ...(height && { attrs: { height } }),
  content: [cell("a", null)],
});
const docOf = (...rows: JSONContent[]): JSONContent => ({ type: "doc", content: [{ type: "table", content: rows }] });

test("a_row_height_is_written_as_a_minimum_in_twips_and_read_back", async () => {
  const xml = await bodyXml(docOf(tall(40), tall(null)));
  const heights = tag(xml, "w:trHeight");
  expect(heights.map((t) => [attrOf(t, "w:val"), attrOf(t, "w:hRule")])).toEqual([["600", "atLeast"]]);

  const { doc } = await importDocx(await exportDocx(docOf(tall(40), tall(null))));
  expect(doc.content![0].content!.map((row) => row.attrs?.height ?? null)).toEqual([40, null]);
});

test("a_row_height_from_word_is_read_unless_the_row_is_auto", async () => {
  const row = (trPr: string) => `<w:tr><w:trPr>${trPr}</w:trPr><w:tc><w:tcPr/><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc></w:tr>`;
  const body = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>${[
    row('<w:trHeight w:val="900"/>'),
    row('<w:trHeight w:val="900" w:hRule="exact"/>'),
    row('<w:trHeight w:val="900" w:hRule="auto"/>'),
    row(""),
  ].join("")}</w:tbl>`;
  const { doc } = await importDocx(await buildDocx({ document: body }));
  expect(doc.content![0].content!.map((r) => r.attrs?.height ?? null)).toEqual([60, 60, null, null]);
});
