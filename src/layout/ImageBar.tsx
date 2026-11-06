import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { MIN_PICTURE, pictureInfo, selectedPicture, textWidth, type Align, type PictureLayout } from "../editor/pictureTools";

interface Props {
  editor: Editor;
  /** The page the bar sits on. */
  paper: HTMLElement | null;
  /** The element the page scrolls in: the bar stays in sight while the picture is, and goes with it. */
  scroller: HTMLElement | null;
  /** The command palette or settings are open. */
  suspended: boolean;
}

const BAR_HEIGHT = 40;
const SHARES = [0.25, 0.5, 0.75, 1];

/** The selected picture, as the browser draws it. */
function pictureElement(editor: Editor): HTMLImageElement | null {
  try {
    const found = selectedPicture(editor.state);
    const dom = found ? editor.view.nodeDOM(found.pos) : null;
    return dom instanceof HTMLImageElement ? dom : null;
  } catch {
    return null;
  }
}

/**
 * Brings the selected picture back into view once the page has laid itself out again. A change can move it to another
 * page (a cover has a page of its own, and a picture made bigger may no longer fit where it was), and the bar goes with
 * the picture: without this it would be left behind off screen.
 */
function reveal(editor: Editor, block: "start" | "nearest") {
  requestAnimationFrame(() => requestAnimationFrame(() => pictureElement(editor)?.scrollIntoView?.({ block })));
}

/** The scale the page draws its px at (layout/look.ts). */
function lookScale(editor: Editor): number {
  try {
    return parseFloat(getComputedStyle(editor.view.dom).getPropertyValue("--look-scale")) || 1;
  } catch {
    return 1;
  }
}

interface Box {
  /** Where the bar's lower edge is, in px from the top of the page. */
  y: number;
  /** The corner of the picture the size is dragged by, in px from the page's top left. */
  handle: { x: number; y: number };
  /** The width (px) the picture is drawn at, as a width is kept. */
  shown: number;
}

