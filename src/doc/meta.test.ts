import { expect, test } from "vitest";
import { partText } from "./meta";

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

test("editing_a_part_with_fields_or_content_the_page_cannot_show_warns_first", async () => {
  const { editWarning } = await import("./meta");
  expect(editWarning({ ...part(null), editLoses: [] }, "header")).toBeNull();
  expect(editWarning({ ...part(null) }, "header")).toBeNull();
  expect(editWarning({ ...part(null), editLoses: ["fields"] }, "footer")).toBe(
    "This footer has fields, such as page numbers or dates. Editing it turns them into plain text. Edit it anyway?");
  expect(editWarning({ ...part(null), editLoses: ["fields", "other_content"] }, "header")).toBe(
    "This header has fields, such as page numbers or dates, and content DocBro can't show. Editing it turns the fields into plain text and leaves the rest out. Edit it anyway?");
  expect(editWarning({ ...part(null), editLoses: ["other_content"] }, "header")).toBe(
    "This header has content DocBro can't show. Editing it leaves that out. Edit it anyway?");
});
