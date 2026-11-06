import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import { expect, test } from "vitest";
import { exportDocx } from "./export";
import { importDocx } from "./import";
import { buildDocx } from "./testing";

const EMU = 9525; // per px

// A PNG header is all the exporter reads to size a picture; the rest is padding.
function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const dataUrl = (width: number, height: number) => `data:image/png;base64,${pngBytes(width, height).toString("base64")}`;

const image = (attrs: Record<string, unknown> = {}): JSONContent => ({ type: "image", attrs: { src: dataUrl(200, 100), alt: null, ...attrs } });
const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

const bodyXml = async (content: JSONContent) => JSZip.loadAsync(await exportDocx(content)).then((zip) => zip.file("word/document.xml")!.async("string"));
const imported = async (content: JSONContent) => (await importDocx(await exportDocx(content))).doc.content!;

// ---------------------------------------------------------------- writing

test("a_picture_with_a_width_is_written_at_it_with_its_height_following_the_shape", async () => {
  const xml = await bodyXml(doc(image({ width: 100 })));
  expect(xml).toContain(`<wp:extent cx="${100 * EMU}" cy="${50 * EMU}"/>`);
});

test("a_picture_with_a_width_and_a_height_is_written_at_both", async () => {
  const xml = await bodyXml(doc(image({ width: 100, height: 80 })));
  expect(xml).toContain(`<wp:extent cx="${100 * EMU}" cy="${80 * EMU}"/>`);
});

test("a_picture_wider_than_the_text_is_written_at_the_text_width", async () => {
  const xml = await bodyXml(doc(image({ width: 1248 })));
  expect(xml).toContain(`<wp:extent cx="${624 * EMU}" cy="${312 * EMU}"/>`);
});

test("a_picture_is_written_in_a_line_set_left_center_or_right", async () => {
  expect(await bodyXml(doc(image({ align: "center" })))).toContain('<w:jc w:val="center"/>');
  expect(await bodyXml(doc(image({ align: "right" })))).toContain('<w:jc w:val="right"/>');
  expect(await bodyXml(doc(image()))).not.toContain("<w:jc ");
});

test("a_picture_with_text_beside_it_is_anchored_in_the_line_of_text_after_it", async () => {
  const xml = await bodyXml(doc(image({ wrap: true }), para("Teks di samping")));
  expect(xml).toContain("<wp:anchor");
  expect(xml).toContain('<wp:wrapSquare wrapText="right"');
  // the picture and the text share a paragraph, so Word does not add a line for the picture
  expect(xml).toMatch(/<w:p>(?:(?!<\/w:p>)[\s\S])*<wp:anchor[\s\S]*?<w:t[^>]*>Teks di samping<\/w:t>/);
});

test("a_picture_at_the_right_has_the_text_on_its_left", async () => {
  const xml = await bodyXml(doc(image({ wrap: true, align: "right" }), para("Teks")));
  expect(xml).toContain("<wp:align>right</wp:align>");
  expect(xml).toContain('<wp:wrapSquare wrapText="left"');
});

test("a_wrapped_picture_with_no_text_after_it_is_still_written", async () => {
  const xml = await bodyXml(doc(para("Sebelum"), image({ wrap: true })));
  expect(xml).toContain("<wp:anchor");
  const lone = await bodyXml(doc(image({ wrap: true }), { type: "horizontalRule" }));
  expect(lone).toContain("<wp:anchor");
});

test("a_cover_is_not_set_by_the_size_place_or_wrapping_of_a_picture", async () => {
  const xml = await bodyXml(doc(image({ cover: true, width: 100, align: "right", wrap: true }), para("x")));
  expect(xml).not.toContain("<wp:wrapSquare");
  expect(xml).toContain('<wp:wrapNone/>');
});

// ---------------------------------------------------------------- reading

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const GRAPHIC = (id: string) =>
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name=""/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic>`;
const extent = (width: number, height: number) => `<wp:extent cx="${width * EMU}" cy="${height * EMU}"/>`;
const inline = (width: number, height: number) =>
  `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">${extent(width, height)}<wp:docPr id="1" name="p"/>${GRAPHIC("rIdP")}</wp:inline></w:drawing></w:r>`;
const anchored = (position: string, wrap: string, width = 200, height = 100) =>
  '<w:r><w:drawing><wp:anchor behindDoc="0" distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="0" allowOverlap="1" layoutInCell="1" locked="0">' +
  `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column">${position}</wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>` +
  `${extent(width, height)}${wrap}<wp:docPr id="2" name="p"/>${GRAPHIC("rIdP")}</wp:anchor></w:drawing></w:r>`;
