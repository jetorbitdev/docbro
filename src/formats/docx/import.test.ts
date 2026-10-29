import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import { expect, test } from "vitest";
import { exportDocx } from "./export";
import { fixtureDoc } from "./fixture";
import { importDocx } from "./import";
import {
  BODY_WITH_INS_DEL_AND_TEXTBOX,
  WORD_NUMBERING,
  WORD_STYLES,
  WORD_STYLE_BODY,
  buildDocx,
  findMark,
  normalize,
  plainText,
  zipWith,
} from "./testing";

test("round_trips_every_supported_node_and_mark", async () => {
  const { doc, dropped } = await importDocx(await exportDocx(fixtureDoc()));
  expect(doc).toEqual(normalize(fixtureDoc()));
  expect(dropped).toEqual([]);
});

test("reads_word_style_names_lists_and_highlight", async () => {
  const bytes = await buildDocx({ document: WORD_STYLE_BODY, styles: WORD_STYLES, numbering: WORD_NUMBERING });
  const { doc } = await importDocx(bytes);
  expect(doc.content!.map((n) => n.type)).toEqual(["heading", "paragraph", "blockquote", "bulletList", "orderedList"]);
  expect(doc.content![0].attrs!.level).toBe(1);           // "Title" style
  expect(findMark(doc, "highlight")!.attrs!.color).toBe("#ffff00"); // w:highlight="yellow"
});

test("reports_parts_it_cannot_keep", async () => {
  const bytes = await buildDocx({ document: BODY_WITH_INS_DEL_AND_TEXTBOX, header: true, comments: true });
  const { doc, dropped } = await importDocx(bytes);
  expect(dropped).toEqual(expect.arrayContaining(["headers", "comments", "tracked_changes", "other_content"]));
  expect(plainText(doc)).toContain("inserted");
  expect(plainText(doc)).not.toContain("deleted");
});

test("refuses_a_zip_that_is_not_a_word_document", async () => {
  await expect(importDocx(await zipWith({ "hello.txt": "hi" }))).rejects.toThrow("Not a Word document");
});

// ---------------------------------------------------------------------------

type Mark = NonNullable<JSONContent["marks"]>[number];

