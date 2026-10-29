import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { useEffect, useLayoutEffect, useState } from "react";
import { applyBlock, bubblePosition, type Rect } from "./blocks";

interface Props {
  editor: Editor;
  /** The page the bubble sits on. */
  paper: HTMLElement | null;
  /** The element the page scrolls in: the bubble hides once its selection scrolls out of sight. */
  scroller: HTMLElement | null;
  /** The command palette is open. */
  suspended: boolean;
  run(commandId: string): void;
  /** Absent until comments exist: the button is drawn but disabled. */
  onComment?(): void;
}

/** The selection's box in the window, from the browser's range, else from the editor's own coordinates. */
function selectionRect(editor: Editor): Rect {
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const r = selection.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height) return r;
  }
  const { from, to } = editor.state.selection;
  const a = editor.view.coordsAtPos(from);
  const b = editor.view.coordsAtPos(to);
  const left = Math.min(a.left, b.left);
  return { left, top: a.top, width: Math.max(a.right, b.right) - left, height: b.bottom - a.top };
}

/** Mock 157–169: B, I, U, H2, quote, highlight and Comment over a non-empty text selection. */
export function SelectionBubble({ editor, paper, scroller, suspended, run, onComment }: Props) {
  const s = useEditorState({
    editor,
    selector: ({ editor }) => {
      const { selection, doc } = editor.state;
      return {
        text: selection instanceof TextSelection && !selection.empty && doc.textBetween(selection.from, selection.to, " ").trim() !== "",
        focused: editor.isFocused,
        from: selection.from,
        to: selection.to,
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        underline: editor.isActive("underline"),
      };
    },
  });
  const [dragging, setDragging] = useState(false);
  const [box, setBox] = useState<{ x: number; y: number } | null>(null);

  // the bubble waits while the mouse is still selecting, so it never gets under the pointer
  useEffect(() => {
    if (!paper) return;
    const down = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.(".ProseMirror")) setDragging(true);
    };
    const up = () => setDragging(false);
    paper.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    return () => {
      paper.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
    };
  }, [paper]);

  const visible = s.text && s.focused && !suspended && !dragging;
  useLayoutEffect(() => {
    if (!visible || !paper) {
      setBox(null);
      return;
    }
    const place = () => {
      const sel = selectionRect(editor);
      const view = scroller?.getBoundingClientRect();
      // hidden once the bubble would leave the scroll area at the top, or the selection at the bottom
      const gone = !!view && (sel.top - 48 < view.top || sel.top > view.bottom);
      const next = gone ? null : bubblePosition(sel, paper.getBoundingClientRect());
      setBox((prev) => (prev && next && prev.x === next.x && prev.y === next.y ? prev : next));
    };
    place();
    scroller?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      scroller?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [editor, paper, scroller, visible, s.from, s.to]);

  if (!box) return null;
  const on = (active: boolean) => (active ? " on" : "");
  return (
    <div
      className="bubble no-print"
      role="toolbar"
      aria-label="Format selection"
      style={{ left: box.x, top: box.y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button className={`bold${on(s.bold)}`} title="Bold" aria-pressed={s.bold} onClick={() => run("bold")}>
        B
      </button>
      <button className={`italic${on(s.italic)}`} title="Italic" aria-pressed={s.italic} onClick={() => run("italic")}>
        I
      </button>
      <button className={`underline${on(s.underline)}`} title="Underline" aria-pressed={s.underline} onClick={() => run("underline")}>
        U
      </button>
      <span className="sep" />
      <button className="wide strong" title="Heading 2" onClick={() => applyBlock(editor, "h2")}>
        H2
      </button>
      <button className="wide quote" title="Quote" onClick={() => applyBlock(editor, "blockquote")}>
        “
      </button>
      <button title="Highlight" aria-label="Highlight" onClick={() => run("highlight")}>
        <span className="swatch-hl" />
      </button>
      <span className="sep" />
      <button className="wide comment" title="Comment" disabled={!onComment} onClick={onComment}>
        Comment
      </button>
    </div>
  );
}
