import type { JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, expect, test } from "vitest";
import { createHeadlessEditor } from "./headless";
import { pictureInfo, pictureWidth, wrapSide } from "./pictureTools";

let editor: ReturnType<typeof createHeadlessEditor>;
afterEach(() => editor?.destroy());

const SRC = "data:image/png;base64,iVBORw0KGgo=";
const image = (attrs: Record<string, unknown> = {}): JSONContent => ({ type: "image", attrs: { src: SRC, ...attrs } });
const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });

/** An editor on `blocks`, with the image at `index` selected the way a click on it selects it. */
function open(blocks: JSONContent[], index = 0, select = true) {
  editor = createHeadlessEditor({ type: "doc", content: blocks });
  if (select) {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
    editor.view?.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  }
}
const imageAttrs = (index = 0) => editor.state.doc.child(index).attrs;
const select = (index: number) => {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
};

test("a_picture_has_no_size_place_or_wrapping_until_it_is_given_one", () => {
  open([image(), para("x")]);
  expect(imageAttrs()).toMatchObject({ width: null, align: null, wrap: false, cover: false });
  expect(pictureInfo(editor)).toEqual({ width: null, align: "left", wrap: false, cover: false });
});

test("the_tools_act_on_a_selected_picture_and_on_nothing_else", () => {
  open([image(), para("x")], 0, false);
  editor.commands.setTextSelection(3);
  expect(editor.can().setPictureWidth(300)).toBe(false);
  expect(editor.can().setPictureAlign("center")).toBe(false);
  expect(editor.can().setPictureLayout("wrap")).toBe(false);
  expect(pictureInfo(editor)).toBeNull();
  select(0);
  expect(editor.can().setPictureWidth(300)).toBe(true);
});

test("the_bar_has_nothing_to_set_on_a_picture_that_is_not_drawn", () => {
  open([image({ src: "https://example.com/logo.png" })]);
  expect(pictureInfo(editor)).toBeNull();
});

test("a_width_is_kept_in_px_and_the_height_is_left_to_follow_it", () => {
  open([image({ width: 100, height: 50 })]);
  expect(editor.commands.setPictureWidth(320.4)).toBe(true);
  expect(imageAttrs()).toMatchObject({ width: 320, height: null });
  expect(pictureInfo(editor)?.width).toBe(320);
  expect(editor.commands.setPictureWidth(null)).toBe(true);
  expect(imageAttrs()).toMatchObject({ width: null, height: null });
});

test("a_width_stays_within_what_a_picture_can_be", () => {
  open([image()]);
  editor.commands.setPictureWidth(3);
  expect(imageAttrs().width).toBe(24);
  editor.commands.setPictureWidth(99999);
  expect(imageAttrs().width).toBe(4000);
  expect(editor.commands.setPictureWidth(0)).toBe(false);
  expect(editor.commands.setPictureWidth(-5)).toBe(false);
  expect(editor.commands.setPictureWidth(Number.NaN)).toBe(false);
});

test("a_share_of_the_text_width_is_a_width", () => {
  open([image()]);
  // no layout in the tests: the text is 624px wide, as the .docx writer takes a page
  editor.commands.fitPicture(0.5);
  expect(imageAttrs().width).toBe(312);
  editor.commands.fitPicture(1);
  expect(imageAttrs().width).toBe(624);
  editor.commands.fitPicture(3);
  expect(imageAttrs().width).toBe(624);
  expect(editor.commands.fitPicture(0)).toBe(false);
});

test("the_picture_stays_selected_after_it_is_changed", () => {
  open([para("a"), image(), para("b")], 1);
  editor.commands.setPictureAlign("right");
  expect(editor.state.selection).toBeInstanceOf(NodeSelection);
  expect((editor.state.selection as NodeSelection).node.type.name).toBe("image");
  editor.commands.setPictureWidth(200);
  expect(pictureInfo(editor)).toMatchObject({ width: 200, align: "right" });
});

test("a_picture_is_set_at_the_left_the_center_or_the_right", () => {
  open([image()]);
  editor.commands.setPictureAlign("center");
  expect(imageAttrs().align).toBe("center");
  editor.commands.setPictureAlign("right");
  expect(imageAttrs().align).toBe("right");
  editor.commands.setPictureAlign("left");
  expect(imageAttrs().align).toBeNull();
});

