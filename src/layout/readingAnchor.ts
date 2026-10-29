import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";

/** A vertical extent in viewport coordinates. */
export interface Span {
  top: number;
  bottom: number;
}

export type AnchorChoice = { kind: "caret" } | { kind: "block"; index: number } | null;

/**
 * What to hold still while a panel opens or closes: the caret's line when it is fully inside the
 * scroller, else the first block that reaches the scroller's top edge (`blocks` in document order).
 */
export function pickAnchor(view: Span, caret: Span | null, blocks: Span[]): AnchorChoice {
  if (caret && caret.top >= view.top && caret.bottom <= view.bottom) return { kind: "caret" };
  const index = blocks.findIndex((b) => b.bottom > view.top);
  return index < 0 ? null : { kind: "block", index };
}

/** The `scrollTop` that puts the anchor back at the offset (from the scroller's top) it started at. */
export function scrollCorrection(offsetStart: number, offsetNow: number, scrollTop: number): number {
  const drift = offsetNow - offsetStart;
  return Math.abs(drift) < 0.01 ? scrollTop : scrollTop + drift;
}

// A transition that has not ended by then is not waited for.
const SAFETY_MS = 400;
// Frames to wait for the first width/height transition to start; none starting means nothing is animating.
const IDLE_FRAMES = 8;
const PANELS = ".side, .comments-rail, .menubar-slot";

const noop = () => {};

/** Viewport `top` of the anchor, read fresh on every call. */
type Probe = () => number;

function captureAnchor(view: EditorView, scroller: HTMLElement): Probe | null {
  const box = scroller.getBoundingClientRect();
  const head = view.state.selection.head;
  let caret: Span | null = null;
  try {
    const c = view.coordsAtPos(head);
    caret = { top: c.top, bottom: c.bottom };
  } catch {
    // no caret position to hold: a block will do
  }
  const blocks = Array.from(view.dom.children, (el) => el.getBoundingClientRect());
  const choice = pickAnchor(box, caret, blocks);
  if (!choice) return null;
  if (choice.kind === "caret") return () => view.coordsAtPos(head).top;

  // The line at the top of the window inside that block, so a tall block that rewraps does not slide the text.
  const block = view.dom.children[choice.index];
  const r = block.getBoundingClientRect();
  const at = view.posAtCoords({ left: r.left + 2, top: Math.max(box.top, r.top) + 2 });
  if (at && block.contains(view.domAtPos(at.pos).node)) {
    const pos = at.pos;
    return () => view.coordsAtPos(pos).top;
  }
  return () => block.getBoundingClientRect().top;
}

/**
 * While the panels' width/height transitions run, keeps the reading position still: every frame, the
 * scroller's `scrollTop` is moved by however far the anchor drifted from where it was at the start. The page
 * can rewrap during the transition (it narrows beside an open comments rail), and nothing else would hold
 * the text in place (WebKit has no scroll anchoring; Chromium's is switched off here so it cannot add to ours).
 * Ends when the panel transitions have, after a safety timeout, or when the person scrolls, types or resizes.
 * Call it in the commit that starts the transition, before the browser has laid out the new state.
 * Returns the cancel function.
 */
export function startReadingAnchor(editor: Editor, scroller: HTMLElement): () => void {
  if (editor.isDestroyed || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return noop;
  const view = editor.view;
  const probe = captureAnchor(view, scroller);
  if (!probe) return noop;
  const offset = () => probe() - scroller.getBoundingClientRect().top;
  let start: number;
  try {
    start = offset();
  } catch {
    return noop;
  }

  const doc = scroller.ownerDocument;
  const isPanel = (e: TransitionEvent) =>
    (e.propertyName === "width" || e.propertyName === "height") && e.target instanceof Element && !!e.target.closest(PANELS);
  let running = 0;
  let started = false;
  const onRun = (e: TransitionEvent) => {
    if (!isPanel(e)) return;
    running++;
    started = true;
  };
  const onEnd = (e: TransitionEvent) => {
    if (isPanel(e) && running > 0) running--;
  };

  let stopped = false;
  let frames = 0;
  let raf = 0;
  const t0 = performance.now();
  const interruptions: [EventTarget, string][] = [
    [scroller, "wheel"],
    [scroller, "touchmove"],
    [scroller, "pointerdown"],
    [window, "keydown"],
    [window, "resize"],
  ];

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    doc.removeEventListener("transitionrun", onRun as EventListener);
    doc.removeEventListener("transitionend", onEnd as EventListener);
    doc.removeEventListener("transitioncancel", onEnd as EventListener);
    for (const [target, type] of interruptions) target.removeEventListener(type, stop);
    scroller.removeAttribute("data-pinning");
  };

  const frame = () => {
    if (stopped) return;
    // not before this frame: the key press that started the transition is still being dispatched when this is called
    if (++frames === 1) for (const [target, type] of interruptions) target.addEventListener(type, stop, { passive: true });
    try {
      const next = scrollCorrection(start, offset(), scroller.scrollTop);
      if (next !== scroller.scrollTop) scroller.scrollTop = next;
    } catch {
      stop(); // the anchor is gone (the document changed under it)
      return;
    }
    if ((started && running === 0) || (!started && frames > IDLE_FRAMES) || performance.now() - t0 > SAFETY_MS) stop();
    else raf = requestAnimationFrame(frame);
  };

  scroller.setAttribute("data-pinning", "");
  doc.addEventListener("transitionrun", onRun as EventListener);
  doc.addEventListener("transitionend", onEnd as EventListener);
  doc.addEventListener("transitioncancel", onEnd as EventListener);
  raf = requestAnimationFrame(frame);
  return stop;
}
