import { Extension, type Editor } from "@tiptap/core";
import { TableRow } from "@tiptap/extension-table";
import { isInTable, selectedRect } from "@tiptap/pm/tables";
import { MIN_ROW, rowResizing } from "./rowResize";

/** The narrowest a column can be made (px); the shortest a row is `MIN_ROW`. */
export const MIN_COLUMN = 24;
const MAX_SIZE = 2400;
/** What "equal columns" spreads over when the table cannot be measured (no layout), in px. */
const FALLBACK_WIDTH = 600;

/**
 * A row's height, in px: at least that tall, as Word's "at least" row height is (`w:trHeight`). It is drawn at the scale
 * of the sheet (`--look-scale`, layout/look.ts) as the table's widths are.
 */
export const SizedRow = TableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      height: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const height = Number(element.getAttribute("data-height"));
          return height > 0 ? height : null;
        },
        renderHTML: (attributes: Record<string, unknown>) =>
          Number(attributes.height) > 0
            ? { "data-height": attributes.height, style: `height: calc(${attributes.height}px * var(--look-scale, 1))` }
            : {},
      },
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableTools: {
      /** Sets the width (px) of the column the caret is in, or of every column a cell selection spans; null leaves it to the browser. */
      setColumnWidth: (px: number | null) => ReturnType;
      /** Sets the height (px) of the row the caret is in, or of every row a cell selection spans; null makes it as tall as its content. */
      setRowHeight: (px: number | null) => ReturnType;
      /** Gives every column of the table the same width, `total` px between them (else the width the table has now). */
      equalColumns: (total?: number) => ReturnType;
    };
  }
}

const clampSize = (px: number, min: number) => Math.min(MAX_SIZE, Math.max(min, Math.round(px)));

export const TableTools = Extension.create({
  name: "tableTools",
  // a row's bottom border can be dragged, as a column's border can (the table's own `resizable`, which needs a view to drag in)
  addProseMirrorPlugins() {
    return this.editor.isEditable ? [rowResizing()] : [];
  },
  addCommands() {
    return {
      setColumnWidth:
        (px) =>
        ({ state, tr, dispatch }) => {
          if (!isInTable(state)) return false;
          if (px !== null && !(px > 0)) return false;
          const { map, table, tableStart, left, right } = selectedRect(state);
          if (!dispatch) return true;
          const width = px === null ? 0 : clampSize(px, MIN_COLUMN);
          const done = new Set<number>();
          for (const pos of map.map) {
            if (done.has(pos)) continue;
            done.add(pos);
            const cell = table.nodeAt(pos)!;
            const first = map.colCount(pos);
            const span = Number(cell.attrs.colspan) || 1;
            if (first + span <= left || first >= right) continue;
            const colwidth: number[] = Array.isArray(cell.attrs.colwidth) ? cell.attrs.colwidth.slice() : Array(span).fill(0);
            for (let k = 0; k < span; k++) if (first + k >= left && first + k < right) colwidth[k] = width;
            tr.setNodeMarkup(tableStart + pos, null, { ...cell.attrs, colwidth: colwidth.some((w) => w > 0) ? colwidth : null });
          }
          return true;
        },

      setRowHeight:
        (px) =>
        ({ state, tr, dispatch }) => {
          if (!isInTable(state)) return false;
          if (px !== null && !(px > 0)) return false;
          const { table, tableStart, top, bottom } = selectedRect(state);
          if (!dispatch) return true;
          const height = px === null ? null : clampSize(px, MIN_ROW);
          let pos = tableStart;
          table.forEach((row, _offset, index) => {
            if (index >= top && index < bottom) tr.setNodeMarkup(pos, null, { ...row.attrs, height });
            pos += row.nodeSize;
          });
          return true;
        },

      equalColumns:
        (total) =>
        ({ state, tr, dispatch, editor }) => {
          if (!isInTable(state)) return false;
          const { map, table, tableStart } = selectedRect(state);
          if (!dispatch) return true;
          const available = total ?? measuredWidth(editor, tableStart - 1, Number(table.attrs.indent) || 0);
          const width = clampSize(available / map.width, MIN_COLUMN);
          const done = new Set<number>();
          for (const pos of map.map) {
            if (done.has(pos)) continue;
            done.add(pos);
            const cell = table.nodeAt(pos)!;
            tr.setNodeMarkup(tableStart + pos, null, { ...cell.attrs, colwidth: Array(Number(cell.attrs.colspan) || 1).fill(width) });
          }
          return true;
        },
    };
  },
});

// The room the table has in the page, in the px its widths are in (the page may be drawn at a scale). An editor with no view,
// as the MCP tools use, has none to measure.
function measuredWidth(editor: Editor, tablePos: number, indent: number): number {
  let room = 0;
  let scale = 1;
  if (editor.isInitialized && !editor.isDestroyed) {
    try {
      const dom = editor.view.nodeDOM(tablePos);
      room = dom instanceof HTMLElement ? dom.clientWidth : 0;
      scale = parseFloat(getComputedStyle(editor.view.dom).getPropertyValue("--look-scale")) || 1;
    } catch {
      room = 0;
    }
  }
  return room ? Math.max(MIN_COLUMN, room / scale - indent) : FALLBACK_WIDTH;
}

/** What the table around the caret allows and has, or null when the caret is not in a table. */
export interface TableInfo {
  rows: number;
  columns: number;
  canMerge: boolean;
  canSplit: boolean;
  /** Every cell of the first row is a header cell. */
  headerRow: boolean;
  /** The width (px) set for the column at the start of the selection; null when nobody sized it. */
  columnWidth: number | null;
  /** The height (px) set for the row at the start of the selection; null when it is as tall as its content. */
  rowHeight: number | null;
}

/** Every cell of the first row of the table around the caret is a header cell. */
export function hasHeaderRow(editor: Editor): boolean {
  if (!isInTable(editor.state)) return false;
  let header = true;
  selectedRect(editor.state).table.child(0).forEach((c) => {
    if (c.type.name !== "tableHeader") header = false;
  });
  return header;
}

export function tableInfo(editor: Editor): TableInfo | null {
  const { state } = editor;
  if (!isInTable(state)) return null;
  const { map, table, left, top } = selectedRect(state);
  const pos = map.map[top * map.width + left];
  const cell = table.nodeAt(pos);
  const sized = Array.isArray(cell?.attrs.colwidth) ? Number(cell!.attrs.colwidth[left - map.colCount(pos)]) : 0;
  const height = Number(table.child(top).attrs.height);
  const can = editor.can();
  return {
    rows: map.height,
    columns: map.width,
    canMerge: can.mergeCells(),
    canSplit: can.splitCell(),
    headerRow: hasHeaderRow(editor),
    columnWidth: sized > 0 ? sized : null,
    rowHeight: height > 0 ? height : null,
  };
}
