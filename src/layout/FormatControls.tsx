import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DocLook } from "../doc/meta";
import { baseSize, fontOptions, formatSize, sameFont, SIZES, stepSize, validSize, fontStack } from "../editor/fonts";
import { MIXED, typeStyleAt } from "../editor/textStyle";
import { applyFont, applySize } from "./blocks";

interface Props {
  /** The editor the controls act on: the document's, or the header or footer being edited. */
  editor: Editor;
  /** How the file sets its text, for a document from a .docx: the typeface and size its unmarked text has. */
  look?: DocLook | null;
}

/** The typeface and size of the selection, and of the block it is in, as the controls show them. */
function useTypeStyle(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor }) => {
      const { $from } = editor.state.selection;
      return { ...typeStyleAt(editor.state), level: $from.parent.type.name === "heading" ? ($from.parent.attrs.level as number) : null };
    },
  });
}

/**
 * A list under its button, in <body>: the menu bar's slot clips what overflows it, and the macOS webview also clips a
 * fixed box inside it when painting. A click anywhere else or Esc closes it.
 */
function DropList({ anchor, onClose, children }: { anchor: HTMLElement; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; minWidth: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const b = anchor.getBoundingClientRect();
    if (!el) return;
    const left = Math.max(8, Math.min(b.left, window.innerWidth - el.offsetWidth - 8));
    setAt({ left, top: b.bottom + 4, minWidth: b.width });
  }, [anchor]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className="menu-list fmt-list" role="listbox" style={at ?? { visibility: "hidden" }} onMouseDown={(e) => e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
}

/** The menu bar's typeface and size: what the selection is in, and a list or a box to change it. */
export function FormatControls({ editor, look }: Props) {
  const style = useTypeStyle(editor);
  const [open, setOpen] = useState<"font" | "size" | null>(null);
  const fontButton = useRef<HTMLButtonElement>(null);
  const sizeButton = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(null);

  const face = typeof style.font === "string" ? style.font : null;
  const shownFace = style.font === MIXED ? "" : face ?? look?.font ?? "Inter";
  const size = typeof style.size === "number" ? style.size : null;
  const base = baseSize(style.level, look);
  // a selection in more than one size steps from the page's own
  const current = size ?? base;

  // Default is the one ticked while nothing sets a face; a selection in more than one has none
  const faceIs = (name: string | null) => (style.font === MIXED ? false : name === null ? face === null : sameFont(name, face));

  const chooseFont = (name: string | null) => {
    setOpen(null);
    applyFont(editor, name);
  };
  const chooseSize = (pt: number | null) => {
    setOpen(null);
    applySize(editor, pt);
  };

  return (
    <div className="fmt">
      <button
        ref={fontButton}
        className={`fmt-font${open === "font" ? " open" : ""}`}
        title="Font"
        aria-label="Font"
        aria-haspopup="listbox"
        aria-expanded={open === "font"}
        onClick={() => setOpen(open === "font" ? null : "font")}
      >
        <span className="name" style={shownFace ? { fontFamily: fontStack(shownFace) } : undefined}>{shownFace || "Mixed"}</span>
        <span className="caret">▾</span>
      </button>
      {open === "font" && fontButton.current && (
        <DropList anchor={fontButton.current} onClose={close}>
          {fontOptions(face).map((name) => (
            <button
              key={name ?? "default"}
              className="menu-item font-row"
              role="option"
              aria-selected={faceIs(name)}
              style={name ? { fontFamily: fontStack(name) } : undefined}
              onClick={() => chooseFont(name)}
            >
              <span className="label">{name ?? "Default"}</span>
              <span className="state">{faceIs(name) ? "✓" : ""}</span>
            </button>
          ))}
        </DropList>
      )}

      <div className="fmt-size" role="group" aria-label="Font size">
        <button title="Smaller" aria-label="Decrease font size" onClick={() => applySize(editor, stepSize(current, -1))}>−</button>
        <SizeBox editor={editor} shown={style.size === MIXED ? "" : formatSize(current)} />
        <button title="Larger" aria-label="Increase font size" onClick={() => applySize(editor, stepSize(current, 1))}>+</button>
        <button
          ref={sizeButton}
          className="fmt-size-list"
          title="Sizes"
          aria-label="Font sizes"
          aria-haspopup="listbox"
          aria-expanded={open === "size"}
          onClick={() => setOpen(open === "size" ? null : "size")}
        >
          ▾
        </button>
      </div>
      {open === "size" && sizeButton.current && (
        <DropList anchor={sizeButton.current.parentElement!} onClose={close}>
          {SIZES.map((pt) => (
            <button key={pt} className="menu-item" role="option" aria-selected={pt === size} onClick={() => chooseSize(pt)}>
              <span className="label">{pt}</span>
              <span className="state">{pt === size ? "✓" : ""}</span>
            </button>
          ))}
          <button className="menu-item" onClick={() => chooseSize(null)}>
            <span className="label">Default ({formatSize(base)})</span>
            <span className="state">{size === null ? "✓" : ""}</span>
          </button>
        </DropList>
      )}
    </div>
  );
}

/** The size as a number to type: Enter applies it, Esc puts the old one back, and either hands the caret back to the text. */
function SizeBox({ editor, shown }: { editor: Editor; shown: string }) {
  const [draft, setDraft] = useState<string | null>(null);

  const finish = (apply: boolean) => {
    const size = apply && draft !== null ? validSize(draft) : null;
    setDraft(null);
    if (size) applySize(editor, size);
    else editor.commands.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <input
      className="fmt-size-box"
      value={draft ?? shown}
      inputMode="decimal"
      aria-label="Size in points"
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => setDraft(null)}
      onKeyDown={onKeyDown}
    />
  );
}