/** A width box: Enter or leaving the box sets it. */
function WidthBox({ value, disabled, onSet }: { value: number; disabled: boolean; onSet(px: number): void }) {
  const commit = (input: HTMLInputElement) => {
    const px = Number(input.value.trim());
    if (!(px > 0)) return void (input.value = String(value));
    if (px !== value) onSet(px);
  };
  return (
    <label className="tbar-size" title="Width">
      W
      {/* remounted when the value changes under it, so a new picture or a drag shows its own width */}
      <input
        key={value}
        type="number"
        inputMode="numeric"
        min={MIN_PICTURE}
        step={4}
        defaultValue={value}
        disabled={disabled}
        aria-label="Width"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget);
          } else if (e.key === "Escape") {
            e.currentTarget.value = String(value);
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
 * The tools of the picture that is selected, over its top edge: how it lies with the text (in line, with the text
 * wrapped beside it, a cover page), where it sits, and how big it is, typed, as a share of the text, or dragged by
 * the handle on its corner. It stays in sight while any of the picture is.
 */
export function ImageBar({ editor, paper, scroller, suspended }: Props) {
  const info = useEditorState({ editor, selector: ({ editor }) => pictureInfo(editor) });
  const [box, setBox] = useState<Box | null>(null);
  const active = !!info && !suspended;

  useLayoutEffect(() => {
    if (!active || !paper) {
      setBox(null);
      return;
    }
    const place = () => {
      const image = pictureElement(editor);
      if (!image) return setBox(null);
      const t = image.getBoundingClientRect();
      const view = scroller?.getBoundingClientRect();
      const page = paper.getBoundingClientRect();
      // its lower edge just above the picture; held at the top of the scroll area while the picture runs past it, and gone with it
      const edge = view ? Math.max(t.top - 6, Math.min(view.top + 8 + BAR_HEIGHT, t.bottom)) : t.top - 6;
      const gone = !!view && (t.bottom < view.top + BAR_HEIGHT || t.top > view.bottom);
      const next: Box = {
        y: Math.round(edge - page.top),
        // a picture set at the right grows to the left, so it is dragged by its lower left corner
        handle: { x: Math.round((info?.align === "right" ? t.left : t.right) - page.left), y: Math.round(t.bottom - page.top) },
        shown: Math.max(1, Math.round(image.offsetWidth / lookScale(editor))),
      };
      setBox(gone ? null : (prev) => (prev && prev.y === next.y && prev.handle.x === next.handle.x && prev.handle.y === next.handle.y && prev.shown === next.shown ? prev : next));
    };
    place();
    scroller?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    // the picture grows and shrinks as it is sized, loaded and as the page rewraps
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    const image = pictureElement(editor);
    if (image) resize?.observe(image);
    return () => {
      scroller?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      resize?.disconnect();
    };
  }, [editor, paper, scroller, active, info?.width, info?.align, info?.wrap, info?.cover]);

  const drag = useRef<{ image: HTMLImageElement; style: string; local: number; rect: DOMRect; width: number } | null>(null);

  if (!info || !box) return null;

  // the drag is worked out as a change of the picture's width on screen, so it holds at any zoom of the page
  const onDown = (e: PointerEvent<HTMLElement>) => {
    const image = pictureElement(editor);
    if (!image || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const rect = image.getBoundingClientRect();
    drag.current = { image, style: image.style.width, local: image.offsetWidth, rect, width: 0 };
  };
  const onMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !d.rect.width) return;
    // the edge that stays put is the other side of the handle; a centered picture grows to both sides
    const visible =
      info.align === "right" ? d.rect.right - e.clientX
      : info.align === "center" ? 2 * (e.clientX - (d.rect.left + d.rect.width / 2))
      : e.clientX - d.rect.left;
    const scale = lookScale(editor);
    const local = Math.min(textWidth(editor) * scale, Math.max(MIN_PICTURE * scale, (d.local * visible) / d.rect.width));
    d.width = Math.round(local / scale);
    d.image.style.width = `${local}px`;
  };
  const onUp = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!d) return;
    d.image.style.width = d.style;
    if (d.width && e.type === "pointerup") {
      editor.chain().setPictureWidth(d.width).run();
      reveal(editor, "nearest");
    }
  };

  // every change the bar makes keeps the picture in view
  const change = (run: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>, block: "start" | "nearest" = "nearest") => {
    run(editor.chain()).run();
    reveal(editor, block);
  };
  const layout = (id: PictureLayout, label: string, title: string, on: boolean) => (
    <button
      className={`text${on ? " on" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={() => change((c) => c.setPictureLayout(id), id === "cover" ? "start" : "nearest")}
    >
      {label}
    </button>
  );
  const position = (id: Align, glyph: string, title: string, disabled = false) => (
    <button
      className={!info.cover && info.align === id ? "on" : ""}
      title={title}
      aria-label={title}
      aria-pressed={!info.cover && info.align === id}
      disabled={info.cover || disabled}
      onClick={() => change((c) => c.setPictureAlign(id))}
    >
      <span className="glyph">{glyph}</span>
    </button>
  );
  const fitted = (share: number) => !info.cover && Math.abs(box.shown - share * textWidth(editor)) <= 1;

  return (
    <>
      <div
        className="tablebar imagebar no-print"
        role="toolbar"
        aria-label="Image"
        style={{ top: box.y }}
        // a mouse-down on a button would take the selection from the picture; the width box needs the caret
        onMouseDown={(e) => {
          if (!(e.target as Element).closest("input")) e.preventDefault();
        }}
      >
        <div className="tbar-group">
          {layout("inline", "In line", "In line with the text", !info.cover && !info.wrap)}
          {layout("wrap", "Wrap", "Wrap the text around the image", info.wrap)}
          {layout("cover", "Cover", "A page of its own, edge to edge", info.cover)}
          <span className="tbar-label">Layout</span>
        </div>
        <span className="sep" />
        <div className="tbar-group">
          {position("left", "⇤", "Align left")}
          {position("center", "↔", "Align center", info.wrap)}
          {position("right", "⇥", "Align right")}
          <span className="tbar-label">Position</span>
        </div>
        <span className="sep" />
        <div className="tbar-group">
          <WidthBox value={box.shown} disabled={info.cover} onSet={(px) => change((c) => c.setPictureWidth(px))} />
          {SHARES.map((share) => (
            <button
              key={share}
              className={`share${fitted(share) ? " on" : ""}`}
              title={`${share * 100}% of the text width`}
              aria-label={`${share * 100}% of the text width`}
              disabled={info.cover}
              onClick={() => change((c) => c.fitPicture(share))}
            >
              {share * 100}%
            </button>
          ))}
          <button
            className="share"
            title="Original size"
            aria-label="Original size"
            disabled={info.cover || info.width === null}
            onClick={() => change((c) => c.setPictureWidth(null))}
          >
            <span className="glyph">↺</span>
          </button>
        </div>
      </div>
      {!info.cover && (
        <span
          className={`image-handle no-print${info.align === "right" ? " left" : ""}`}
          // pointer only: the width box and the shares beside it do the same from the keyboard
          aria-hidden="true"
          title="Drag to resize"
          style={{ left: box.handle.x, top: box.handle.y }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      )}
    </>
  );
}
