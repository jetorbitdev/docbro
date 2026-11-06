import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import { expect, test } from "vitest";
import { emptyMeta } from "../../doc/meta";
import { exportDocx } from "./export";
import { fixtureDoc } from "./fixture";
import { importDocx } from "./import";
import { buildDocx } from "./testing";

const PIXEL = fixtureDoc().content!.find((n) => n.type === "image")!.attrs!.src as string;
const PNG = new Uint8Array(Buffer.from(PIXEL.split(",")[1], "base64"));
const PNG_BASE64 = PIXEL.split(",")[1];

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml";
const NAMESPACES =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="' + REL + '" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"';

const LOGO =
  '<w:r><w:drawing><wp:anchor behindDoc="0" distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="0" allowOverlap="1" layoutInCell="1" locked="0">' +
  '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>31808</wp:posOffset></wp:positionH>' +
  '<wp:positionV relativeFrom="paragraph"><wp:posOffset>3644</wp:posOffset></wp:positionV><wp:extent cx="1307516" cy="242827"/><wp:wrapNone/>' +
  '<wp:docPr id="1" name="image1.png"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
  '<pic:nvPicPr><pic:cNvPr id="0" name=""/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr/></pic:pic>' +
  "</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>";
const RULE = '<w:r><w:pict><v:rect style="width:0.0pt;height:1.5pt" o:hr="t" o:hrstd="t" o:hralign="center" fillcolor="#A0A0A0" stroked="f"/></w:pict></w:r>';
const right = '<w:pPr><w:jc w:val="right"/></w:pPr>';

// What the header of the Penawaran file looks like: the company in bold with the logo anchored beside it, a tagline, a rule.
const LETTERHEAD =
  `<w:p>${right}<w:r><w:rPr><w:b/></w:rPr><w:t>PT Jetorbit Teknologi Indonesia</w:t></w:r>${LOGO}</w:p>` +
  `<w:p>${right}<w:r><w:t>Technology For Your Business</w:t></w:r></w:p>` +
  `<w:p>${RULE}</w:p>`;

const part = (root: "hdr" | "ftr", inner: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} ${NAMESPACES}>${inner}</w:${root}>`;
const imageRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="${REL}/image" Target="media/image1.png"/></Relationships>`;

interface Extras {
  rels?: string;
  media?: Record<string, Uint8Array>;
  kind?: "header" | "footer";
  /** A second header part, which the one section does not use: Word would still list it in the package. */
  extraHeader?: boolean;
  /** `w:type` of the reference in the section. */
  type?: string;
}

// A package whose last section refers to one header or footer part.
async function pack(xml: string, extras: Extras = {}): Promise<Uint8Array> {
  const kind = extras.kind ?? "header";
  const zip = await JSZip.loadAsync(await buildDocx({ document: '<w:p><w:r><w:t>Isi</w:t></w:r></w:p>' }));
  zip.file(`word/${kind}1.xml`, xml);
  if (extras.rels) zip.file(`word/_rels/${kind}1.xml.rels`, extras.rels);
  for (const [name, data] of Object.entries(extras.media ?? {})) zip.file(`word/media/${name}`, data);
  if (extras.extraHeader) zip.file("word/header2.xml", part("hdr", "<w:p/>"));

  const overrides =
    `<Override PartName="/word/${kind}1.xml" ContentType="${TYPE}.${kind}+xml"/>` +
    (extras.extraHeader ? `<Override PartName="/word/header2.xml" ContentType="${TYPE}.header+xml"/>` : "");
  const types = "[Content_Types].xml";
  zip.file(types, (await zip.file(types)!.async("string")).replace("</Types>", `${overrides}</Types>`));

  const rels = "word/_rels/document.xml.rels";
  zip.file(rels, (await zip.file(rels)!.async("string")).replace("</Relationships>", `<Relationship Id="rIdHF" Type="${REL}/${kind}" Target="${kind}1.xml"/></Relationships>`));

  const docPath = "word/document.xml";
  const section =
    `<w:sectPr><w:${kind}Reference w:type="${extras.type ?? "default"}" r:id="rIdHF"/>` +
    '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  zip.file(docPath, (await zip.file(docPath)!.async("string")).replace("</w:body>", `${section}</w:body>`));
  return zip.generateAsync({ type: "uint8array" });
}

