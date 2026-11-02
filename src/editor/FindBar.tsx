import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { replaceAll, replaceOne } from "./find";
import { findKey, findPlugin, findState, runFind, type FindAction } from "./findPlugin";

/** One press of ⌘F (`replace` false) or ⌥⌘F; a new `id` each time, so an open bar takes the focus again. */
export interface FindRequest {
  id: number;
  replace: boolean;
  /** The selected text to search for, or "" to keep what the field has. */
  seed: string;
}

interface Props {
  editor: Editor;
  request: FindRequest;
  /** Closes the bar and gives the page its focus back, with the current match selected. */
  onClose(): void;
}

// A mouse-down on a button would take the focus from the field, and typing on would stop.
const keepFocus = (e: MouseEvent) => e.preventDefault();

/**
 * Edit ▸ Find… and Find and replace…, under the menu bar and laid out like the palette's input row
 * (mock 335–339). Enter and ⇧Enter step through the matches, Esc closes. The matches are drawn in the
 * page by `findPlugin`, which lives only while this bar is mounted.
 */
export function FindBar({ editor, request, onClose }: Props) {
  const [query, setQuery] = useState(request.seed);
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(request.replace);
  const [notice, setNotice] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  const { synced, count, current } = useEditorState({
    editor,
    selector: ({ editor }) => {
      const s = findState(editor.state);
      return {
        // false for the moment between a keystroke and the plugin hearing of it
        synced: !!s && s.query === query && s.caseSensitive === caseSensitive,
        count: s?.matches.length ?? 0,
        current: s?.current ?? -1,
      };
    },
  });

  useEffect(() => {
    editor.registerPlugin(findPlugin({ onEscape: () => close.current() }));
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(findKey);
    };
  }, [editor]);

  useEffect(() => {
    runFind(editor.view, { type: "search", query, caseSensitive });
  }, [editor, query, caseSensitive]);

  // Each request takes the focus, in a frame of its own: the palette hands the page its focus back
  // in one, and this must come after it.
  useEffect(() => {
    if (request.seed) setQuery(request.seed);
    if (request.replace) setShowReplace(true);
    setNotice(null);
    const frame = requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [request]);

  const step = (delta: 1 | -1) => {
    setNotice(null);
    runFind(editor.view, { type: "step", delta });
  };

  const replaceCurrent = () => {
    const found = findState(editor.state);
    const match = found?.matches[found.current];
    if (!match) return;
    const tr = replaceOne(editor.state, match, replacement);
    // on to the first match past the new text, which may itself contain the query
    const next: FindAction = { type: "from", pos: tr.mapping.map(match.to, 1) };
    editor.view.dispatch(tr.setMeta(findKey, next));
    setNotice(null);
  };

  const replaceEverything = () => {
    const n = findState(editor.state)?.matches.length ?? 0;
    const tr = replaceAll(editor.state, query, replacement, { caseSensitive });
    if (!tr) return;
    editor.view.dispatch(tr);
    setNotice(`Replaced ${n} ${n === 1 ? "match" : "matches"}`);
  };

  // WKWebView sends the Enter that commits a composition with isComposing already false, but keyCode 229
  const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

  const onFindKey = (e: KeyboardEvent) => {
    if (composing(e)) return;
    if (e.key !== "Enter") return;
    step(e.shiftKey ? -1 : 1);
    e.preventDefault();
  };

  const onReplaceKey = (e: KeyboardEvent) => {
    if (composing(e)) return;
    if (e.key !== "Enter") return;
    replaceCurrent();
    e.preventDefault();
  };

  // Esc closes the bar from any of its fields and buttons
  const onBarKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
    onClose();
    e.preventDefault();
  };

  let status = "";
  if (notice) status = notice;
  else if (query && synced) status = count ? `${current + 1} of ${count}` : "No results";

  return (
    <div className="findbar no-print" role="search" aria-label="Find in document" onKeyDown={onBarKey}>
      <div className="find-row">
        <span className="glyph" aria-hidden="true">
          ⌕
        </span>
        <input
          ref={field}
          className="find-input"
          value={query}
          placeholder="Find in document"
          aria-label="Find"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setNotice(null);
          }}
          onKeyDown={onFindKey}
        />
        <span className="find-count" aria-live="polite">
          {status}
        </span>
        <div className="find-tools">
          <button className="find-btn" aria-label="Previous match" title="Previous match (⇧Enter)" disabled={!count} onMouseDown={keepFocus} onClick={() => step(-1)}>
            ↑
          </button>
          <button className="find-btn" aria-label="Next match" title="Next match (Enter)" disabled={!count} onMouseDown={keepFocus} onClick={() => step(1)}>
            ↓
          </button>
          <button
            className={`find-btn case${caseSensitive ? " on" : ""}`}
            aria-label="Match case"
            aria-pressed={caseSensitive}
            title="Match case"
            onMouseDown={keepFocus}
            onClick={() => {
              setCaseSensitive(!caseSensitive);
              setNotice(null);
            }}
          >
            Aa
          </button>
          <button className="find-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      {showReplace && (
        <div className="find-row">
          <span className="glyph" aria-hidden="true">
            ⇄
          </span>
          <input
            className="find-input"
            value={replacement}
            placeholder="Replace with"
            aria-label="Replace with"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={onReplaceKey}
          />
          <div className="find-tools">
            <button className="find-text-btn" aria-label="Replace" disabled={!count} onClick={replaceCurrent}>
              Replace
            </button>
            <button className="find-text-btn" aria-label="Replace all" disabled={!count} onClick={replaceEverything}>
              Replace all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
