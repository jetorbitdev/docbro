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

test("pictures_in_the_body_do_not_carry_a_size", async () => {
  const body = `<w:p>${LOGO.replace('r:embed="rId1"', 'r:embed="rIdBody"')}</w:p>`;
  const zip = await JSZip.loadAsync(await buildDocx({ document: body }));
  zip.file("word/media/logo.png", PNG);
  const rels = "word/_rels/document.xml.rels";
  zip.file(rels, (await zip.file(rels)!.async("string")).replace("</Relationships>", `<Relationship Id="rIdBody" Type="${REL}/image" Target="media/logo.png"/></Relationships>`));
  const { doc } = await importDocx(await zip.generateAsync({ type: "uint8array" }));
  expect(doc.content![0].attrs).toMatchObject({ width: null, height: null });
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