const types = (doc: JSONContent | null | undefined) => doc?.content?.map((n) => n.type);

// ---------------------------------------------------------------- reading

test("a_header_with_several_paragraphs_a_logo_and_a_rule_is_kept_as_it_was_and_shown", async () => {
  const xml = part("hdr", LETTERHEAD);
  const { meta, dropped } = await importDocx(await pack(xml, { rels: imageRels, media: { "image1.png": PNG } }));

  expect(dropped).not.toContain("headers");
  expect(meta.header).toBeNull(); // not the one-line text zone
  const kept = meta.headerPart!;
  expect(kept.xml).toBe(xml);
  expect(kept.media).toEqual({ "header-1.png": PNG_BASE64 });
  expect(kept.rels).toContain('Target="media/header-1.png"');
  expect(kept.rels).toContain('Id="rId1"');
  // the logo comes first, so that it can sit beside the lines of text, as in Word
  expect(types(kept.view)).toEqual(["image", "paragraph", "paragraph", "horizontalRule"]);
  expect(kept.view!.content![1].attrs!.textAlign).toBe("right");
  expect(kept.view!.content![1].content![0].marks).toEqual([{ type: "bold" }]);
  expect(kept.view!.content![0].attrs!.src).toBe(PIXEL);
  // the logo is drawn as big as the file made it: 1307516 x 242827 EMU, at 9525 EMU to the px
  expect(kept.view!.content![0].attrs).toMatchObject({ width: 137, height: 25 });
});

test("a_picture_in_the_body_carries_the_size_it_was_drawn_at", async () => {
  const body = `<w:p>${LOGO.replace('r:embed="rId1"', 'r:embed="rIdBody"')}</w:p>`;
  const zip = await JSZip.loadAsync(await buildDocx({ document: body }));
  zip.file("word/media/logo.png", PNG);
  const rels = "word/_rels/document.xml.rels";
  zip.file(rels, (await zip.file(rels)!.async("string")).replace("</Relationships>", `<Relationship Id="rIdBody" Type="${REL}/image" Target="media/logo.png"/></Relationships>`));
  const { doc } = await importDocx(await zip.generateAsync({ type: "uint8array" }));
  // the picture can be sized in the body as it is in a header; the file's extent is 137 x 25 px
  expect(doc.content![0].attrs).toMatchObject({ width: 137, height: 25, wrap: false, align: null });
});

test("a_one_line_header_is_still_the_text_zone_and_has_no_part", async () => {
  const { meta } = await importDocx(await buildDocx({ document: "<w:p/>", header: true }));
  expect(meta.header).toBe("Header text");
  expect(meta.headerPart).toBeNull();
});

test("a_footer_is_kept_the_same_way", async () => {
  const xml = part("ftr", `<w:p>${right}<w:r><w:t>Jl. Godean KM 4,5</w:t></w:r></w:p><w:p>${right}<w:r><w:t>www.jetorbit.com</w:t></w:r></w:p>`);
  const { meta, dropped } = await importDocx(await pack(xml, { kind: "footer" }));
  expect(dropped).not.toContain("footers");
  expect(meta.footer).toBeNull();
  expect(meta.footerPart!.xml).toBe(xml);
  expect(meta.footerPart!.rels).toBeNull();
  expect(meta.footerPart!.media).toEqual({});
  expect(types(meta.footerPart!.view)).toEqual(["paragraph", "paragraph"]);
});

test("a_page_field_in_a_kept_part_stays_in_the_xml_and_shows_its_last_value", async () => {
  const field = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const xml = part("ftr", `<w:p><w:r><w:t>Halaman </w:t></w:r>${field}</w:p><w:p><w:r><w:t>Rahasia</w:t></w:r></w:p>`);
  const { meta } = await importDocx(await pack(xml, { kind: "footer" }));
  expect(meta.footerPart!.xml).toContain("PAGE");
  expect(meta.pageNumbers).toBe(false); // that toggle belongs to the one-line footer
  expect(types(meta.footerPart!.view)).toEqual(["paragraph", "paragraph"]);
});

