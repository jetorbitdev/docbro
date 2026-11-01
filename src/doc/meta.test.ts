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
