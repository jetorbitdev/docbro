import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import { expect, test } from "vitest";
import { emptyMeta, type DocLook } from "../../doc/meta";
import { exportDocx } from "./export";
import { importDocx } from "./import";
import { buildDocx } from "./testing";

// How Google Docs writes a document: the defaults in w:docDefaults, an empty Normal, the size on every run.
const GOOGLE_STYLES =
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="400" w:after="120"/></w:pPr><w:rPr><w:sz w:val="40"/></w:rPr></w:style>';
const run = (text: string, rPr = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/>') =>
  `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const p = (runs: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
const SECTION = '<w:sectPr><w:pgSz w:w="11909" w:h="16834"/><w:pgMar w:top="1000" w:right="1200" w:bottom="1100" w:left="1300" w:header="600" w:footer="500"/></w:sectPr>';

const read = async (document: string, styles = GOOGLE_STYLES) => importDocx(await buildDocx({ document: document + SECTION, styles }));

test("the_look_is_the_type_most_of_the_text_is_in_with_the_defaults_spacing_headings_and_margins", async () => {
  const body =
    p(run("Judul besar sekali", ""), '<w:pStyle w:val="Heading1"/>') + // a heading's text is not counted
    p(run("Teks utama yang panjang sekali di dokumen ini.")) +
    p(run("pendek", '<w:rFonts w:ascii="Arial"/><w:sz w:val="18"/>'));
  const { meta } = await read(body);
  expect(meta.look).toEqual<DocLook>({
    font: "Times New Roman",
    size: 24,
    spacing: { line: 276, lineRule: "auto" },
    headings: [
      { size: 40, spacing: { before: 400, after: 120, line: 276, lineRule: "auto" } },
      { size: null, spacing: { line: 276, lineRule: "auto" } }, // no style of its own: the document's defaults
      { size: null, spacing: { line: 276, lineRule: "auto" } },
    ],
    margins: { top: 1000, right: 1200, bottom: 1100, left: 1300, header: 600, footer: 500 },
  });
});

test("a_typeface_from_the_theme_is_named_by_it", async () => {
  const styles = '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>';
  const zip = await JSZip.loadAsync(await buildDocx({ document: p('<w:r><w:t>Isi</w:t></w:r>'), styles }));
  zip.file("word/theme/theme1.xml", '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme name="Office">' +
    '<a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>');
  const { meta } = await importDocx(await zip.generateAsync({ type: "uint8array" }));
  expect(meta.look).toMatchObject({ font: "Aptos", size: 24 });
});

test("a_paragraph_keeps_only_the_spacing_that_differs_from_its_kinds_and_its_first_line_indent", async () => {
  const body =
    p(run("biasa")) +
    p(run("rapat"), '<w:spacing w:line="240" w:lineRule="auto"/>') +
    p(run("lebar"), '<w:spacing w:before="120" w:after="240" w:line="360" w:lineRule="exact"/>') +
    p(run("menjorok"), '<w:ind w:firstLine="720"/>') +
    p(run("menggantung"), '<w:ind w:left="720" w:hanging="360"/>') +
    p(run("Judul", ""), '<w:pStyle w:val="Heading1"/>');
  const { doc } = await read(body);
  const attrs = doc.content!.map((n) => ({ spacing: n.attrs!.spacing ?? null, firstLine: n.attrs!.firstLine ?? null }));
  expect(attrs).toEqual([
    { spacing: null, firstLine: null },
    { spacing: { line: 240, lineRule: "auto" }, firstLine: null },
    { spacing: { before: 120, after: 240, line: 360, lineRule: "exact" }, firstLine: null },
    { spacing: null, firstLine: 720 },
    { spacing: null, firstLine: -360 },
    { spacing: null, firstLine: null }, // a heading as its style spaces it
  ]);
});

const lookDoc: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Judul" }] },
    { type: "paragraph", attrs: { spacing: { line: 360, lineRule: "auto" }, firstLine: 720 }, content: [{ type: "text", text: "Isi" }] },
    { type: "paragraph", attrs: { spacing: { before: 0, after: 200 }, firstLine: -360 }, content: [{ type: "text", text: "Gantung" }] },
  ],
};
const LOOK: DocLook = {
  font: "Times New Roman",
  size: 24,
  spacing: { line: 276, lineRule: "auto" },
  headings: [
    { size: 40, spacing: { before: 400, after: 120, line: 276, lineRule: "auto" } },
    { size: 32, spacing: { before: 360, after: 120, line: 276, lineRule: "auto" } },
    { size: 28, spacing: { before: 320, after: 80, line: 276, lineRule: "auto" } },
  ],
  margins: { top: 1000, right: 1200, bottom: 1100, left: 1300, header: 600, footer: 500 },
};

test("the_look_and_each_paragraphs_spacing_and_indent_survive_a_save_and_reopen", async () => {
  const again = await importDocx(await exportDocx(lookDoc, { ...emptyMeta(), pageSize: "a4", look: LOOK }));
  expect(again.meta.look).toEqual(LOOK);
  expect(again.doc.content!.map((n) => [n.attrs!.spacing ?? null, n.attrs!.firstLine ?? null])).toEqual([
    [null, null],
    [{ line: 360, lineRule: "auto" }, 720],
    [{ after: 200 }, -360], // a space before of 0 is the document's own
  ]);
});

test("a_document_without_a_look_is_still_written_in_docbros_type", async () => {
  const bytes = await exportDocx({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Isi" }] }] }, emptyMeta());
  const styles = await (await JSZip.loadAsync(bytes)).file("word/styles.xml")!.async("string");
  expect(styles).toMatch(/<w:rFonts w:ascii="Calibri"/);
  expect(styles).toMatch(/<w:sz w:val="22"\/>/);
});