test("a_part_that_needs_a_file_other_than_a_picture_is_still_reported_as_dropped", async () => {
  const rels = imageRels.replace(`${REL}/image" Target="media/image1.png"`, `${REL}/chart" Target="charts/chart1.xml"`);
  const { meta, dropped } = await importDocx(await pack(part("hdr", LETTERHEAD), { rels }));
  expect(dropped).toContain("headers");
  expect(meta.headerPart).toBeNull();
});

test("a_picture_the_part_points_at_but_the_file_lacks_is_still_reported_as_dropped", async () => {
  const { meta, dropped } = await importDocx(await pack(part("hdr", LETTERHEAD), { rels: imageRels }));
  expect(dropped).toContain("headers");
  expect(meta.headerPart).toBeNull();
});

test("another_header_part_in_the_package_would_be_lost_so_it_is_still_reported", async () => {
  const { meta, dropped } = await importDocx(await pack(part("hdr", LETTERHEAD), { rels: imageRels, media: { "image1.png": PNG }, extraHeader: true }));
  expect(dropped).toContain("headers");
  expect(meta.headerPart).not.toBeNull(); // the one the section uses is still kept and shown
});

test("a_header_for_the_first_page_only_is_still_reported_as_dropped", async () => {
  const { meta, dropped } = await importDocx(await pack(part("hdr", LETTERHEAD), { rels: imageRels, media: { "image1.png": PNG }, type: "first" }));
  expect(dropped).toContain("headers");
  expect(meta.headerPart).toBeNull();
});

// ---------------------------------------------------------------- writing

const read = async (bytes: Uint8Array, path: string) => (await JSZip.loadAsync(bytes)).file(path)?.async("string");

test("a_kept_header_is_written_back_exactly_as_it_was", async () => {
  const xml = part("hdr", LETTERHEAD);
  const opened = await importDocx(await pack(xml, { rels: imageRels, media: { "image1.png": PNG } }));
  const bytes = await exportDocx(opened.doc, opened.meta);

  const zip = await JSZip.loadAsync(bytes);
  const headerRel = /<Relationship\b[^>]*\/header"[^>]*>/.exec((await read(bytes, "word/_rels/document.xml.rels"))!)![0];
  const target = /Target="([^"]+)"/.exec(headerRel)![1];
  expect(await read(bytes, `word/${target}`)).toBe(xml);
  expect(await read(bytes, `word/_rels/${target}.rels`)).toContain("media/header-1.png");
  expect(Buffer.from(await zip.file("word/media/header-1.png")!.async("uint8array")).toString("base64")).toBe(PNG_BASE64);
  expect(await read(bytes, "[Content_Types].xml")).toMatch(/Extension="png"/);

  // and it opens again as the same part, with nothing reported as lost
  const again = await importDocx(bytes);
  expect(again.dropped).toEqual([]);
  expect(again.meta.headerPart).toEqual(opened.meta.headerPart);
});

test("a_kept_footer_is_written_back_exactly_as_it_was", async () => {
  const xml = part("ftr", `<w:p>${right}<w:r><w:t>Satu</w:t></w:r></w:p><w:p>${right}<w:r><w:t>Dua</w:t></w:r></w:p>`);
  const opened = await importDocx(await pack(xml, { kind: "footer" }));
  const again = await importDocx(await exportDocx(opened.doc, opened.meta));
  expect(again.dropped).toEqual([]);
  expect(again.meta.footerPart!.xml).toBe(xml);
});

test("a_header_part_and_a_footer_part_can_both_be_kept", async () => {
  const headerXml = part("hdr", `<w:p><w:r><w:t>Atas</w:t></w:r></w:p><w:p><w:r><w:t>Atas dua</w:t></w:r></w:p>`);
  const footerXml = part("ftr", `<w:p><w:r><w:t>Bawah</w:t></w:r></w:p><w:p><w:r><w:t>Bawah dua</w:t></w:r></w:p>`);
  const meta = {
    ...emptyMeta(),
    headerPart: { xml: headerXml, rels: null, media: {}, view: null },
    footerPart: { xml: footerXml, rels: null, media: {}, view: null },
  };
  const again = await importDocx(await exportDocx({ type: "doc", content: [{ type: "paragraph" }] }, meta));
  expect(again.dropped).toEqual([]);
  expect(again.meta.headerPart!.xml).toBe(headerXml);
  expect(again.meta.footerPart!.xml).toBe(footerXml);
});