const p = (runs: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
const r = (text: string, rPr = "") =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const numPr = (numId: number, ilvl = 0) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
const style = (id: string, name: string, extra = "") =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
const picture = (rId: string, descr: string) =>
  '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="9525" cy="9525"/>' +
  `<wp:docPr id="1" name="Picture 1" descr="${descr}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
  `<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name=""/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/>` +
  "<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>";

const read = async (parts: Parameters<typeof buildDocx>[0]) => importDocx(await buildDocx(parts));
const readBody = async (document: string, parts: Omit<Parameters<typeof buildDocx>[0], "document"> = {}) =>
  (await read({ document, ...parts })).doc;

const t = (text: string, ...marks: Mark[]): JSONContent => (marks.length ? { type: "text", text, marks } : { type: "text", text });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const item = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

// Add files and relationships to a package made by `buildDocx`.
async function withParts(bytes: Uint8Array, files: Record<string, string | Uint8Array>, rels: string[]) {
  const zip = await JSZip.loadAsync(bytes);
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const path = "word/_rels/document.xml.rels";
  zip.file(path, (await zip.file(path)!.async("string")).replace("</Relationships>", `${rels.join("")}</Relationships>`));
  return zip.generateAsync({ type: "uint8array" });
}
const imageRel = (id: string, target: string) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;

test("keeps_spaces_tabs_and_breaks_inside_runs", async () => {
  const result = await readBody(
    p('<w:r><w:t xml:space="preserve">  dua spasi </w:t><w:tab/><w:t xml:space="preserve"> lalu tab  </w:t><w:br/><w:t>baris</w:t><w:br w:type="page"/></w:r>') +
    p("<w:r><w:t>  tanpa preserve  </w:t></w:r>"),
  );
  expect(result.content![0].content).toEqual([t("  dua spasi \t lalu tab  "), { type: "hardBreak" }, t("baris")]);
  expect(result.content![1].content).toEqual([t("tanpa preserve")]);
});

test("an_empty_document_is_one_empty_paragraph", async () => {
  const empty = normalize(doc({ type: "paragraph" }));
  for (const bytes of [await buildDocx({ document: "" }), await buildDocx({ document: "<w:sectPr/>" }), await exportDocx(doc())]) {
    const { doc: result, dropped } = await importDocx(bytes);
    expect(result).toEqual(empty);
    expect(dropped).toEqual([]);
  }
});

test("a_table_cell_keeps_all_its_paragraphs", async () => {
  const result = await readBody(
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid><w:tr>' +
    `<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr>${p(r("satu"))}<w:p/>${p(r("tiga"), '<w:pStyle w:val="Heading2"/>')}</w:tc>` +
    "<w:tc><w:tcPr><w:tcW w:w=\"4680\" w:type=\"dxa\"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>",
  );
  const [first, second] = result.content![0].content![0].content!;
  expect(first.content!.map((n) => n.type)).toEqual(["paragraph", "paragraph", "heading"]);
  expect(plainText(first)).toBe("satu\n\ntiga");
  expect(second).toEqual(normalize(doc({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }] }] })).content![0].content![0].content![0]);
});

test("a_list_that_starts_below_the_first_level_is_kept", async () => {
  const result = await readBody(
    p(r("dalam"), numPr(1, 1)) + p(r("luar"), numPr(1, 0)) + p(r("dalam lagi"), numPr(1, 1)),
    { numbering: WORD_NUMBERING },
  );
  expect(result).toEqual(normalize(doc(
    { type: "bulletList", content: [item(para(t("dalam")))] },
    { type: "bulletList", content: [item(para(t("luar")), { type: "bulletList", content: [item(para(t("dalam lagi")))] })] },
  )));
});

test("an_unknown_paragraph_style_is_a_plain_paragraph", async () => {
  const result = await readBody(p(r("x"), '<w:pStyle w:val="TidakAda"/>'), { styles: WORD_STYLES });
  expect(result).toEqual(normalize(doc(para(t("x")))));
  // With no styles part at all, a built-in style id still says what it is.
  expect((await readBody(p(r("y"), '<w:pStyle w:val="Heading2"/>'))).content![0].attrs!.level).toBe(2);
});

test("a_damaged_zip_is_refused_with_a_readable_error", async () => {
  const good = await exportDocx(fixtureDoc());
  const flipped = good.slice();
  for (let i = 1500; i < 1600; i++) flipped[i] ^= 0xff;
  for (const bytes of [good.slice(0, good.length / 2), good.slice(0, 100), flipped, new Uint8Array([1, 2, 3]), new Uint8Array()]) {
    const error = await importDocx(bytes).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^(Not a Word document|This Word document is damaged)/);
  }
});

test("a_zip_whose_checksum_does_not_match_is_refused_rather_than_read_wrong", async () => {
  const zip = await JSZip.loadAsync(await buildDocx({ document: p(r("Halo dunia")) }));
  const stored = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
  const at = Buffer.from(stored).indexOf("Halo dunia");
  expect(at).toBeGreaterThan(0);
  stored[at + 3] = "u".charCodeAt(0); // "Halu dunia": still valid XML, so only the CRC can tell
  await expect(importDocx(stored)).rejects.toThrow(/^Not a Word document, or the file is damaged$/);
});

test("values_from_the_file_never_reach_object_prototype_keys", async () => {
  const bytes = await withParts(
    await buildDocx({ document: p(r("x", '<w:highlight w:val="constructor"/>') + picture("rIdP", "p"), '<w:jc w:val="toString"/>') }),
    { "word/media/a.constructor": "x" },
    [imageRel("rIdP", "media/a.constructor")],
  );
  const { doc: result, dropped } = await importDocx(bytes);
  expect(result).toEqual(normalize(doc(para(t("x")))));
  expect(dropped).toEqual(["other_content"]);
});

test("an_old_or_password_protected_word_file_gets_its_own_message", async () => {
  const ole = new Uint8Array(512);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  await expect(importDocx(ole)).rejects.toThrow(/password-protected or in the old \.doc format/);
});

test("malformed_xml_is_refused_with_a_readable_error", async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  await expect(importDocx(await zipWith({ "word/document.xml": `<w:document ${W}><w:body><w:p><w:r><w:t>rusak</w:body>` })))
    .rejects.toThrow("This Word document is damaged: word/document.xml is not valid XML");
  await expect(read({ document: p(r("ok")), styles: "<w:style><w:name></w:style>" }))
    .rejects.toThrow("This Word document is damaged: word/styles.xml is not valid XML");
  await expect(importDocx(await zipWith({ "word/document.xml": `<w:document ${W}></w:document>` })))
    .rejects.toThrow("This Word document is damaged: it has no body");
  await expect(importDocx(await zipWith({ "word/document.xml": '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body/></w:document>' })))
    .rejects.toThrow(/Strict Open XML/);
});

test("a_picture_whose_file_is_missing_is_skipped", async () => {
  const bytes = await withParts(
    await buildDocx({ document: p(r("sebelum")) + p(picture("rIdImg", "Hilang")) + p(r("sesudah")) }),
    {},
    [imageRel("rIdImg", "media/tidak-ada.png")],
  );
  const { doc: result, dropped } = await importDocx(bytes);
  // The paragraph that held it stays, as the empty line Word shows.
  expect(result).toEqual(normalize(doc(para(t("sebelum")), { type: "paragraph" }, para(t("sesudah")))));
  expect(dropped).toEqual([]);
});

test("reads_pictures_by_their_extension_and_skips_formats_a_browser_cannot_show", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const bytes = await withParts(
    await buildDocx({ document: p(r("teks ") + picture("rIdA", "Foto") + r(" lanjut")) + p(picture("rIdB", "")) + p(picture("rIdC", "Grafik")) }),
    { "word/media/foto.JPEG": jpeg, "word/media/b.gif": new Uint8Array([0x47, 0x49, 0x46]), "word/media/c.emf": new Uint8Array([1, 0, 0, 0]) },
    [imageRel("rIdA", "media/foto.JPEG"), imageRel("rIdB", "/word/media/b.gif"), imageRel("rIdC", "media/c.emf")],
  );
  const { doc: result, dropped } = await importDocx(bytes);
  expect(result).toEqual(normalize(doc(
    para(t("teks ")),
    { type: "image", attrs: { src: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`, alt: "Foto" } },
    para(t(" lanjut")),
    { type: "image", attrs: { src: "data:image/gif;base64,R0lG", alt: null } },
    { type: "paragraph" },
  )));
  expect(dropped).toEqual(["other_content"]);
});

