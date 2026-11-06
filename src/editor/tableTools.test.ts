import type { JSONContent } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, expect, test } from "vitest";
import { createHeadlessEditor } from "./headless";
import { hasHeaderRow, tableInfo } from "./tableTools";

let editor: ReturnType<typeof createHeadlessEditor>;
afterEach(() => editor?.destroy());

const cell = (text: string, type = "tableCell"): JSONContent => ({
  type,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const grid = (rows: number, columns: number, header = false): JSONContent => ({
  type: "doc",
  content: [{
    type: "table",
    content: Array.from({ length: rows }, (_, r) => ({
      type: "tableRow",
      content: Array.from({ length: columns }, (_, c) => cell(`${r}${c}`, header && r === 0 ? "tableHeader" : "tableCell")),
    })),
  }],
});
const rowsOf = () => (editor.getJSON().content![0].content as JSONContent[]);

/** The caret in the text of the cell at (row, column). */
function caretIn(row: number, column: number) {
  const table = editor.state.doc.child(0);
  let pos = 1;
  for (let r = 0; r < row; r++) pos += table.child(r).nodeSize;
  pos += 1; // into the row
  const tr = table.child(row);
  for (let c = 0; c < column; c++) pos += tr.child(c).nodeSize;
  editor.commands.setTextSelection(pos + 2);
}

/** A selection of the cells from (r1, c1) to (r2, c2). */
function selectCells(r1: number, c1: number, r2: number, c2: number) {
  const table = editor.state.doc.child(0);
  const at = (r: number, c: number) => {
    let pos = 1;
    for (let i = 0; i < r; i++) pos += table.child(i).nodeSize;
    pos += 1;
    for (let i = 0; i < c; i++) pos += table.child(r).child(i).nodeSize;
    return pos;
  };
  const sel = CellSelection.create(editor.state.doc, at(r1, c1), at(r2, c2));
  editor.view.dispatch(editor.state.tr.setSelection(sel));
}

const widths = () => rowsOf().map((row) => row.content!.map((c) => c.attrs!.colwidth ?? null));

test("a_column_gets_the_width_typed_for_it_in_every_row", () => {
  editor = createHeadlessEditor(grid(3, 3));
  caretIn(1, 1);
  expect(editor.commands.setColumnWidth(180)).toBe(true);
  expect(widths()).toEqual(Array(3).fill([null, [180], null]));
  expect(tableInfo(editor)!.columnWidth).toBe(180);
  // no width at all lets the browser decide again
  editor.commands.setColumnWidth(null);
  expect(widths()).toEqual(Array(3).fill([null, null, null]));
});

test("a_width_is_kept_within_what_a_column_can_be", () => {
  editor = createHeadlessEditor(grid(2, 2));
  caretIn(0, 0);
  editor.commands.setColumnWidth(3);
  expect(widths()[0][0]).toEqual([24]);
  editor.commands.setColumnWidth(99999);
  expect(widths()[0][0]).toEqual([2400]);
  expect(editor.commands.setColumnWidth(-5)).toBe(false);
  expect(editor.commands.setColumnWidth(Number.NaN)).toBe(false);
});

test("a_cell_selection_sizes_every_column_and_row_it_spans", () => {
  editor = createHeadlessEditor(grid(3, 3));
  editor.mount(document.createElement("div"));
  selectCells(0, 1, 1, 2);
  editor.commands.setColumnWidth(120);
  editor.commands.setRowHeight(48);
  expect(widths()).toEqual(Array(3).fill([null, [120], [120]]));
  expect(rowsOf().map((row) => row.attrs?.height ?? null)).toEqual([48, 48, null]);
});

test("a_row_height_is_set_and_cleared_on_the_row_of_the_caret", () => {
  editor = createHeadlessEditor(grid(3, 2));
  caretIn(2, 0);
  editor.commands.setRowHeight(60);
  expect(rowsOf().map((row) => row.attrs?.height ?? null)).toEqual([null, null, 60]);
  expect(tableInfo(editor)!.rowHeight).toBe(60);
  editor.commands.setRowHeight(null);
  expect(rowsOf().map((row) => row.attrs?.height ?? null)).toEqual([null, null, null]);
  editor.commands.setRowHeight(2);
  expect(rowsOf()[2].attrs!.height).toBe(16);
});

test("a_cell_that_spans_columns_takes_the_width_of_the_column_set_and_keeps_the_others", () => {
  editor = createHeadlessEditor({
    type: "doc",
    content: [{
      type: "table",
      content: [
        { type: "tableRow", content: [{ ...cell("a"), attrs: { colspan: 2, colwidth: [100, 150] } }, cell("b")] },
        { type: "tableRow", content: [cell("c"), cell("d"), cell("e")] },
      ],
    }],
  });
  caretIn(1, 1);
  editor.commands.setColumnWidth(90);
  expect(widths()).toEqual([[[100, 90], null], [null, [90], null]]);
});

test("equal_columns_share_the_given_width_and_fill_a_spanning_cell_per_column", () => {
  editor = createHeadlessEditor(grid(2, 4));
  caretIn(0, 0);
  editor.commands.setColumnWidth(10);
  editor.commands.equalColumns(800);
  expect(widths()).toEqual(Array(2).fill([[200], [200], [200], [200]]));
  // with no layout to measure it falls back to a width of its own
  editor.commands.equalColumns();
  expect(widths()[0]).toEqual([[150], [150], [150], [150]]);
});

test("the_size_commands_do_nothing_outside_a_table", () => {
  editor = createHeadlessEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] });
  editor.commands.setTextSelection(1);
  const before = JSON.stringify(editor.getJSON());
  expect(editor.commands.setColumnWidth(100)).toBe(false);
  expect(editor.commands.setRowHeight(100)).toBe(false);
  expect(editor.commands.equalColumns(100)).toBe(false);
  expect(JSON.stringify(editor.getJSON())).toBe(before);
  expect(tableInfo(editor)).toBeNull();
  expect(hasHeaderRow(editor)).toBe(false);
});

