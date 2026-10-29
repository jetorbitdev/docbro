import type { Editor } from "@tiptap/core";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { applyColor, applyLink, popoverPosition, TEXT_COLORS } from "./blocks";

const WIDTH = 280;

interface Props {
  editor: Editor;
  /** The page the popover sits on. */
  paper: HTMLElement | null;
  /** Closes the popover. */
  onClose(): void;
}

/** Under the end of the selection, inside the page; null until it can be measured. */
function useAnchor(editor: Editor, paper: HTMLElement | null) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!paper) return;
    const caret = editor.view.coordsAtPos(editor.state.selection.to);
    setAt(popoverPosition(caret, paper.getBoundingClientRect(), WIDTH));
  }, [editor, paper]);
  return at;
}

const place = (at: { x: number; y: number } | null): CSSProperties => ({
  left: at?.x ?? 0,
  top: at?.y ?? 0,
  width: WIDTH,
  visibility: at ? undefined : "hidden",
});

/** Closes on a click anywhere outside, and gives the popover its keyboard focus once the command that opened it is done with focus. */
function useDismiss(box: RefObject<HTMLElement | null>, focus: () => void, onClose: () => void) {
  useEffect(() => {
    // the palette hands the editor its focus back in a frame of its own; the popover takes it after that
    const frame = requestAnimationFrame(focus);
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", away);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", away);
    };
    // set up once, when the popover opens
  }, []);
}

/** Insert ▸ Link: a field for the address. Enter applies it, an empty field removes the link, Esc closes. */
export function LinkPopover({ editor, paper, onClose }: Props) {
  const at = useAnchor(editor, paper);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<string>(() => (editor.getAttributes("link").href as string | undefined) ?? "");
  const [refused, setRefused] = useState(false);

  useDismiss(
    box,
    () => {
      field.current?.focus();
      field.current?.select();
    },
    onClose,
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      if (applyLink(editor, value)) onClose();
      else setRefused(true);
    } else if (e.key === "Escape") {
      editor.commands.focus();
      onClose();
    } else return;
    e.preventDefault();
  };

  return (
    <div ref={box} className="pop no-print" role="dialog" aria-label="Link" style={place(at)}>
      <div className="caption">Link</div>
      <input
        ref={field}
        className="pop-input"
        value={value}
        placeholder="Paste or type an address"
        aria-label="Link address"
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          setRefused(false);
        }}
        onKeyDown={onKeyDown}
      />
      <div className={`pop-note${refused ? " warn" : ""}`}>
        {refused ? "That address is not supported. Use http, https or mailto." : "Enter applies it. An empty field removes the link."}
      </div>
    </div>
  );
}

const OPTIONS: { name: string; value: string | null }[] = [...TEXT_COLORS, { name: "Default", value: null }];

/** Format ▸ Text color: eight swatches and Default. Arrows move, Enter or a click applies, Esc closes. */
export function ColorPopover({ editor, paper, onClose }: Props) {
  const at = useAnchor(editor, paper);
  const box = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(() => {
    const current = (editor.getAttributes("textStyle").color as string | undefined)?.toLowerCase();
    const found = OPTIONS.findIndex((o) => o.value === current);
    return found < 0 ? OPTIONS.length - 1 : found;
  });

  useDismiss(box, () => box.current?.focus(), onClose);

  const choose = (i: number) => {
    applyColor(editor, OPTIONS[i].value);
    onClose();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const n = OPTIONS.length;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") setIndex((i) => (i + 1) % n);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") setIndex((i) => (i - 1 + n) % n);
    else if (e.key === "Enter") choose(index);
    else if (e.key === "Escape") {
      editor.commands.focus();
      onClose();
    } else return;
    e.preventDefault();
  };

  return (
    <div
      ref={box}
      className="pop no-print"
      role="dialog"
      aria-label="Text color"
      tabIndex={-1}
      style={place(at)}
      onKeyDown={onKeyDown}
      // the swatches are buttons; a mouse-down on them would take the selection from the editor
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="caption">Text color</div>
      <div className="swatches">
        {OPTIONS.slice(0, TEXT_COLORS.length).map((o, i) => (
          <button
            key={o.name}
            className={`swatch${i === index ? " sel" : ""}`}
            style={{ background: o.value ?? undefined }}
            title={o.name}
            aria-label={o.name}
            onClick={() => choose(i)}
            onMouseEnter={() => setIndex(i)}
          />
        ))}
      </div>
      <button
        className={`slash-item${index === OPTIONS.length - 1 ? " sel" : ""}`}
        onClick={() => choose(OPTIONS.length - 1)}
        onMouseEnter={() => setIndex(OPTIONS.length - 1)}
      >
        <span className="tile">A</span>
        <span className="text">
          <span className="label">Default</span>
          <span className="hint">Remove the color</span>
        </span>
      </button>
    </div>
  );
}