test("round_trips_merged_cells_multi_paragraph_items_and_adjacent_lists", async () => {
  const link: Mark = { type: "link", attrs: { href: "https://example.com/a?b=1&c=2" } };
  const cell = (colspan: number, rowspan: number, ...content: JSONContent[]): JSONContent =>
    ({ type: "tableCell", attrs: { colspan, rowspan }, content: content.length ? content : [{ type: "paragraph" }] });
  const original = doc(
    para(t("klik "), t("di ", link), t("sini", link, { type: "bold" }), t(" ya", link)),
    { type: "paragraph" },
    { type: "blockquote", content: [para(t("kutipan satu")), para(t("kutipan dua"))] },
    {
      type: "orderedList",
      attrs: { start: 1 },
      content: [
        item(para(t("A")), { type: "bulletList", content: [item(para(t("A1")))] }, para(t("A lanjutan"))),
        item(para(t("B"))),
      ],
    },
    { type: "orderedList", attrs: { start: 5 }, content: [item(para(t("lima")))] },
    {
      type: "table",
      content: [
        { type: "tableRow", content: [cell(2, 1, para(t("lebar")))] },
        { type: "tableRow", content: [cell(1, 2, para(t("tinggi"))), cell(1, 1)] },
        { type: "tableRow", content: [cell(1, 1, para(t("c")))] },
      ],
    },
    { type: "image", attrs: { src: fixtureDoc().content!.find((n) => n.type === "image")!.attrs!.src, alt: null } },
    { type: "heading", attrs: { level: 2, textAlign: "justify" }, content: [t("Akhir", { type: "underline" }, { type: "highlight", attrs: { color: "#00ff00" } })] },
  );
  const { doc: result, dropped } = await importDocx(await exportDocx(original));
  expect(result).toEqual(normalize(original));
  expect(dropped).toEqual([]);
});

test("reads_localized_and_derived_heading_styles", async () => {
  const styles =
    style("Normal", "Normal") +
    style("berschrift1", "heading 1", '<w:basedOn w:val="Normal"/>') +
    style("Heading2", "heading 2", '<w:basedOn w:val="Normal"/>') +
    style("Fancy", "Fancy Heading", '<w:basedOn w:val="Heading2"/>') +
    style("Heading4", "heading 4", '<w:basedOn w:val="Normal"/>') +
    style("IntenseQuote", "Intense Quote", '<w:basedOn w:val="Normal"/>') +
    style("Loop1", "Loop 1", '<w:basedOn w:val="Loop2"/>') +
    style("Loop2", "Loop 2", '<w:basedOn w:val="Loop1"/>');
  const result = await readBody(
    ["berschrift1", "Fancy", "Heading4", "IntenseQuote", "Loop1"].map((id) => p(r(id), `<w:pStyle w:val="${id}"/>`)).join(""),
    { styles },
  );
  expect(result.content!.map((n) => [n.type, n.attrs?.level])).toEqual([
    ["heading", 1], ["heading", 2], ["paragraph", undefined], ["blockquote", undefined], ["paragraph", undefined],
  ]);
});

