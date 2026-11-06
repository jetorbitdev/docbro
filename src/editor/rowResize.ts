import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { TableMap, cellAround } from "@tiptap/pm/tables";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/** The shortest a row can be made (px). */
export const MIN_ROW = 16;
/** How near a row's border the pointer has to be to take it (px on screen). */
const GRAB = 4;

interface Drag {
  /** The row's position in the document. */
  pos: number;
  startY: number;
  /** The row's height when the drag began, in the px its attribute is in (the sheet may be drawn at a scale). */
  startHeight: number;
  /** The least the row can be: as tall as what is in it, which a smaller height would not show. */
  min: number;
  scale: number;
  height: number;
}
interface State {
  /** The row whose bottom border the pointer is on. */
  hover: number | null;
  drag: Drag | null;
}
type Meta = Partial<State>;

export const rowResizingKey = new PluginKey<State>("rowResizing");

const scaleOf = (view: EditorView) => parseFloat(getComputedStyle(view.dom).getPropertyValue("--look-scale")) || 1;

function rowNodeAt(state: EditorState, pos: number): PMNode | null {
  const node = pos >= 0 && pos <= state.doc.content.size ? state.doc.nodeAt(pos) : null;
  return node?.type.name === "tableRow" ? node : null;
}

/** The row whose bottom border is at the pointer: the one the cell under it ends in, or the one above the cell's top. */
function rowBorderAt(view: EditorView, event: MouseEvent): number | null {
  const target = event.target instanceof Element ? event.target : null;
  const cell = target?.closest("td, th");
  if (!cell || !view.dom.contains(cell)) return null;
  const box = cell.getBoundingClientRect();
  const atBottom = Math.abs(box.bottom - event.clientY) <= GRAB;
  const atTop = Math.abs(event.clientY - box.top) <= GRAB;
  if (!atBottom && !atTop) return null;
  let $cell;
  try {
    $cell = cellAround(view.state.doc.resolve(view.posAtDOM(cell, 0)));
  } catch {
    return null;
  }
  if (!$cell) return null;
  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const rect = TableMap.get(table).findCell($cell.pos - tableStart);
  const index = atBottom ? rect.bottom - 1 : rect.top - 1;
  if (index < 0) return null; // the top edge of the table is no row's bottom
  let pos = tableStart;
  for (let i = 0; i < index; i++) pos += table.child(i).nodeSize;
  return pos;
}

/**
 * Dragging a row's bottom border up or down sets the row's height, as dragging a column's border sets its width
 * (prosemirror-tables). The row follows the pointer while it is held, and one step is written when it is let go.
 */
export function rowResizing(): Plugin<State> {
  return new Plugin<State>({
    key: rowResizingKey,
    state: {
      init: () => ({ hover: null, drag: null }),
      apply(tr, prev) {
        const meta = tr.getMeta(rowResizingKey) as Meta | undefined;
        let next = prev;
        if (tr.docChanged) {
          next = {
            hover: null,
            drag: prev.drag ? { ...prev.drag, pos: tr.mapping.map(prev.drag.pos) } : null,
          };
        }
        return meta ? { ...next, ...meta } : next;
      },
    },
    props: {
      attributes: (state) => {
        const s = rowResizingKey.getState(state);
        return s && (s.hover !== null || s.drag) ? { class: "row-resize-cursor" } : ({} as Record<string, string>);
      },
      decorations(state) {
        const s = rowResizingKey.getState(state);
        const pos = s?.drag?.pos ?? s?.hover ?? null;
        const row = pos === null ? null : rowNodeAt(state, pos);
        if (pos === null || !row) return null;
        const attrs = s!.drag
          ? { class: "row-resizing", style: `height: calc(${s!.drag.height}px * var(--look-scale, 1))` }
          : { class: "row-resize-hover" };
        return DecorationSet.create(state.doc, [Decoration.node(pos, pos + row.nodeSize, attrs)]);
      },
      handleDOMEvents: {
        mousemove(view, event) {
          const s = rowResizingKey.getState(view.state);
          if (!view.editable || !s || s.drag) return false;
          const hover = rowBorderAt(view, event);
          if (hover !== s.hover) view.dispatch(view.state.tr.setMeta(rowResizingKey, { hover } satisfies Meta));
          return false;
        },
        mouseleave(view) {
          if (rowResizingKey.getState(view.state)?.hover !== null) view.dispatch(view.state.tr.setMeta(rowResizingKey, { hover: null } satisfies Meta));
          return false;
        },
        mousedown(view, event) {
          const s = rowResizingKey.getState(view.state);
          if (!view.editable || event.button !== 0 || !s || s.hover === null || s.drag) return false;
          const row = view.nodeDOM(s.hover);
          if (!(row instanceof HTMLElement)) return false;
          const scale = scaleOf(view);
          const startHeight = Math.max(MIN_ROW, Math.round(row.getBoundingClientRect().height / scale));
          // a row is at least its height and at least its content: with no height of its own it is as tall as the content
          const set = row.style.height;
          row.style.height = "0px";
          const natural = row.getBoundingClientRect().height;
          row.style.height = set;
          const min = Math.min(startHeight, Math.max(MIN_ROW, Math.ceil(natural / scale)));
          const drag: Drag = { pos: s.hover, startY: event.clientY, startHeight, min, scale, height: startHeight };
          view.dispatch(view.state.tr.setMeta(rowResizingKey, { hover: null, drag } satisfies Meta));

          const win = view.dom.ownerDocument.defaultView ?? window;
          const move = (e: MouseEvent) => {
            const current = rowResizingKey.getState(view.state)?.drag;
            if (!current) return finish(e, true);
            if (!e.buttons) return finish(e);
            const height = Math.max(drag.min, Math.round(drag.startHeight + (e.clientY - drag.startY) / drag.scale));
            if (height !== current.height) view.dispatch(view.state.tr.setMeta(rowResizingKey, { drag: { ...current, height } } satisfies Meta));
          };
          const finish = (_: MouseEvent, cancel = false) => {
            win.removeEventListener("mouseup", finish);
            win.removeEventListener("mousemove", move);
            const current = rowResizingKey.getState(view.state)?.drag;
            if (!current) return;
            const tr = view.state.tr.setMeta(rowResizingKey, { drag: null } satisfies Meta);
            const node = rowNodeAt(view.state, current.pos);
            if (!cancel && node && current.height !== current.startHeight) tr.setNodeMarkup(current.pos, null, { ...node.attrs, height: current.height });
            view.dispatch(tr);
          };
          win.addEventListener("mouseup", finish);
          win.addEventListener("mousemove", move);
          event.preventDefault();
          return true;
        },
      },
    },
  });
}
