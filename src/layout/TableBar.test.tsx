import type { Editor, JSONContent } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHeadlessEditor } from "../editor/headless";
import { TableBar } from "./TableBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let editor: Editor;
let root: Root;
let host: HTMLElement;
const run = vi.fn();

const cell = (type: string, text: string) => ({ type, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const DOC = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "before" }] },
    {
      type: "table",
      content: [
        { type: "tableRow", content: [cell("tableHeader", "a"), cell("tableHeader", "b")] },
        { type: "tableRow", content: [cell("tableCell", "c"), cell("tableCell", "d")] },
      ],
    },
  ],
};

const mount = (suspended = false) => {
  editor = createHeadlessEditor(DOC as never);
  editor.mount(host.appendChild(document.createElement("div")));
  root = createRoot(host.appendChild(document.createElement("div")));
  const paper = host;
  act(() => root.render(<TableBar editor={editor} paper={paper} scroller={null} suspended={suspended} run={run} />));
};

beforeEach(() => {
  run.mockClear();
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  host.remove();
});

const bar = () => host.querySelector(".tablebar");
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const tableRows = () => (editor.getJSON() as JSONContent).content![1].content!;
const select = (pos: number) => act(() => void editor.commands.setTextSelection(pos));
/** The position inside the text of the cell holding `text`. */
const inCell = (text: string) => {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) at = pos + 1;
  });
  return at;
};
const type = (el: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const key = (el: HTMLElement, name: string) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));

test("the_bar_shows_only_while_the_caret_is_in_a_table", () => {
  mount();
  select(2);
  expect(bar()).toBeNull();
  select(inCell("c"));
  expect(bar()).not.toBeNull();
  select(2);
  expect(bar()).toBeNull();
});

test("the_bar_stays_away_while_a_panel_covers_the_page", () => {
  mount(true);
  select(inCell("c"));
  expect(bar()).toBeNull();
});

test("its_buttons_run_the_table_commands", () => {
  mount();
  select(inCell("c"));
  const ids = [
    ["Add row above", "row_before"], ["Add row below", "row_after"], ["Delete row", "row_delete"],
    ["Add column before", "column_before"], ["Add column after", "column_after"], ["Delete column", "column_delete"],
    ["Header row", "header_row"], ["Make all columns the same width", "equal_columns"], ["Delete table", "table_delete"],
  ];
  for (const [label, id] of ids) {
    act(() => button(label).click());
    expect(run).toHaveBeenLastCalledWith(id);
  }
});

test("merge_and_split_are_offered_only_where_they_can_work", () => {
  mount();
  select(inCell("c"));
  expect(button("Merge selected cells").disabled).toBe(true);
  expect(button("Split merged cell").disabled).toBe(true);
  // the button says whether the table has a header row, wherever the caret is in it
  expect(button("Header row").getAttribute("aria-pressed")).toBe("true");
  act(() => void editor.commands.toggleHeaderRow());
  expect(button("Header row").getAttribute("aria-pressed")).toBe("false");
});

test("a_table_with_one_row_or_column_cannot_lose_it", () => {
  editor = createHeadlessEditor({ type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [cell("tableCell", "x")] }] }] } as never);
  editor.mount(host.appendChild(document.createElement("div")));
  root = createRoot(host.appendChild(document.createElement("div")));
  act(() => root.render(<TableBar editor={editor} paper={host} scroller={null} suspended={false} run={run} />));
  select(inCell("x"));
  expect(button("Delete row").disabled).toBe(true);
  expect(button("Delete column").disabled).toBe(true);
});

test("a_width_and_a_height_typed_in_the_bar_size_the_column_and_the_row_of_the_caret", () => {
  mount();
  select(inCell("d"));
  expect(input("Column width").value).toBe("");
  type(input("Column width"), "180");
  key(input("Column width"), "Enter");
  type(input("Row height"), "64");
  key(input("Row height"), "Enter");

  const rows = tableRows();
  expect(rows.map((row) => row.content!.map((c) => c.attrs!.colwidth))).toEqual([[null, [180]], [null, [180]]]);
  expect(rows.map((row) => row.attrs?.height ?? null)).toEqual([null, 64]);
  // the boxes show what the caret's cell has
  expect(input("Column width").value).toBe("180");
  expect(input("Row height").value).toBe("64");
  select(inCell("c"));
  expect(input("Column width").value).toBe("");
  expect(input("Row height").value).toBe("64");
});

test("an_emptied_box_clears_the_size_and_a_bad_one_is_ignored", () => {
  mount();
  select(inCell("c"));
  type(input("Row height"), "50");
  key(input("Row height"), "Enter");
  expect(tableRows()[1].attrs!.height).toBe(50);

  type(input("Row height"), "-3");
  key(input("Row height"), "Enter");
  expect(tableRows()[1].attrs!.height).toBe(50);

  type(input("Row height"), "");
  key(input("Row height"), "Enter");
  expect(tableRows()[1].attrs?.height ?? null).toBeNull();
});