test("reads_word_alignment_and_run_properties", async () => {
  const result = await readBody(
    p(r("a"), '<w:jc w:val="left"/>') + p(r("b"), '<w:jc w:val="right"/>') + p(r("c"), '<w:jc w:val="both"/>') +
    p(r("d"), '<w:pStyle w:val="Quote"/>') +
    p(
      r("bukan tebal", '<w:b w:val="0"/><w:color w:val="auto"/><w:shd w:val="clear" w:color="auto" w:fill="auto"/><w:u w:val="none"/><w:highlight w:val="none"/>') +
      r("merah", '<w:b w:val="1"/><w:color w:val="FF0000"/><w:dstrike/><w:u w:val="double"/><w:highlight w:val="darkBlue"/><w:shd w:fill="FFFF00"/>'),
    ),
    { styles: WORD_STYLES },
  );
  expect(result.content!.slice(0, 3).map((n) => n.attrs!.textAlign)).toEqual(["left", "right", "justify"]);
  expect(result.content![3].content![0].attrs!.textAlign).toBe("center"); // from the Quote style
  expect(result.content![4]).toEqual(normalize(doc(para(
    t("bukan tebal"),
    t("merah", { type: "bold" }, { type: "underline" }, { type: "strike" },
      { type: "textStyle", attrs: { color: "#ff0000" } }, { type: "highlight", attrs: { color: "#000080" } }),
  ))).content![0]);
});

test("reads_list_numbering_from_word", async () => {
  const numbering = WORD_NUMBERING +
    '<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride></w:num>';
  const styles = WORD_STYLES + style("ListBullet", "List Bullet", `<w:basedOn w:val="Normal"/><w:pPr>${numPr(1)}</w:pPr>`);
  const result = await readBody(
    p(r("satu"), numPr(2)) + p(r("dua"), numPr(2)) + p(r("sela")) + p(r("tiga"), numPr(2)) +
    p(r("tujuh"), numPr(3)) +
    p(r("gaya"), '<w:pStyle w:val="ListBullet"/>') +
    p(r("bukan daftar"), `<w:pStyle w:val="ListBullet"/>${numPr(0)}`) +
    p(r("tak dikenal"), numPr(42)) +
    p(r("Bab"), `<w:pStyle w:val="Heading1"/>${numPr(2)}`), // a numbered heading stays a heading
    { styles, numbering },
  );
  expect(result).toEqual(normalize(doc(
    { type: "orderedList", attrs: { start: 1 }, content: [item(para(t("satu"))), item(para(t("dua")))] },
    para(t("sela")),
    { type: "orderedList", attrs: { start: 3 }, content: [item(para(t("tiga")))] },
    { type: "orderedList", attrs: { start: 7 }, content: [item(para(t("tujuh")))] },
    { type: "bulletList", content: [item(para(t("gaya")))] },
    para(t("bukan daftar")),
    para(t("tak dikenal")),
    { type: "heading", attrs: { level: 1 }, content: [t("Bab")] },
  )));
  // Without a numbering part there is nothing to number with.
  expect(await readBody(p(r("x"), numPr(1)))).toEqual(normalize(doc(para(t("x")))));
});

test("reads_older_vml_pictures_and_horizontal_lines_and_list_style_links", async () => {
  const numbering = WORD_NUMBERING +
    '<w:abstractNum w:abstractNumId="9"><w:numStyleLink w:val="BulletStyle"/></w:abstractNum><w:num w:numId="9"><w:abstractNumId w:val="9"/></w:num>';
  const styles = `<w:style w:type="numbering" w:styleId="BulletStyle"><w:name w:val="Bullet Style"/><w:pPr>${numPr(1)}</w:pPr></w:style>`;
  const bytes = await withParts(
    await buildDocx({
      document:
        p('<w:r><w:pict><v:rect id="_x0000_i1025" style="width:0;height:1.5pt" o:hralign="center" o:hrstd="t" o:hr="t" fillcolor="#a0a0a0" stroked="f"/></w:pict></w:r>') +
        p('<w:r><w:pict><v:shape id="_x0000_i1026" type="#_x0000_t75" style="width:10pt;height:10pt"><v:imagedata r:id="rIdV" o:title="Logo"/></v:shape></w:pict></w:r>') +
        p(r("tertaut"), numPr(9)),
      styles,
      numbering,
    }),
    { "word/media/v.png": "png" },
    [imageRel("rIdV", "media/v.png")],
  );
  const { doc: result } = await importDocx(bytes);
  expect(result).toEqual(normalize(doc(
    { type: "horizontalRule" },
    { type: "image", attrs: { src: "data:image/png;base64,cG5n", alt: "Logo" } },
    { type: "bulletList", content: [item(para(t("tertaut")))] },
  )));
});