test("without_a_kept_part_no_header_is_written", async () => {
  const bytes = await exportDocx({ type: "doc", content: [{ type: "paragraph" }] }, emptyMeta());
  expect(Object.keys((await JSZip.loadAsync(bytes)).files).filter((f) => /header|footer/.test(f))).toEqual([]);
});

test("a_package_with_a_kept_part_holds_files_only_as_the_library_writes_it", async () => {
  const opened = await importDocx(await pack(part("hdr", LETTERHEAD), { rels: imageRels, media: { "image1.png": PNG } }));
  const zip = await JSZip.loadAsync(await exportDocx(opened.doc, opened.meta));
  expect(Object.keys(zip.files).filter((name) => name.endsWith("/"))).toEqual([]);
});

// ---------------------------------------------------------------- after it is edited

const para = (text: string, textAlign: string | null = null, marks?: object[]) =>
  ({ type: "paragraph", attrs: { textAlign }, content: [{ type: "text", text, ...(marks && { marks }) }] });
const edited = (...content: object[]) => ({ xml: null, rels: null, media: {}, view: { type: "doc", content } });

test("an_edited_header_is_written_from_what_it_shows_with_the_logo_floating_beside_the_text_after_it", async () => {
  const logo = { type: "image", attrs: { src: PIXEL, alt: null, width: 137, height: 25 } };
  const meta = { ...emptyMeta(), headerPart: edited(logo, para("PT Baru", "right", [{ type: "bold" }]), para("Tagline", "right"), { type: "horizontalRule" }) };
  const bytes = await exportDocx({ type: "doc", content: [{ type: "paragraph" }] }, meta);

  const xml = (await read(bytes, "word/header1.xml"))!;
  const first = /<w:p\b.*?<\/w:p>/s.exec(xml)![0];
  expect(first).toContain("PT Baru"); // the logo shares the first line of text
  expect(first).toContain("<wp:anchor");
  expect(first).toMatch(/<wp:wrapSquare[^>]*wrapText="right"/);
  expect(xml).toMatch(/<wp:extent cx="1304925" cy="238125"\/>/); // 137 x 25 px

  const again = await importDocx(bytes);
  expect(again.dropped).toEqual([]);
  expect(types(again.meta.headerPart!.view)).toEqual(["image", "paragraph", "paragraph", "horizontalRule"]);
  expect(again.meta.headerPart!.view!.content![1]).toMatchObject({ attrs: { textAlign: "right" }, content: [{ text: "PT Baru", marks: [{ type: "bold" }] }] });
  expect(again.meta.headerPart!.view!.content![0].attrs).toMatchObject({ width: 137, height: 25 });
});

test("an_edited_footer_is_written_from_what_it_shows", async () => {
  const meta = { ...emptyMeta(), footerPart: edited(para("Alamat baru"), para("www.contoh.id", "center")) };
  const again = await importDocx(await exportDocx({ type: "doc", content: [{ type: "paragraph" }] }, meta));
  expect(again.dropped).toEqual([]);
  expect(again.meta.footerPart!.view!.content!.map((n) => n.content?.[0]?.text)).toEqual(["Alamat baru", "www.contoh.id"]);
});

test("a_picture_with_no_text_after_it_is_written_on_a_line_of_its_own", async () => {
  const meta = { ...emptyMeta(), headerPart: edited(para("Atas"), { type: "image", attrs: { src: PIXEL, alt: null, width: 20, height: 20 } }) };
  const again = await importDocx(await exportDocx({ type: "doc", content: [{ type: "paragraph" }] }, meta));
  expect(types(again.meta.headerPart!.view)).toEqual(["image", "paragraph"]);
});

