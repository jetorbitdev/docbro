import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import { expect, test } from "vitest";
import { emptyMeta } from "../../doc/meta";
import { exportDocx } from "./export";
import { fixtureDoc } from "./fixture";
import { importDocx } from "./import";
import { buildDocx, normalize } from "./testing";

const PIXEL = fixtureDoc().content!.find((n) => n.type === "image")!.attrs!.src as string;
const PNG = new Uint8Array(Buffer.from(PIXEL.split(",")[1], "base64"));
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

const run = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`;
const p = (inner = "") => `<w:p>${inner}</w:p>`;
const A4 = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';

// What Google Docs writes for a picture dragged over the whole page.
function anchored(opts: { cx?: number; cy?: number; from?: string; wrap?: string } = {}): string {
  const { cx = 7572375, cy = 10734675, from = "page", wrap = "<wp:wrapNone/>" } = opts;
  return (
    '<w:r><w:drawing><wp:anchor behindDoc="0" distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" allowOverlap="1" layoutInCell="1" locked="0">' +
    `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="${from}"><wp:posOffset>-5109</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="${from}"><wp:posOffset>-23812</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/>` +
    `${wrap}<wp:docPr id="2" name="cover.png"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name=""/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdCover"/>' +
    "<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>"
  );
}

async function read(body: string): Promise<JSONContent[]> {
  const zip = await JSZip.loadAsync(await buildDocx({ document: body + A4 }));
  zip.file("word/media/cover.png", PNG);
  const rels = "word/_rels/document.xml.rels";
  zip.file(rels, (await zip.file(rels)!.async("string")).replace("</Relationships>", `<Relationship Id="rIdCover" Type="${REL}" Target="media/cover.png"/></Relationships>`));
  return (await importDocx(await zip.generateAsync({ type: "uint8array" }))).doc.content!;
}

const types = (blocks: JSONContent[]) => blocks.map((n) => n.type);

test("a_picture_pinned_to_the_page_and_as_big_as_it_is_a_cover", async () => {
  const blocks = await read(p(anchored()) + p(run("isi")));
  expect(types(blocks)).toEqual(["image", "paragraph"]);
  expect(blocks[0].attrs!.cover).toBe(true);
});

test("a_small_or_a_flowing_or_a_text_wrapped_picture_is_not_a_cover", async () => {
  for (const body of [
    p(anchored({ cx: 2037701, cy: 542544 })), // a stamp
    p(anchored({ from: "paragraph" })), // big, but placed against its paragraph
    p(anchored({ wrap: "<wp:wrapTopAndBottom/>" })), // big, and the text moves around it
  ]) {
    const blocks = await read(body + p(run("isi")));
    expect(blocks[0].type).toBe("image");
    expect(blocks[0].attrs!.cover).toBe(false);
  }
});

test("the_blank_lines_after_a_cover_only_held_the_text_down_and_are_dropped", async () => {
  const blank = p() .repeat(5);
  const blocks = await read(p(anchored()) + blank + p(run("isi")) + p() + p(run("lagi")));
  expect(types(blocks)).toEqual(["image", "paragraph", "paragraph", "paragraph"]);
  expect(blocks[1].content![0].text).toBe("isi");
  expect(blocks[2].content ?? []).toEqual([]); // a blank line further down is the writer's
});

test("a_page_break_right_after_a_cover_is_not_kept_a_second_time", async () => {
  const blocks = await read(p(anchored()) + p('<w:r><w:br w:type="page"/></w:r>') + p(run("isi")));
  expect(types(blocks)).toEqual(["image", "paragraph"]);
});

test("exports_a_cover_pinned_to_the_page_with_a_page_break_after_it", async () => {
  const doc: JSONContent = {
    type: "doc",
    content: [{ type: "image", attrs: { src: PIXEL, alt: null, cover: true } }, { type: "paragraph", content: [{ type: "text", text: "isi" }] }],
  };
  const xml = await (await JSZip.loadAsync(await exportDocx(doc, { ...emptyMeta(), pageSize: "a4" }))).file("word/document.xml")!.async("string");
  expect(xml).toContain("<wp:anchor");
  expect(xml.match(/<wp:positionH relativeFrom="page"/)).not.toBeNull();
  expect(xml.match(/<wp:positionV relativeFrom="page"/)).not.toBeNull();
  expect(xml).toContain('<w:br w:type="page"/>');
  const cx = Number(/<wp:extent cx="(\d+)"/.exec(xml)![1]);
  expect(Math.abs(cx - 11906 * 635)).toBeLessThan(20000); // as wide as the A4 page
});

test("a_cover_survives_a_save_and_reopen", async () => {
  const original: JSONContent = {
    type: "doc",
    content: [{ type: "image", attrs: { src: PIXEL, alt: null, cover: true } }, { type: "paragraph", content: [{ type: "text", text: "isi" }] }],
  };
  const { doc, dropped } = await importDocx(await exportDocx(original, { ...emptyMeta(), pageSize: "a4" }));
  expect(doc.content![0].attrs!.cover).toBe(true);
  expect(doc).toEqual(normalize(original));
  expect(dropped).toEqual([]);
});
