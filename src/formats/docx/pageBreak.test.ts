import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import { expect, test } from "vitest";
import { exportDocx } from "./export";
import { importDocx } from "./import";
import { buildDocx, normalize } from "./testing";

const types = (doc: JSONContent) => doc.content!.map((n) => n.type);
const run = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`;
const BREAK = '<w:r><w:br w:type="page"/></w:r>';
const read = async (body: string) => (await importDocx(await buildDocx({ document: body }))).doc;

test("a_page_break_run_splits_its_paragraph_in_two", async () => {
  const doc = await read(`<w:p>${run("before")}${BREAK}${run("after")}</w:p>`);
  expect(types(doc)).toEqual(["paragraph", "pageBreak", "paragraph"]);
});

test("a_paragraph_holding_only_a_page_break_leaves_no_empty_paragraph_behind", async () => {
  const doc = await read(`<w:p>${run("one")}</w:p><w:p>${BREAK}</w:p><w:p>${run("two")}</w:p>`);
  expect(types(doc)).toEqual(["paragraph", "pageBreak", "paragraph"]);
});

test("page_break_before_puts_the_break_ahead_of_the_paragraph", async () => {
  const doc = await read(`<w:p>${run("one")}</w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr>${run("two")}</w:p>`);
  expect(types(doc)).toEqual(["paragraph", "pageBreak", "paragraph"]);
});

test("page_break_before_set_to_false_is_no_break", async () => {
  const doc = await read(`<w:p><w:pPr><w:pageBreakBefore w:val="0"/></w:pPr>${run("one")}</w:p>`);
  expect(types(doc)).toEqual(["paragraph"]);
});

test("a_next_page_section_break_ends_the_page_a_continuous_one_does_not", async () => {
  const section = (type: string) => `<w:pPr><w:sectPr>${type}<w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr>`;
  const next = await read(`<w:p>${section("")}${run("one")}</w:p><w:p>${run("two")}</w:p>`);
  expect(types(next)).toEqual(["paragraph", "pageBreak", "paragraph"]);
  const explicit = await read(`<w:p>${section('<w:type w:val="nextPage"/>')}${run("one")}</w:p><w:p>${run("two")}</w:p>`);
  expect(types(explicit)).toEqual(["paragraph", "pageBreak", "paragraph"]);
  const continuous = await read(`<w:p>${section('<w:type w:val="continuous"/>')}${run("one")}</w:p><w:p>${run("two")}</w:p>`);
  expect(types(continuous)).toEqual(["paragraph", "paragraph"]);
});

test("a_page_break_inside_a_table_cell_is_not_kept", async () => {
  const doc = await read(
    `<w:tbl><w:tr><w:tc><w:p>${run("cell")}${BREAK}${run("more")}</w:p></w:tc></w:tr></w:tbl>`,
  );
  const cell = doc.content![0].content![0].content![0];
  expect(cell.content!.map((n) => n.type)).toEqual(["paragraph", "paragraph"]);
});

test("exports_a_page_break_as_a_page_break_run", async () => {
  const bytes = await exportDocx({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }, { type: "pageBreak" }],
  });
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  expect(xml).toContain('<w:br w:type="page"/>');
});

test("a_page_break_survives_a_round_trip", async () => {
  const original: JSONContent = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "satu" }] },
      { type: "pageBreak" },
      { type: "paragraph", content: [{ type: "text", text: "dua" }] },
    ],
  };
  const { doc, dropped } = await importDocx(await exportDocx(original));
  expect(doc).toEqual(normalize(original));
  expect(dropped).toEqual([]);
});