test("a_kept_part_says_what_editing_it_would_leave_out", async () => {
  const letterhead = await importDocx(await pack(part("hdr", LETTERHEAD), { rels: imageRels, media: { "image1.png": PNG } }));
  expect(letterhead.meta.headerPart!.editLoses).toEqual([]);
  const textbox = '<w:p><w:r><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>kotak</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p><w:p/>';
  expect((await importDocx(await pack(part("hdr", textbox)))).meta.headerPart!.editLoses).toEqual(["other_content"]);
});

test("a_kept_part_shows_a_bmp_logo_and_says_editing_it_would_leave_the_logo_out", async () => {
  const bmp = new Uint8Array([0x42, 0x4d, 0, 0]);
  const { meta, dropped } = await importDocx(await pack(part("hdr", LETTERHEAD), { rels: imageRels.replace("image1.png", "image1.bmp"), media: { "image1.bmp": bmp } }));
  expect(dropped).toEqual([]); // written back from its own files, the logo is kept
  expect(meta.headerPart!.media).toEqual({ "header-1.bmp": Buffer.from(bmp).toString("base64") });
  expect(meta.headerPart!.view!.content![0].attrs!.src).toBe("data:image/bmp;base64,Qk0AAA==");
  expect(meta.headerPart!.editLoses).toEqual(["other_content"]);
});

// ---------------------------------------------------------------- fields

const COMPLEX_PAGE = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
const fieldsOf = (view: JSONContent | null | undefined) =>
  (view?.content ?? []).flatMap((block) => (block.content ?? []).filter((n) => n.type === "field").map((n) => n.attrs));

test("a_field_in_a_header_or_footer_is_read_as_a_field_with_its_instruction_and_last_value", async () => {
  const simple = '<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>9</w:t></w:r></w:fldSimple>';
  const xml = part("ftr", `<w:p><w:r><w:t xml:space="preserve">Halaman </w:t></w:r>${COMPLEX_PAGE}<w:r><w:t xml:space="preserve"> dari </w:t></w:r>${simple}</w:p><w:p><w:r><w:t>x</w:t></w:r></w:p>`);
  const { meta } = await importDocx(await pack(xml, { kind: "footer" }));
  expect(fieldsOf(meta.footerPart!.view)).toEqual([{ instr: "PAGE", text: "3" }, { instr: "NUMPAGES", text: "9" }]);
  const line = meta.footerPart!.view!.content![0].content!;
  expect(line.map((n) => n.type === "text" ? n.text : `{${n.attrs!.instr}}`).join("")).toBe("Halaman {PAGE} dari {NUMPAGES}");
  expect(line[1].marks).toEqual([{ type: "bold" }]); // the field keeps the look of its result
  expect(meta.footerPart!.editLoses).toEqual([]);
});

const NESTED = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> IF </w:instrText></w:r>' + COMPLEX_PAGE +
  '<w:r><w:instrText xml:space="preserve"> = 1 "satu" "lain" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>lain</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';

test("a_field_inside_a_field_is_kept_in_braces_in_the_outer_ones_instruction", async () => {
  const { meta } = await importDocx(await pack(part("hdr", `<w:p>${NESTED}</w:p><w:p/>`)));
  expect(fieldsOf(meta.headerPart!.view)).toEqual([{ instr: 'IF { PAGE } = 1 "satu" "lain"', text: "lain" }]);
});

