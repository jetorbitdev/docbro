import JSZip from "jszip";
import { expect, test } from "vitest";
import { emptyMeta } from "../../doc/meta";
import { exportDocx } from "./export";
import { importDocx } from "./import";
import { buildDocx } from "./testing";

const para = '<w:p><w:r><w:t>isi</w:t></w:r></w:p>';
const section = (w: number, h: number) =>
  `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
const sizeOf = async (body: string) => (await importDocx(await buildDocx({ document: body }))).meta.pageSize;
const pgSz = async (bytes: Uint8Array) =>
  /<w:pgSz[^>]*>/.exec(await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string"))![0];

test("reads_an_a4_file_as_a4_even_when_the_twips_are_a_little_off", async () => {
  expect(await sizeOf(para + section(11906, 16838))).toBe("a4");
  expect(await sizeOf(para + section(11909, 16834))).toBe("a4"); // what Google Docs writes
});

test("reads_letter_and_a_file_with_no_page_size_as_letter", async () => {
  expect(await sizeOf(para + section(12240, 15840))).toBe("letter");
  expect(await sizeOf(para)).toBe("letter");
});

test("writes_the_size_the_document_has_and_letter_when_it_has_none", async () => {
  const doc = { type: "doc", content: [{ type: "paragraph" }] };
  expect(await pgSz(await exportDocx(doc, { ...emptyMeta(), pageSize: "a4" }))).toMatch(/w:w="11906"[^>]*w:h="16838"|w:h="16838"[^>]*w:w="11906"/);
  expect(await pgSz(await exportDocx(doc, emptyMeta()))).toMatch(/w:w="12240"[^>]*w:h="15840"|w:h="15840"[^>]*w:w="12240"/);
  expect(await pgSz(await exportDocx(doc))).toMatch(/w:w="12240"[^>]*w:h="15840"|w:h="15840"[^>]*w:w="12240"/);
});

test("an_a4_document_stays_a4_through_a_save_and_reopen", async () => {
  const doc = { type: "doc", content: [{ type: "paragraph" }] };
  const back = await importDocx(await exportDocx(doc, { ...emptyMeta(), pageSize: "a4" }));
  expect(back.meta.pageSize).toBe("a4");
  expect(back.dropped).toEqual([]);
});
