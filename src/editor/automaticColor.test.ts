import type { JSONContent } from "@tiptap/core";
import { expect, test } from "vitest";
import { isAutomaticColor } from "./automaticColor";
import { createHeadlessEditor } from "./headless";

test.each([
  "#000", "#000000", "#FFFFFF", "#fff", "rgb(0, 0, 0)", "rgba(0,0,0,1)", "rgb(0 0 0 / 80%)", "black", "White", "windowtext",
  "#333333", "rgb(51, 51, 51)", "#e0e0e0",
])("%s is the source's default text color", (css) => {
  expect(isAutomaticColor(css)).toBe(true);
});

test.each([
  "#7a7c74", "rgb(122, 124, 116)", "#d34f46", "#357fc8", "#1a237e", "rgb(0, 0, 128)", "red", "inherit", "var(--ink)", "",
])("%s is a choice and stays", (css) => {
  expect(isAutomaticColor(css)).toBe(false);
});

const colorsOf = (html: string) => {
  const editor = createHeadlessEditor();
  editor.commands.setContent(html);
  const colors = editor
    .getJSON()
    .content!.flatMap((block: JSONContent) => block.content ?? [])
    .map((text: JSONContent) => [text.text, text.marks?.find((m) => m.type === "textStyle")?.attrs?.color ?? null]);
  editor.destroy();
  return colors;
};

test("pasted_black_and_white_runs_carry_no_color_but_real_colors_do", () => {
  expect(
    colorsOf(
      '<p><span style="color: rgb(0, 0, 0)">a</span><span style="color:#ffffff">b</span><span style="color:#d34f46">c</span></p>',
    ),
  ).toEqual([
    // no color left on the first two, so they read as one run
    ["ab", null],
    ["c", "#d34f46"],
  ]);
});

test("a_color_set_from_the_palette_is_still_kept", () => {
  const editor = createHeadlessEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] });
  editor.chain().selectAll().setColor("#357fc8").run();
  expect(editor.getJSON().content![0].content![0].marks![0].attrs!.color).toBe("#357fc8");
  editor.destroy();
});
