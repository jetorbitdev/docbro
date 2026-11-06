import type { JSONContent } from "@tiptap/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHeadlessEditor } from "./headless";

let editor: ReturnType<typeof createHeadlessEditor>;
let host: HTMLElement;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
});
afterEach(() => {
  editor?.destroy();
  host.remove();
});

const cell = (type: string, text: string, attrs?: object): JSONContent => ({
  type,
  ...(attrs && { attrs }),
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
// a line after the table, as the editor keeps one: it would otherwise add it on the first step
const END: JSONContent = { type: "paragraph" };
const DOC: JSONContent = {
  type: "doc",
  content: [{
    type: "table",
    content: [
      { type: "tableRow", content: [cell("tableCell", "a"), cell("tableCell", "b")] },
      { type: "tableRow", content: [cell("tableCell", "c"), cell("tableCell", "d")] },
    ],
  }, END],
};

const heights = () => (editor.getJSON().content![0].content as JSONContent[]).map((row) => row.attrs?.height ?? null);
const dom = () => editor.view.dom as HTMLElement;
const cells = () => Array.from(dom().querySelectorAll("td")) as HTMLElement[];
const rows = () => Array.from(dom().querySelectorAll("tr")) as HTMLElement[];

/** There is no layout here: each cell and row is told where it is, 40px tall, the first row from y=100. */
function layout() {
  rows().forEach((row, i) => {
    const top = 100 + i * 40;
    row.getBoundingClientRect = () => ({ top, bottom: top + 40, height: 40, left: 0, right: 200, width: 200, x: 0, y: top, toJSON() {} });
    for (const td of Array.from(row.children) as HTMLElement[]) td.getBoundingClientRect = row.getBoundingClientRect;
  });
}
const mouse = (target: EventTarget, type: string, clientY: number, buttons = 1) =>
  target.dispatchEvent(new MouseEvent(type, { clientX: 10, clientY, buttons, button: 0, bubbles: true, cancelable: true }));

const mountTable = (content = DOC) => {
  editor = createHeadlessEditor(content);
  editor.mount(host);
  layout();
};

test("the_pointer_on_a_rows_bottom_border_takes_it_and_one_elsewhere_does_not", () => {
  mountTable();
  mouse(cells()[0], "mousemove", 139); // the bottom of the first row
  expect(dom().classList.contains("row-resize-cursor")).toBe(true);
  expect(rows()[0].classList.contains("row-resize-hover")).toBe(true);
  mouse(cells()[0], "mousemove", 120); // the middle of the cell
  expect(dom().classList.contains("row-resize-cursor")).toBe(false);
  mouse(cells()[2], "mousemove", 141); // the top of the second row: the same border, from below
  expect(rows()[0].classList.contains("row-resize-hover")).toBe(true);
  mouse(cells()[0], "mousemove", 101); // the top edge of the table is no row's bottom
  expect(dom().classList.contains("row-resize-cursor")).toBe(false);
});

test("dragging_the_border_down_sets_the_height_of_the_row_above_it_in_one_step", () => {
  mountTable();
  mouse(cells()[0], "mousemove", 139);
  mouse(cells()[0], "mousedown", 139);
  mouse(window, "mousemove", 159);
  expect(rows()[0].style.height).toBe("calc(60px * var(--look-scale, 1))"); // follows the pointer
  expect(heights()).toEqual([null, null]); // and is written when let go
  mouse(window, "mousemove", 169);
  mouse(window, "mouseup", 169, 0);
  expect(heights()).toEqual([70, null]);
  expect(dom().classList.contains("row-resize-cursor")).toBe(false);
  editor.commands.undo();
  expect(heights()).toEqual([null, null]);
});

test("a_row_is_drawn_and_dragged_at_the_scale_of_the_sheet", () => {
  mountTable();
  dom().style.setProperty("--look-scale", "0.5");
  mouse(cells()[0], "mousemove", 139);
  mouse(cells()[0], "mousedown", 139);
  mouse(window, "mousemove", 159); // 20px on screen is 40px of the sheet, on a row 80px tall of it
  mouse(window, "mouseup", 159, 0);
  expect(heights()).toEqual([120, null]);
});

test("a_row_cannot_be_dragged_shorter_than_what_is_in_it", () => {
  mountTable();
  mouse(cells()[0], "mousemove", 139);
  mouse(cells()[0], "mousedown", 139);
  mouse(window, "mousemove", 110);
  mouse(window, "mouseup", 110, 0);
  expect(heights()).toEqual([null, null]);
});

test("letting_the_mouse_go_outside_the_window_ends_the_drag", () => {
  mountTable();
  mouse(cells()[0], "mousemove", 139);
  mouse(cells()[0], "mousedown", 139);
  mouse(window, "mousemove", 159);
  mouse(window, "mousemove", 179, 0); // no button is down any more: the mouse-up was missed
  expect(heights()).toEqual([60, null]); // the row is left where it was held
  mouse(window, "mousemove", 300);
  expect(heights()).toEqual([60, null]);
  expect(dom().classList.contains("row-resize-cursor")).toBe(false);
});

test("a_border_below_a_cell_that_spans_rows_sizes_the_last_row_it_covers", () => {
  mountTable({
    type: "doc",
    content: [{
      type: "table",
      content: [
        { type: "tableRow", content: [cell("tableCell", "a", { rowspan: 2 }), cell("tableCell", "b")] },
        { type: "tableRow", content: [cell("tableCell", "d")] },
      ],
    }, END],
  });
  const a = cells()[0];
  a.getBoundingClientRect = () => ({ top: 100, bottom: 180, height: 80, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON() {} });
  mouse(a, "mousemove", 179);
  mouse(a, "mousedown", 179);
  mouse(window, "mousemove", 199);
  mouse(window, "mouseup", 199, 0);
  expect(heights()).toEqual([null, 60]);
});

test("a_document_nobody_can_edit_has_no_drag", () => {
  editor = createHeadlessEditor(DOC);
  editor.setEditable(false);
  editor.mount(host);
  layout();
  mouse(cells()[0], "mousemove", 139);
  expect(dom().classList.contains("row-resize-cursor")).toBe(false);
  expect(rows()[0].classList.contains("row-resize-hover")).toBe(false);
});
