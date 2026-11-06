import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useLayoutEffect, useState } from "react";
import { tableInfo } from "../editor/tableTools";

interface Props {
  editor: Editor;
  /** The page the bar sits on. */
  paper: HTMLElement | null;
  /** The element the page scrolls in: the bar stays in sight while the table is, and goes with it. */
  scroller: HTMLElement | null;
  /** The command palette or settings are open. */
  suspended: boolean;
  run(commandId: string): void;
}

const BAR_HEIGHT = 40;

/** The table the caret is in, as the browser draws it. */
function tableElement(editor: Editor): HTMLElement | null {
  try {
    const node = editor.view.domAtPos(editor.state.selection.from).node;
    return (node instanceof Element ? node : node.parentElement)?.closest("table") ?? null;
  } catch {
    return null;
  }
}

/** A size box: Enter or leaving the box sets it, an empty box sets none (the browser or the content decides). */
function SizeBox({ label, title, value, min, onSet }: { label: string; title: string; value: number | null; min: number; onSet(px: number | null): void }) {
  const commit = (input: HTMLInputElement) => {
    const text = input.value.trim();
    if (text === "") return value === null ? undefined : onSet(null);
    const px = Number(text);
    if (!(px > 0)) return void (input.value = value === null ? "" : String(value));
    if (px !== value) onSet(px);
  };
  return (
    <label className="tbar-size" title={title}>
      {label}
      {/* remounted when the value changes under it, so a new cell shows its own size */}
      <input
        key={value ?? "auto"}
        type="number"
        inputMode="numeric"
        min={min}
        step={4}
        defaultValue={value ?? ""}
        placeholder="auto"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget);
          } else if (e.key === "Escape") {
            e.currentTarget.value = value === null ? "" : String(value);
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => commit(e.currentTarget)}
      />
      <span className="unit">px</span>
    </label>
  );
}

/**
 * The tools of the table around the caret, over its top edge: rows and columns added and removed, cells merged and split,
 * the header row, the width of a column and the height of a row. It stays in sight while any of the table is.
 */
export function TableBar({ editor, paper, scroller, suspended, run }: Props) {
  const info = useEditorState({ editor, selector: ({ editor }) => tableInfo(editor) });
  const [box, setBox] = useState<{ y: number } | null>(null);
  const active = !!info && !suspended;

  useLayoutEffect(() => {
    if (!active || !paper) {
      setBox(null);
      return;
    }
    const place = () => {
      const table = tableElement(editor);
      if (!table) return setBox(null);
      const t = table.getBoundingClientRect();
      const view = scroller?.getBoundingClientRect();
      // its lower edge just above the table; held at the top of the scroll area while the table runs past it, and gone with the table
      const edge = view ? Math.max(t.top - 6, Math.min(view.top + 8 + BAR_HEIGHT, t.bottom)) : t.top - 6;
      const gone = !!view && (t.bottom < view.top + BAR_HEIGHT || t.top > view.bottom);
      const y = Math.round(edge - paper.getBoundingClientRect().top);
      setBox(gone ? null : (prev) => (prev && prev.y === y ? prev : { y }));
    };
    place();
    scroller?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    // the table grows and shrinks as rows and columns come and go, and as the page rewraps
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    const table = tableElement(editor);
    if (table) resize?.observe(table);
    return () => {
      scroller?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      resize?.disconnect();
    };
  }, [editor, paper, scroller, active, info?.rows, info?.columns]);

  if (!info || !box) return null;
  const button = (id: string, glyph: string, title: string, opts: { on?: boolean; disabled?: boolean; danger?: boolean } = {}) => (
    <button
      className={`${opts.on ? "on" : ""}${opts.danger ? " danger" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={opts.on}
      disabled={opts.disabled}
      onClick={() => run(id)}
    >
      <span className="glyph">{glyph}</span>
    </button>
  );
  return (
    <div
      className="tablebar no-print"
      role="toolbar"
      aria-label="Table"
      style={{ top: box.y }}
      // a mouse-down on a button would take the caret from the cell; the size boxes need it
      onMouseDown={(e) => {
        if (!(e.target as Element).closest("input")) e.preventDefault();
      }}
    >
      <div className="tbar-group">
        {button("row_before", "↑＋", "Add row above")}
        {button("row_after", "↓＋", "Add row below")}
        {button("row_delete", "－", "Delete row", { disabled: info.rows < 2 })}
        <span className="tbar-label">Row</span>
      </div>
      <span className="sep" />
      <div className="tbar-group">
        {button("column_before", "←＋", "Add column before")}
        {button("column_after", "→＋", "Add column after")}
        {button("column_delete", "－", "Delete column", { disabled: info.columns < 2 })}
        <span className="tbar-label">Column</span>
      </div>
      <span className="sep" />
      <div className="tbar-group">
        {button("cell_merge", "⊞", "Merge selected cells", { disabled: !info.canMerge })}
        {button("cell_split", "⊟", "Split merged cell", { disabled: !info.canSplit })}
        {button("header_row", "H", "Header row", { on: info.headerRow })}
        <span className="tbar-label">Cell</span>
      </div>
      <span className="sep" />
      <div className="tbar-group">
        <SizeBox label="W" title="Column width" value={info.columnWidth} min={24} onSet={(px) => editor.chain().setColumnWidth(px).run()} />
        <SizeBox label="H" title="Row height" value={info.rowHeight} min={16} onSet={(px) => editor.chain().setRowHeight(px).run()} />
        {button("equal_columns", "⇔", "Make all columns the same width")}
      </div>
      <span className="sep" />
      {button("table_delete", "✕", "Delete table", { danger: true })}
    </div>
  );
}