test("an_edited_part_writes_a_field_inside_a_field_back_as_word_nests_them", async () => {
  const meta = { ...emptyMeta(), headerPart: edited({ type: "paragraph", content: [{ type: "field", attrs: { instr: 'IF { PAGE } = 1 "satu" "lain"', text: "lain" }, marks: [{ type: "bold" }] }] }) };
  const bytes = await exportDocx({ type: "doc", content: [{ type: "paragraph" }] }, meta);
  const xml = (await read(bytes, "word/header1.xml"))!;
  const chars = [...xml.matchAll(/w:fldCharType="(\w+)"|<w:instrText[^>]*>([^<]*)</g)].map((m) => m[1] ?? `"${m[2]}"`);
  expect(chars).toEqual(["begin", '"IF "', "begin", '" PAGE "', "end", '" = 1 &quot;satu&quot; &quot;lain&quot;"', "separate", "end"]);
  expect(xml).toMatch(/<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">lain<\/w:t>/);

  const again = await importDocx(bytes);
  expect(fieldsOf(again.meta.headerPart!.view)).toEqual([{ instr: 'IF { PAGE } = 1 "satu" "lain"', text: "lain" }]);
});

test("braces_that_do_not_pair_up_are_written_as_a_plain_field", async () => {
  const meta = { ...emptyMeta(), headerPart: edited({ type: "paragraph", content: [{ type: "field", attrs: { instr: 'QUOTE "a }"', text: "a }" } }] }) };
  const xml = (await read(await exportDocx({ type: "doc", content: [{ type: "paragraph" }] }, meta), "word/header1.xml"))!;
  expect(xml).toContain('<w:fldSimple w:instr="QUOTE &quot;a }&quot;"');
});

test("fields_in_the_body_are_still_their_text", async () => {
  const { doc } = await importDocx(await buildDocx({ document: `<w:p><w:r><w:t xml:space="preserve">Hal </w:t></w:r>${COMPLEX_PAGE}</w:p>` }));
  expect(doc.content![0].content!.map((n) => n.type)).toEqual(["text", "text"]);
});

test("an_edited_part_writes_page_fields_as_word_page_numbers_and_others_as_fields", async () => {
  const field = (instr: string, text: string) => ({ type: "field", attrs: { instr, text } });
  const line = { type: "paragraph", content: [{ type: "text", text: "Hal " }, field("PAGE", "1"), { type: "text", text: " / " }, field("NUMPAGES", "2"), { type: "text", text: " · " }, field("DATE \\@ \"d MMMM yyyy\"", "1 November 2026")] };
  const meta = { ...emptyMeta(), footerPart: edited(line, para("dua")) };
  const bytes = await exportDocx({ type: "doc", content: [{ type: "paragraph" }] }, meta);
  const xml = (await read(bytes, "word/footer1.xml"))!;
  expect(xml).toMatch(/<w:instrText[^>]*>PAGE<\/w:instrText>/);
  expect(xml).toMatch(/<w:instrText[^>]*>NUMPAGES<\/w:instrText>/);
  expect(xml).toMatch(/<w:fldSimple w:instr="DATE/);

  const again = await importDocx(bytes);
  expect(fieldsOf(again.meta.footerPart!.view).map((f) => f!.instr)).toEqual(["PAGE", "NUMPAGES", 'DATE \\@ "d MMMM yyyy"']);
});

// ---------------------------------------------------------------- what the one-line text zone may take

test("a_line_with_alignment_formatting_or_a_page_number_of_its_own_wording_is_kept_as_a_part", async () => {
  const lines = [
    `<w:p>${right}<w:r><w:t>Rahasia</w:t></w:r></w:p>`, // aligned
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Rahasia</w:t></w:r></w:p>', // bold
    `<w:p><w:r><w:t xml:space="preserve">Halaman </w:t></w:r>${COMPLEX_PAGE}</w:p>`, // a page number, not "Page x of y"
  ];
  for (const line of lines) {
    const { meta, dropped } = await importDocx(await pack(part("ftr", line), { kind: "footer" }));
    expect(meta.footer).toBeNull();
    expect(meta.footerPart).not.toBeNull();
    expect(dropped).toEqual([]);
  }
});

test("a_plain_line_and_docbros_own_page_label_are_still_the_text_zone", async () => {
  const plain = await importDocx(await pack(part("ftr", '<w:p><w:r><w:rPr><w:rFonts w:ascii="Inter"/><w:sz w:val="20"/></w:rPr><w:t>Rahasia</w:t></w:r></w:p>'), { kind: "footer" }));
  expect(plain.meta).toMatchObject({ footer: "Rahasia", footerPart: null }); // fonts and sizes are not the page's to keep
  const own = await importDocx(await exportDocx({ type: "doc", content: [{ type: "paragraph" }] }, { ...emptyMeta(), footer: "Draft", pageNumbers: true }));
  expect(own.meta).toMatchObject({ footer: "Draft", pageNumbers: true, footerPart: null });
});
