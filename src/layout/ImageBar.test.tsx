import type { Editor, JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHeadlessEditor } from "../editor/headless";
import { ImageBar } from "./ImageBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SRC = "data:image/png;base64,iVBORw0KGgo=";
const image = (attrs: Record<string, unknown> = {}): JSONContent => ({ type: "image", attrs: { src: SRC, ...attrs } });
const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });

let editor: Editor;
let root: Root;
let host: HTMLElement;
let width = 200; // what the browser would say the picture is wide

const mount = (blocks: JSONContent[], suspended = false) => {
  editor = createHeadlessEditor({ type: "doc", content: blocks });
  editor.mount(host.appendChild(document.createElement("div")));
  root = createRoot(host.appendChild(document.createElement("div")));
  act(() => root.render(<ImageBar editor={editor} paper={host} scroller={null} suspended={suspended} />));
};

beforeEach(() => {
  width = 200;
  host = document.createElement("div");
  document.body.append(host);
  // jsdom lays nothing out: the picture is `width` wide wherever it is
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => width);
});
afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  host.remove();
  vi.restoreAllMocks();
});

const bar = () => host.querySelector(".imagebar");
const handle = () => host.querySelector<HTMLElement>(".image-handle");
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Width"]')!;
const attrs = (index = 0) => editor.state.doc.child(index).attrs;
const selectImage = (index = 0) =>
  act(() => {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  });
const click = (el: HTMLElement) => act(() => void el.click());
const type = (el: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const key = (el: HTMLElement, name: string) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
const pointer = (el: HTMLElement, type: string, clientX: number) =>
  act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })));

test("the_bar_shows_only_while_a_picture_is_selected", () => {
  mount([para("a"), image(), para("b")]);
  expect(bar()).toBeNull();
  selectImage(1);
  expect(bar()).not.toBeNull();
  act(() => void editor.commands.setTextSelection(2));
  expect(bar()).toBeNull();
});

test("the_bar_stays_away_while_a_panel_covers_the_page", () => {
  mount([image(), para("b")], true);
  selectImage();
  expect(bar()).toBeNull();
});

test("a_picture_that_is_not_drawn_has_no_bar", () => {
  mount([image({ src: "https://example.com/a.png" }), para("b")]);
  selectImage();
  expect(bar()).toBeNull();
});

test("the_layout_is_chosen_in_line_wrapped_or_a_cover", () => {
  mount([image(), para("b")]);
  selectImage();
  expect(button("In line with the text").getAttribute("aria-pressed")).toBe("true");
  click(button("Wrap the text around the image"));
  expect(attrs()).toMatchObject({ wrap: true, cover: false });
  expect(button("Wrap the text around the image").getAttribute("aria-pressed")).toBe("true");
  expect(button("In line with the text").getAttribute("aria-pressed")).toBe("false");
  click(button("A page of its own, edge to edge"));
  expect(attrs()).toMatchObject({ wrap: false, cover: true });
  click(button("In line with the text"));
  expect(attrs()).toMatchObject({ wrap: false, cover: false });
});

test("the_picture_stays_selected_and_the_bar_stays_while_it_is_changed", () => {
  mount([image(), para("b")]);
  selectImage();
  click(button("Wrap the text around the image"));
  click(button("Align right"));
  expect(bar()).not.toBeNull();
  expect(editor.state.selection).toBeInstanceOf(NodeSelection);
  expect(attrs()).toMatchObject({ wrap: true, align: "right" });
});

test("the_position_is_left_center_or_right_and_the_one_it_is_in_is_marked", () => {
  mount([image(), para("b")]);
  selectImage();
  expect(button("Align left").getAttribute("aria-pressed")).toBe("true");
  click(button("Align center"));
  expect(attrs().align).toBe("center");
  expect(button("Align center").getAttribute("aria-pressed")).toBe("true");
  click(button("Align right"));
  expect(attrs().align).toBe("right");
  click(button("Align left"));
  expect(attrs().align).toBeNull();
});

test("text_cannot_run_down_both_sides_so_a_wrapped_picture_cannot_be_centered", () => {
  mount([image({ align: "center" }), para("b")]);
  selectImage();
  expect(button("Align center").disabled).toBe(false);
  click(button("Wrap the text around the image"));
  expect(button("Align center").disabled).toBe(true);
  expect(button("Align left").getAttribute("aria-pressed")).toBe("true");
});

test("a_cover_has_no_size_or_position_to_set", () => {
  mount([image({ cover: true }), para("b")]);
  selectImage();
  expect(button("A page of its own, edge to edge").getAttribute("aria-pressed")).toBe("true");
  for (const label of ["Align left", "Align center", "Align right", "50% of the text width", "Original size"]) {
    expect(button(label).disabled, label).toBe(true);
  }
  expect(input().disabled).toBe(true);
  expect(handle()).toBeNull();
});

test("the_width_box_shows_the_width_the_picture_is_drawn_at", () => {
  width = 340;
  mount([image(), para("b")]);
  selectImage();
  expect(input().value).toBe("340");
});

