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
  expect(mixed.marks).toEqual([{ type: "textStyle", attrs: { color: "#cc0000", fontFamily: "Verdana" } }]);
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