test("cells_merge_and_split_and_the_first_row_turns_into_a_header", () => {
  editor = createHeadlessEditor(grid(3, 3));
  editor.mount(document.createElement("div"));
  caretIn(1, 1);
  expect(tableInfo(editor)).toMatchObject({ rows: 3, columns: 3, canMerge: false, canSplit: false, headerRow: false });

  selectCells(1, 0, 1, 1);
  expect(tableInfo(editor)!.canMerge).toBe(true);
  expect(editor.commands.mergeCells()).toBe(true);
  expect(rowsOf()[1].content!.map((c) => c.attrs!.colspan)).toEqual([2, 1]);
  caretIn(1, 0);
  expect(tableInfo(editor)).toMatchObject({ canMerge: false, canSplit: true });
  expect(editor.commands.splitCell()).toBe(true);
  expect(rowsOf()[1].content!.map((c) => c.attrs!.colspan)).toEqual([1, 1, 1]);

  caretIn(0, 0);
  editor.commands.toggleHeaderRow();
  expect(hasHeaderRow(editor)).toBe(true);
  expect(tableInfo(editor)!.headerRow).toBe(true);
  editor.commands.toggleHeaderRow();
  expect(hasHeaderRow(editor)).toBe(false);
});

test("a_rows_height_is_drawn_as_a_minimum_at_the_scale_of_the_sheet", () => {
  editor = createHeadlessEditor(grid(2, 2));
  editor.mount(document.createElement("div"));
  caretIn(1, 0);
  editor.commands.setRowHeight(72);
  const rows = editor.view.dom.querySelectorAll("tr");
  expect((rows[0] as HTMLElement).style.height).toBe("");
  expect((rows[1] as HTMLElement).style.height).toBe("calc(72px * var(--look-scale, 1))");
  // and it is read back from pasted or saved HTML
  expect(editor.getHTML()).toContain('data-height="72"');
  const copy = createHeadlessEditor();
  copy.commands.setContent(editor.getHTML());
  expect((copy.getJSON().content![0].content as JSONContent[]).map((row) => row.attrs?.height ?? null)).toEqual([null, 72]);
  copy.destroy();
});