test("a_width_is_typed_and_set_with_enter_or_by_leaving_the_box", () => {
  mount([image(), para("b")]);
  selectImage();
  type(input(), "300");
  key(input(), "Enter");
  expect(attrs().width).toBe(300);
  type(input(), "180");
  act(() => void input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(attrs().width).toBe(180);
});

test("a_width_that_is_not_one_is_put_back", () => {
  mount([image({ width: 120 }), para("b")]);
  selectImage();
  type(input(), "0");
  key(input(), "Enter");
  expect(attrs().width).toBe(120);
  expect(input().value).toBe("200");
  type(input(), "");
  key(input(), "Enter");
  expect(attrs().width).toBe(120);
});

test("escape_leaves_the_width_as_it_was", () => {
  mount([image({ width: 120 }), para("b")]);
  selectImage();
  type(input(), "500");
  key(input(), "Escape");
  expect(attrs().width).toBe(120);
});

test("a_share_of_the_text_width_is_one_click", () => {
  mount([image(), para("b")]);
  selectImage();
  // no layout in the tests: the text is 624px wide
  click(button("50% of the text width"));
  expect(attrs().width).toBe(312);
  click(button("100% of the text width"));
  expect(attrs().width).toBe(624);
  click(button("25% of the text width"));
  expect(attrs().width).toBe(156);
  click(button("75% of the text width"));
  expect(attrs().width).toBe(468);
});

test("the_original_size_is_back_with_one_click_and_only_when_it_was_changed", () => {
  mount([image(), para("b")]);
  selectImage();
  expect(button("Original size").disabled).toBe(true);
  click(button("50% of the text width"));
  expect(button("Original size").disabled).toBe(false);
  click(button("Original size"));
  expect(attrs().width).toBeNull();
  expect(button("Original size").disabled).toBe(true);
});

test("the_share_the_picture_is_at_is_marked", () => {
  width = 312;
  mount([image({ width: 312 }), para("b")]);
  selectImage();
  expect(button("50% of the text width").className).toContain("on");
  expect(button("25% of the text width").className).not.toContain("on");
});

// ---------------------------------------------------------------- dragging the corner

/** The picture as the browser would draw it: `left` to `left + width`, over what `width` says. */
function layOut(left: number) {
  const image = editor.view.dom.querySelector("img")!;
  vi.spyOn(image, "getBoundingClientRect").mockImplementation(
    () => ({ left, right: left + width, top: 0, bottom: 100, width, height: 100, x: left, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
  return image;
}

test("dragging_the_corner_sets_the_width_when_the_pointer_is_let_go", () => {
  mount([image(), para("b")]);
  selectImage();
  const img = layOut(100);
  pointer(handle()!, "pointerdown", 300);
  // 100px further right: the picture is as wide again as it was drawn
  pointer(handle()!, "pointermove", 400);
  expect(img.style.width).toBe("300px"); // a preview, not yet in the document
  expect(attrs().width).toBeNull();
  pointer(handle()!, "pointerup", 400);
  expect(attrs().width).toBe(300);
});

test("a_drag_cannot_make_a_picture_smaller_than_it_can_be_or_wider_than_the_text", () => {
  mount([image(), para("b")]);
  selectImage();
  layOut(100);
  pointer(handle()!, "pointerdown", 300);
  pointer(handle()!, "pointermove", 90);
  pointer(handle()!, "pointerup", 90);
  expect(attrs().width).toBe(24);
  layOut(100); // the document drew the picture again at its new size
  pointer(handle()!, "pointerdown", 124);
  pointer(handle()!, "pointermove", 9000);
  pointer(handle()!, "pointerup", 9000);
  // the text is 624px wide here
  expect(attrs().width).toBe(624);
});

test("a_drag_that_is_cancelled_changes_nothing", () => {
  mount([image({ width: 200 }), para("b")]);
  selectImage();
  const img = layOut(100);
  img.style.width = "calc(200px * var(--look-scale, 1))";
  pointer(handle()!, "pointerdown", 300);
  pointer(handle()!, "pointermove", 500);
  pointer(handle()!, "pointercancel", 500);
  expect(attrs().width).toBe(200);
  expect(img.style.width).toBe("calc(200px * var(--look-scale, 1))");
});

test("a_picture_at_the_right_is_dragged_by_its_left_corner_and_grows_leftward", () => {
  mount([image({ align: "right" }), para("b")]);
  selectImage();
  layOut(400); // 400 to 600
  expect(handle()!.className).toContain("left");
  pointer(handle()!, "pointerdown", 400);
  pointer(handle()!, "pointermove", 300); // 100px to the left: 100px wider
  pointer(handle()!, "pointerup", 300);
  expect(attrs().width).toBe(300);
});

test("a_centered_picture_grows_to_both_sides_of_its_middle", () => {
  mount([image({ align: "center" }), para("b")]);
  selectImage();
  layOut(200); // 200 to 400, middle at 300
  pointer(handle()!, "pointerdown", 400);
  pointer(handle()!, "pointermove", 450); // 150 from the middle: 300 wide
  pointer(handle()!, "pointerup", 450);
  expect(attrs().width).toBe(300);
});

test("a_drag_that_never_moved_leaves_the_size_alone", () => {
  mount([image(), para("b")]);
  selectImage();
  layOut(100);
  pointer(handle()!, "pointerdown", 300);
  pointer(handle()!, "pointerup", 300);
  expect(attrs().width).toBeNull();
});
