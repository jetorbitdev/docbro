import { expect, test } from "vitest";
import { emptyMeta, partText, zonePatch, zoneView, type DocMeta } from "./meta";

const part = (view: object | null) => ({ xml: "", rels: null, media: {}, view: view as never });
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

test("a_kept_parts_text_is_one_line_per_block_and_skips_pictures_rules_and_empty_lines", () => {
  const view = { type: "doc", content: [{ type: "image", attrs: { src: "x" } }, para("PT Jetorbit"), para(""), para("Technology"), { type: "horizontalRule" }] };
  expect(partText(part(view))).toBe("PT Jetorbit\nTechnology");
});

test("no_part_or_no_view_has_no_text", () => {
  expect(partText(null)).toBeNull();
  expect(partText(part(null))).toBe("");
});

test("editing_a_part_with_content_the_page_cannot_show_warns_first", async () => {
  const { editWarning } = await import("./meta");
  expect(editWarning({ ...part(null), editLoses: [] }, "header")).toBeNull();
  expect(editWarning({ ...part(null) }, "header")).toBeNull();
  expect(editWarning({ ...part(null), editLoses: ["other_content"] }, "footer")).toBe(
    "This footer has content DocBro can't show, such as a text box. Editing it leaves that out. Edit it anyway?");
});

test("a_fields_last_value_counts_as_text", () => {
  const view = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hal " }, { type: "field", attrs: { instr: "PAGE", text: "3" } }] }] };
  expect(partText(part(view))).toBe("Hal 3");
});

// ---------------------------------------------------------------- one way of showing and editing every header and footer

const meta = (patch: Partial<DocMeta>): DocMeta => ({ ...emptyMeta(), ...patch });
const p = (content: object[] = [], textAlign: string | null = null) => ({ type: "paragraph", attrs: { textAlign }, content });
const t = (text: string, marks?: object[]) => ({ type: "text", text, ...(marks && { marks }) });
const f = (instr: string) => ({ type: "field", attrs: { instr, text: "1" } });
const PAGE_LINE = p([t("Page "), f("PAGE"), t(" of "), f("NUMPAGES")], "right");

test("a_text_header_or_footer_is_shown_as_a_line_and_page_numbers_as_fields_at_the_right", () => {
  expect(zoneView(meta({}), "header")).toBeNull();
  expect(zoneView(meta({ header: "Internal" }), "header")).toEqual({ type: "doc", content: [p([t("Internal")])] });
  expect(zoneView(meta({ header: "" }), "header")).toEqual({ type: "doc", content: [p()] });
  expect(zoneView(meta({ footer: "Draft", pageNumbers: true }), "footer")).toEqual({ type: "doc", content: [p([t("Draft")]), PAGE_LINE] });
  expect(zoneView(meta({ footer: "", pageNumbers: true }), "footer")).toEqual({ type: "doc", content: [PAGE_LINE] });
  const view = { type: "doc", content: [p([t("kept")])] };
  expect(zoneView(meta({ headerPart: { xml: "<w:hdr/>", rels: null, media: {}, view } }), "header")).toBe(view);
});

test("an_edit_that_is_still_a_line_of_plain_text_stays_a_text_header", () => {
  expect(zonePatch("header", { type: "doc", content: [p([t("Baru")])] })).toEqual({ header: "Baru", headerPart: null });
  expect(zonePatch("header", { type: "doc", content: [p()] })).toEqual({ header: "", headerPart: null });
  expect(zonePatch("footer", { type: "doc", content: [p([t("Draft")]), PAGE_LINE] })).toEqual({ footer: "Draft", pageNumbers: true, footerPart: null });
  expect(zonePatch("footer", { type: "doc", content: [PAGE_LINE] })).toEqual({ footer: "", pageNumbers: true, footerPart: null });
  expect(zonePatch("footer", { type: "doc", content: [p([t("Draft")])] })).toEqual({ footer: "Draft", pageNumbers: false, footerPart: null });
});

test("an_edit_with_more_than_a_line_of_plain_text_becomes_a_part_written_from_it", () => {
  const rich = [
    { type: "doc", content: [p([t("Baru", [{ type: "bold" }])])] },
    { type: "doc", content: [p([t("Baru")], "center")] },
    { type: "doc", content: [p([t("Satu")]), p([t("Dua")])] },
    { type: "doc", content: [p([t("Hal "), f("PAGE")])] },
  ];
  for (const view of rich) {
    expect(zonePatch("header", view)).toEqual({ header: null, headerPart: { xml: null, rels: null, media: {}, view, editLoses: [] } });
    expect(zonePatch("footer", view)).toEqual({ footer: null, pageNumbers: false, footerPart: { xml: null, rels: null, media: {}, view, editLoses: [] } });
  }
});