test("reads_content_controls_fields_and_only_safe_links", async () => {
  const bytes = await withParts(
    await buildDocx({
      document:
        `<w:sdt><w:sdtPr><w:alias w:val="Judul"/></w:sdtPr><w:sdtContent>${p(r("dalam kontrol"))}</w:sdtContent></w:sdt>` +
        p(
          '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE \\@ "d MMMM yyyy" </w:instrText></w:r>' +
          `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r("29 Oktober 2026")}<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
          `<w:fldSimple w:instr=" PAGE ">${r(" hal 1")}</w:fldSimple>`,
        ) +
        p(
          `<w:hyperlink r:id="rIdJs">${r("jahat")}</w:hyperlink>` +
          `<w:hyperlink w:anchor="_Toc1">${r(" jangkar")}</w:hyperlink>` +
          `<w:hyperlink r:id="rIdOk">${r(" aman", '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>`,
        ),
    }),
    {},
    [
      '<Relationship Id="rIdJs" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>',
      '<Relationship Id="rIdOk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:rina@example.com" TargetMode="External"/>',
    ],
  );
  const { doc: result } = await importDocx(bytes);
  expect(result).toEqual(normalize(doc(
    para(t("dalam kontrol")),
    para(t("29 Oktober 2026 hal 1")),
    para(t("jahat jangkar"), t(" aman", { type: "link", attrs: { href: "mailto:rina@example.com" } })),
  )));
});

test("reports_footnotes_page_setup_and_equations", async () => {
  const footnotes = (ids: string) => `<?xml version="1.0"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${ids}</w:footnotes>`;
  // Word writes its separator lines as ids -1 and 0; older files use 0 and 1.
  const separators = '<w:footnote w:type="separator" w:id="0"><w:p/></w:footnote><w:footnote w:type="continuationSeparator" w:id="1"><w:p/></w:footnote>';
  const section = (size: string, margins = 'w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"', extra = "") =>
    `<w:sectPr><w:pgSz ${size}/><w:pgMar ${margins} w:header="720" w:footer="720" w:gutter="0"/>${extra}</w:sectPr>`;
  const dropped = async (document: string, files: Record<string, string> = {}) =>
    (await importDocx(await withParts(await buildDocx({ document }), files, []))).dropped;

  expect(await dropped(p(r("a")) + section('w:w="11906" w:h="16838"'), { "word/footnotes.xml": footnotes(separators) })).toEqual([]);
  expect(await dropped(p(r("a")), { "word/footnotes.xml": footnotes(`${separators}<w:footnote w:id="2"><w:p>${r("catatan")}</w:p></w:footnote>`) }))
    .toEqual(["footnotes"]);
  expect(await dropped(p(r("a")) + section('w:w="15840" w:h="12240" w:orient="landscape"'))).toEqual(["page_setup"]);
  expect(await dropped(p(r("a")) + section('w:w="12240" w:h="15840"', 'w:top="720" w:right="720" w:bottom="720" w:left="720"'))).toEqual(["page_setup"]);
  expect(await dropped(p(r("a")) + section('w:w="12240" w:h="15840"', undefined, '<w:cols w:num="2" w:space="720"/>'))).toEqual(["page_setup"]);
  expect(await dropped(p(r("x = ") + "<m:oMath><m:r><m:t>a+b</m:t></m:r></m:oMath>"))).toEqual(["other_content"]);
  const { doc: result } = await read({ document: p(r("x = ") + "<m:oMath><m:r><m:t>a+b</m:t></m:r></m:oMath>") });
  expect(plainText(result)).toBe("x = ");
});

test("a_deleted_table_row_is_dropped_and_vertical_merges_without_a_start_stay_cells", async () => {
  const tc = (content: string, tcPr = "") => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}${content}</w:tc>`;
  const result = await readBody(
    "<w:tbl>" +
    `<w:tr><w:trPr><w:tblHeader w:val="0"/></w:trPr>${tc(p(r("yatim")), "<w:vMerge/>")}${tc(p(r("b")))}</w:tr>` +
    `<w:tr><w:trPr><w:del w:id="1" w:author="Rina" w:date="2026-10-01T09:00:00Z"/></w:trPr>${tc(p(r("dihapus")))}${tc(p(r("juga")))}</w:tr>` +
    "</w:tbl>",
  );
  expect(plainText(result)).toBe("yatim\nb");
  expect(result.content![0].content![0].content!.map((c) => c.type)).toEqual(["tableCell", "tableCell"]);
});
