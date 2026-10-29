import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { findAll, type FindMatch } from "./find";

/**
 * Shows the Find bar's matches in the page: every match gets the class `find-match`, the current one
 * also `find-current`. It only decorates and moves the selection. It never changes the document, so
 * the session does not see an edit and the undo history gets nothing.
 */

export interface FindState {
  query: string;
  caseSensitive: boolean;
  matches: FindMatch[];
  /** Index into `matches` of the match the bar is on, or -1 when there are none. */
  current: number;
  decorations: DecorationSet;
}

/** What the bar tells the plugin, as transaction meta. All of them leave the current match selected and in view. */
export type FindAction =
  /** A new search; the current match is the first one at or after the caret, else the first. */
  | { type: "search"; query: string; caseSensitive: boolean }
  /** Next (1) or previous (-1) match, wrapping around. */
  | { type: "step"; delta: 1 | -1 }
  /** The current match becomes the first one at or after `pos`, else the first: after a replace, the one past the new text. */
  | { type: "from"; pos: number };

export const findKey = new PluginKey<FindState>("docbroFind");

export const findState = (state: EditorState): FindState | undefined => findKey.getState(state);

/** Sends `action` as a transaction of its own; nothing in it touches the document. */
export const runFind = (view: EditorView, action: FindAction) =>
  view.dispatch(view.state.tr.setMeta(findKey, action).setMeta("addToHistory", false));

const indexFrom = (matches: FindMatch[], pos: number) => {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => m.from >= pos);
  return i < 0 ? 0 : i;
};

const decorate = (state: EditorState, matches: FindMatch[], current: number) =>
  DecorationSet.create(
    state.doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? "find-match find-current" : "find-match" })),
  );

const EMPTY: Omit<FindState, "decorations"> = { query: "", caseSensitive: false, matches: [], current: -1 };

export interface FindPluginOptions {
  /** Esc was pressed in the page while the bar is open. */
  onEscape?(): void;
}

export function findPlugin({ onEscape }: FindPluginOptions = {}): Plugin<FindState> {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => ({ ...EMPTY, decorations: DecorationSet.empty }),
      apply(tr, prev, _old, state) {
        const action = tr.getMeta(findKey) as FindAction | undefined;
        if (!action && !tr.docChanged) return prev;

        const { query, caseSensitive } = action?.type === "search" ? action : prev;
        // the matches stay as they are unless the search or the text changed
        const matches = action?.type === "search" || tr.docChanged ? findAll(state.doc, query, { caseSensitive }) : prev.matches;
        let current: number;
        if (action?.type === "search") current = indexFrom(matches, state.selection.from);
        else if (action?.type === "from") current = indexFrom(matches, action.pos);
        else if (action?.type === "step") current = matches.length ? (prev.current + action.delta + matches.length) % matches.length : -1;
        else current = matches.length ? Math.min(Math.max(prev.current, 0), matches.length - 1) : -1; // the text changed under us
        return { query, caseSensitive, matches, current, decorations: decorate(state, matches, current) };
      },
    },
    // Whatever the bar asked for, the current match ends up selected and in view. The bar's field keeps the
    // focus, so this does not move the caret on screen; Esc hands the page the selection.
    appendTransaction(trs, _old, state) {
      if (!trs.some((tr) => tr.getMeta(findKey))) return null;
      const find = findKey.getState(state);
      const match = find?.matches[find.current];
      if (!match) return null;
      const tr = state.tr.scrollIntoView().setMeta("addToHistory", false);
      if (state.selection.from !== match.from || state.selection.to !== match.to) tr.setSelection(TextSelection.create(state.doc, match.from, match.to));
      return tr;
    },
    props: {
      decorations: (state) => findKey.getState(state)?.decorations,
      // keep a match clear of the dock floating over the foot of the page
      scrollMargin: { top: 80, right: 5, bottom: 120, left: 5 },
      handleKeyDown(_view, event) {
        if (event.key !== "Escape" || !onEscape) return false;
        onEscape();
        return true;
      },
    },
  });
}
