import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useRef } from "react";
import { startReadingAnchor } from "./readingAnchor";

/**
 * Holds the reading position while panels open and close. `panels` names which panels are open (any change of
 * it starts a transition); `snapping` is a window resize, where panels jump instead of animating.
 */
export function useReadingAnchor(editor: Editor, scroller: HTMLElement | null, panels: string, snapping: boolean) {
  const previous = useRef(panels);
  // a layout effect: it runs in the commit that starts the transitions, before the new layout is measured
  useLayoutEffect(() => {
    if (previous.current === panels) return;
    previous.current = panels;
    if (!scroller || snapping) return;
    return startReadingAnchor(editor, scroller);
  }, [panels]);
}