test("wrapping_text_puts_a_picture_at_a_side_and_never_in_the_middle", () => {
  open([image({ align: "center" })]);
  editor.commands.setPictureLayout("wrap");
  expect(imageAttrs()).toMatchObject({ wrap: true, align: null, cover: false });
  expect(editor.can().setPictureAlign("center")).toBe(false);
  editor.commands.setPictureAlign("right");
  expect(wrapSide(imageAttrs())).toBe("right");
  // the side is kept when the wrapping is turned on again
  editor.commands.setPictureLayout("inline");
  expect(imageAttrs()).toMatchObject({ wrap: false, align: "right" });
  editor.commands.setPictureLayout("wrap");
  expect(wrapSide(imageAttrs())).toBe("right");
  expect(pictureInfo(editor)).toMatchObject({ wrap: true, align: "right" });
});

test("a_cover_is_a_page_and_has_no_size_or_place", () => {
  open([image({ width: 200, align: "right", wrap: true })]);
  editor.commands.setPictureLayout("cover");
  expect(imageAttrs()).toMatchObject({ cover: true, wrap: false, align: null });
  expect(pictureInfo(editor)).toMatchObject({ cover: true, wrap: false });
  expect(editor.can().setPictureWidth(300)).toBe(false);
  expect(editor.can().setPictureAlign("right")).toBe(false);
  expect(editor.can().fitPicture(0.5)).toBe(false);
  expect(wrapSide(imageAttrs())).toBeNull();
  editor.commands.setPictureLayout("inline");
  expect(imageAttrs()).toMatchObject({ cover: false, wrap: false });
  expect(editor.can().setPictureWidth(300)).toBe(true);
});

test("a_change_can_be_undone_and_brings_the_picture_back_as_it_was", () => {
  open([image({ width: 120 }), para("x")]);
  // a headless editor has no undo history until it is mounted
  const host = document.createElement("div");
  editor.mount(host);
  select(0);
  editor.commands.setPictureLayout("wrap");
  expect(imageAttrs()).toMatchObject({ wrap: true, width: 120 });
  editor.commands.undo();
  expect(imageAttrs()).toMatchObject({ wrap: false, width: 120 });
});

test("a_picture_is_drawn_with_its_size_place_and_wrapping", () => {
  open([image({ width: 300, align: "center" })], 0, false);
  const html = editor.getHTML();
  expect(html).toContain('width="300"');
  expect(html).toContain("width: calc(300px * var(--look-scale, 1))");
  expect(html).toContain('data-align="center"');
  expect(html).not.toContain("data-wrap");
  editor.destroy();
  open([image({ wrap: true, align: "right" })], 0, false);
  expect(editor.getHTML()).toContain("data-wrap");
  expect(editor.getHTML()).toContain('data-align="right"');
});

test("a_cover_is_not_drawn_at_a_width_of_its_own", () => {
  open([image({ cover: true, width: 300 })], 0, false);
  expect(editor.getHTML()).not.toContain("calc(300px");
});

test("a_picture_with_nothing_set_is_drawn_as_before", () => {
  open([image()], 0, false);
  const html = editor.getHTML();
  expect(html).not.toMatch(/data-align|data-wrap|style=|width=/);
});

test("size_place_and_wrapping_come_back_from_pasted_html", () => {
  editor = createHeadlessEditor({ type: "doc", content: [para("x")] });
  editor.commands.insertContent(`<img src="${SRC}" width="250" data-align="right" data-wrap="">`);
  const pasted = editor.getJSON().content!.find((n) => n.type === "image")!;
  expect(pasted.attrs).toMatchObject({ width: 250, align: "right", wrap: true });
});

test("a_size_that_is_not_in_px_is_not_a_width", () => {
  expect(pictureWidth("250")).toBe(250);
  expect(pictureWidth("250px")).toBe(250);
  expect(pictureWidth(250.6)).toBe(251);
  for (const bad of ["50%", "auto", "", "-4", 0, null, undefined, Number.NaN]) expect(pictureWidth(bad)).toBeNull();
});
