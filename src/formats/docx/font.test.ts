import type { JSONContent } from "@tiptap/core";
import { expect, test } from "vitest";
import { exportDocx } from "./export";
import { importDocx } from "./import";
import { buildDocx } from "./testing";

const STYLES =
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="normal"/></w:style>';
const run = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const read = async (runs: string) => importDocx(await buildDocx({ document: `<w:p>${runs}</w:p>`, styles: STYLES }));
const styleOf = (node: JSONContent) => node.marks?.find((m) => m.type === "textStyle")?.attrs;

test("a_run_in_another_typeface_than_the_pages_keeps_it_and_one_in_the_pages_own_does_not", async () => {
  const { doc, meta } = await read(
    run("Teks utama yang panjang sekali di dokumen ini. ") +
    run("sama", '<w:rFonts w:ascii="times new roman" w:hAnsi="times new roman"/>') +
    run("lain", '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>'),
  );
  expect(meta.look?.font).toBe("Times New Roman");
  const texts = doc.content![0].content!;
  expect(texts.map((n) => [n.text, styleOf(n)?.fontFamily ?? null])).toEqual([
    ["Teks utama yang panjang sekali di dokumen ini. sama", null],
    ["lain", "Georgia"],
  ]);
});

test("a_font_and_a_color_on_one_run_are_one_text_style_mark", async () => {
  const { doc } = await read(
    run("Teks utama yang panjang sekali di dokumen ini. ") +
    run("campur", '<w:rFonts w:ascii="Verdana"/><w:color w:val="cc0000"/>'),
  );
  const mixed = doc.content![0].content!.find((n) => n.text === "campur")!;
  expect(mixed.marks).toEqual([{ type: "textStyle", attrs: { color: "#cc0000", fontFamily: "Verdana", fontSize: null } }]);
});

test("a_font_written_by_the_exporter_is_read_back", async () => {
  const doc: JSONContent = {
    type: "doc",
    content: [{ type: "paragraph", content: [
      { type: "text", text: "Teks utama yang panjang sekali di dokumen ini. " },
      { type: "text", text: "kode", marks: [{ type: "textStyle", attrs: { fontFamily: "Courier New" } }] },
    ] }],
  };
  const bytes = await exportDocx(doc);
  const JSZip = (await import("jszip")).default;
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  expect(xml).toMatch(/<w:rFonts [^>]*w:ascii="Courier New"/);
  const back = await importDocx(bytes);
  expect(back.doc.content![0].content!.map((n) => [n.text, styleOf(n)?.fontFamily ?? null])).toEqual([
    ["Teks utama yang panjang sekali di dokumen ini. ", null],
    ["kode", "Courier New"],
  ]);
});

test("text_without_a_font_writes_no_rfonts", async () => {
  const JSZip = (await import("jszip")).default;
  const bytes = await exportDocx({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "polos" }] }] });
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  expect(xml).not.toContain("<w:rFonts");
});

// ------------------------------------------------------------------ sizes

const sizeOfRun = (node: JSONContent) => styleOf(node)?.fontSize ?? null;
const runs = (doc: JSONContent) => doc.content![0].content!.map((n) => [n.text, sizeOfRun(n)]);

test("a_run_in_another_size_than_its_paragraphs_keeps_it_and_one_in_the_bodys_own_does_not", async () => {
  const { doc, meta } = await read(
    run("Teks utama yang panjang sekali di dokumen ini. ") + // 12 pt, from the defaults
    run("sama", '<w:sz w:val="24"/>') +
    run("besar", '<w:sz w:val="36"/>') +
    run("kecil", '<w:sz w:val="19"/>'),
  );
  expect(meta.look?.size).toBe(24);
  expect(runs(doc)).toEqual([
    ["Teks utama yang panjang sekali di dokumen ini. sama", null],
    ["besar", 18],
    ["kecil", 9.5],
  ]);
});

test("a_heading_run_is_compared_with_its_headings_size_not_the_bodys", async () => {
  const styles = STYLES +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="40"/></w:rPr></w:style>';
  const heading = (runs: string) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${runs}</w:p>`;
  const body = run("Teks utama yang panjang sekali di dokumen ini.");
  const { doc } = await importDocx(await buildDocx({
    document: `<w:p>${body}</w:p>` + heading(run("Judul", '<w:sz w:val="40"/>')) + heading(run("Judul kecil", '<w:sz w:val="28"/>')),
    styles,
  }));
  const [, h1, h2] = doc.content!;
  expect(h1.content!.map(sizeOfRun)).toEqual([null]); // 20 pt is what a Heading 1 is
  expect(h2.content!.map(sizeOfRun)).toEqual([14]);
});

test("a_size_written_by_the_exporter_is_read_back_in_half_points", async () => {
  const JSZip = (await import("jszip")).default;
  const bytes = await exportDocx({
    type: "doc",
    content: [{ type: "paragraph", content: [
      { type: "text", text: "Teks utama yang panjang sekali di dokumen ini. " },
      { type: "text", text: "besar", marks: [{ type: "textStyle", attrs: { fontSize: 18 } }] },
      { type: "text", text: "setengah", marks: [{ type: "textStyle", attrs: { fontSize: 10.5 } }] },
    ] }],
  });
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  expect(xml).toMatch(/<w:sz w:val="36"\/>/);
  expect(xml).toMatch(/<w:sz w:val="21"\/>/);
  const back = await importDocx(bytes);
  expect(runs(back.doc)).toEqual([["Teks utama yang panjang sekali di dokumen ini. ", null], ["besar", 18], ["setengah", 10.5]]);
});

test("text_without_a_size_writes_no_run_size", async () => {
  const JSZip = (await import("jszip")).default;
  const bytes = await exportDocx({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "polos" }] }] });
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  expect(xml).not.toContain("<w:sz ");
});