const text = (value: string) => `<w:r><w:t>${value}</w:t></w:r>`;
const line = (inner: string, jc = "") => `<w:p>${jc ? `<w:pPr><w:jc w:val="${jc}"/></w:pPr>` : ""}${inner}</w:p>`;

async function read(body: string, natural = { width: 100, height: 50 }): Promise<JSONContent[]> {
  const zip = await JSZip.loadAsync(await buildDocx({ document: body }));
  zip.file("word/media/p.png", pngBytes(natural.width, natural.height));
  const rels = "word/_rels/document.xml.rels";
  zip.file(rels, (await zip.file(rels)!.async("string")).replace("</Relationships>", `<Relationship Id="rIdP" Type="${REL}/image" Target="media/p.png"/></Relationships>`));
  return (await importDocx(await zip.generateAsync({ type: "uint8array" }))).doc.content!;
}
const firstImage = (blocks: JSONContent[]) => blocks.find((b) => b.type === "image")!.attrs!;

test("a_picture_keeps_the_size_it_was_drawn_at", async () => {
  expect(firstImage(await read(line(inline(300, 150))))).toMatchObject({ width: 300, height: 150 });
});

test("a_picture_drawn_as_big_as_it_is_has_no_size_of_its_own", async () => {
  expect(firstImage(await read(line(inline(100, 50))))).toMatchObject({ width: null, height: null });
});

test("a_picture_in_a_centered_or_right_line_is_set_so", async () => {
  expect(firstImage(await read(line(inline(300, 150), "center")))).toMatchObject({ align: "center", wrap: false });
  expect(firstImage(await read(line(inline(300, 150), "right")))).toMatchObject({ align: "right" });
  expect(firstImage(await read(line(inline(300, 150), "left")))).toMatchObject({ align: null });
  expect(firstImage(await read(line(inline(300, 150), "both")))).toMatchObject({ align: null });
});

test("a_picture_with_text_beside_it_is_wrapped_at_the_side_it_was_anchored", async () => {
  const left = await read(line(anchored("<wp:posOffset>0</wp:posOffset>", '<wp:wrapSquare wrapText="right"/>') + text("Teks")));
  expect(firstImage(left)).toMatchObject({ wrap: true, align: null });
  const right = await read(line(anchored("<wp:align>right</wp:align>", '<wp:wrapSquare wrapText="left"/>') + text("Teks")));
  expect(firstImage(right)).toMatchObject({ wrap: true, align: "right" });
  // text kept to the left of it is enough to say it is at the right
  const implied = await read(line(anchored("<wp:posOffset>0</wp:posOffset>", '<wp:wrapSquare wrapText="left"/>') + text("Teks")));
  expect(firstImage(implied)).toMatchObject({ wrap: true, align: "right" });
  const tight = await read(line(anchored("<wp:align>left</wp:align>", '<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon edited="0"/></wp:wrapTight>')));
  expect(firstImage(tight)).toMatchObject({ wrap: true });
});

test("a_picture_set_apart_on_its_own_lines_is_not_wrapped", async () => {
  const centered = await read(line(anchored("<wp:align>center</wp:align>", "<wp:wrapTopAndBottom/>")));
  expect(firstImage(centered)).toMatchObject({ wrap: false, align: "center" });
  // text cannot run down both sides of a picture in the middle
  const middle = await read(line(anchored("<wp:align>center</wp:align>", '<wp:wrapSquare wrapText="bothSides"/>')));
  expect(firstImage(middle)).toMatchObject({ wrap: false, align: "center" });
  const behind = await read(line(anchored("<wp:posOffset>0</wp:posOffset>", "<wp:wrapNone/>")));
  expect(firstImage(behind)).toMatchObject({ wrap: false, align: null });
});

// ---------------------------------------------------------------- both ways

test("size_place_and_wrapping_survive_a_save_and_an_open", async () => {
  for (const attrs of [
    { width: 120 },
    { width: 120, align: "center" },
    { width: 120, align: "right" },
    { width: 150, wrap: true },
    { width: 150, wrap: true, align: "right" },
  ]) {
    const blocks = await imported(doc(image(attrs), para("Teks")));
    expect(firstImage(blocks), JSON.stringify(attrs)).toMatchObject({ align: null, wrap: false, ...attrs });
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
  }
});

test("a_picture_with_nothing_set_comes_back_with_nothing_set", async () => {
  expect(firstImage(await imported(doc(image(), para("Teks"))))).toMatchObject({ width: null, height: null, align: null, wrap: false });
});

test("a_picture_stays_before_the_text_it_was_wrapped_with", async () => {
  const blocks = await imported(doc(para("Sebelum"), image({ wrap: true, width: 100 }), para("Sesudah")));
  expect(blocks.map((b) => b.type)).toEqual(["paragraph", "image", "paragraph"]);
});
