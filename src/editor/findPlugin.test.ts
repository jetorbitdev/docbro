import type { Editor, JSONContent } from "@tiptap/core";
import { afterEach, expect, test, vi } from "vitest";
import { DocSession, type SessionIO } from "../doc/session";
import { replaceAll, replaceOne } from "./find";
import { findKey, findPlugin, findState, runFind } from "./findPlugin";
import { createHeadlessEditor } from "./headless";

const t = (text: string, bold = false): JSONContent => ({ type: "text", text, ...(bold && { marks: [{ type: "bold" }] }) });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

let editors: Editor[] = [];
function make(...content: JSONContent[]): Editor {
  const editor = createHeadlessEditor({ type: "doc", content });
  editor.mount(document.body.appendChild(document.createElement("div")));
  editor.registerPlugin(findPlugin());
  editors.push(editor);
  return editor;
}
afterEach(() => {
  editors.forEach((e) => (e.view.dom.parentElement?.remove(), e.destroy()));
  editors = [];
});

const search = (editor: Editor, query: string, caseSensitive = false) => runFind(editor.view, { type: "search", query, caseSensitive });
const step = (editor: Editor, delta: 1 | -1) => runFind(editor.view, { type: "step", delta });
const state = (editor: Editor) => findState(editor.state)!;
const lit = (editor: Editor, cls = ".find-match") => [...editor.view.dom.querySelectorAll(cls)].map((e) => e.textContent);
const selected = (editor: Editor) => {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to);
};

test("a_search_marks_every_match_and_the_current_one", () => {
  const editor = make(p(t("one foo two foo")), p(t("Foo three")));
  search(editor, "foo");
  expect(state(editor).matches).toHaveLength(3);
  expect(lit(editor)).toEqual(["foo", "foo", "Foo"]);
  expect(lit(editor, ".find-current")).toEqual(["foo"]);
  expect(editor.view.dom.querySelectorAll(".find-match.find-current")).toHaveLength(1); // the current one is also a match
  expect(state(editor).current).toBe(0);
});

test("the_first_match_at_or_after_the_caret_is_current", () => {
  const editor = make(p(t("foo and foo and foo")));
  editor.commands.setTextSelection(9); // at the start of the second "foo"
  search(editor, "foo");
  expect(state(editor).current).toBe(1);
  editor.commands.setTextSelection(18);
  search(editor, "foo");
  expect(state(editor).current).toBe(0); // none after the caret: wrap to the first
});

test("stepping_moves_the_current_match_wraps_and_selects_it", () => {
  const editor = make(p(t("foo")), p(t("a foo")), p(t("foo b")));
  search(editor, "foo");
  expect(state(editor).current).toBe(0);
  expect(selected(editor)).toBe("foo");
  expect(editor.state.selection.from).toBe(1);
  step(editor, 1);
  expect(state(editor).current).toBe(1);
  expect(editor.state.selection.from).toBe(8);
  step(editor, 1);
  step(editor, 1);
  expect(state(editor).current).toBe(0); // wrapped
  step(editor, -1);
  expect(state(editor).current).toBe(2); // wrapped back
  expect(selected(editor)).toBe("foo");
  expect(editor.state.selection.from).toBe(13);
  expect(lit(editor, ".find-current")).toHaveLength(1);
});

test("with_no_match_there_is_no_current_and_stepping_does_nothing", () => {
  const editor = make(p(t("hello")));
  search(editor, "zzz");
  expect(state(editor)).toMatchObject({ matches: [], current: -1 });
  step(editor, 1);
  step(editor, -1);
  expect(state(editor).current).toBe(-1);
  expect(lit(editor)).toEqual([]);
  search(editor, "");
  expect(state(editor)).toMatchObject({ query: "", matches: [], current: -1 });
});

test("case_matters_only_when_asked", () => {
  const editor = make(p(t("Foo foo FOO")));
  search(editor, "foo");
  expect(state(editor).matches).toHaveLength(3);
  search(editor, "foo", true);
  expect(state(editor).matches).toEqual([{ from: 5, to: 8 }]);
  expect(lit(editor)).toEqual(["foo"]);
});

test("a_match_across_a_mark_boundary_is_one_match_drawn_in_two_pieces", () => {
  const editor = make(p(t("he"), t("llo", true), t(" hello")));
  search(editor, "hello");
  expect(state(editor).matches).toHaveLength(2);
  expect(lit(editor)).toEqual(["he", "llo", "hello"]);
  expect(lit(editor, ".find-current")).toEqual(["he", "llo"]);
});

test("the_matches_follow_edits_to_the_document", () => {
  const editor = make(p(t("foo")), p());
  search(editor, "foo");
  expect(state(editor).matches).toHaveLength(1);
  editor.commands.insertContentAt(6, "a foo foo"); // into the empty second paragraph
  expect(state(editor).matches).toHaveLength(3);
  expect(lit(editor)).toEqual(["foo", "foo", "foo"]);
  editor.commands.deleteRange({ from: 1, to: 4 });
  expect(state(editor).matches).toHaveLength(2);
  expect(state(editor).current).toBeLessThan(2);
  expect(lit(editor, ".find-current")).toHaveLength(1);
  // an edit that removes the last match leaves nothing to show
  editor.commands.setContent("<p>zz</p>");
  expect(state(editor)).toMatchObject({ matches: [], current: -1 });
  expect(lit(editor)).toEqual([]);
});

test("searching_never_changes_the_document_the_history_or_the_session", () => {
  const io: SessionIO = { read: vi.fn(), write: vi.fn(), exists: vi.fn(), meta: vi.fn() };
  const editor = make(p(t("foo foo")), p(t("foo")));
  const session = new DocSession(editor, io);
  const changed = vi.fn();
  session.onChange(changed);
  const before = editor.state.doc;
  const docChanges: boolean[] = [];
  editor.on("transaction", ({ transaction, appendedTransactions }) =>
    docChanges.push(...[transaction, ...appendedTransactions].map((tr) => tr.docChanged)),
  );

  search(editor, "foo");
  step(editor, 1);
  step(editor, -1);
  search(editor, "FOO", true);
  search(editor, "foo");
  runFind(editor.view, { type: "from", pos: 5 });

  expect(docChanges.length).toBeGreaterThan(5);
  expect(docChanges.every((changed) => !changed)).toBe(true);
  expect(editor.state.doc).toBe(before); // the very same document
  expect(session.dirty).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  expect(io.meta).not.toHaveBeenCalled();
  expect(editor.can().undo()).toBe(false); // nothing to undo
  session.destroy();
});

test("a_replace_with_a_follow_up_goes_to_the_next_match_after_the_new_text", () => {
  const editor = make(p(t("a a a")));
  search(editor, "a");
  expect(state(editor).matches).toHaveLength(3);
  const first = state(editor).matches[0];
  const tr = replaceOne(editor.state, first, "aa");
  tr.setMeta(findKey, { type: "from", pos: tr.mapping.map(first.to, 1) });
  editor.view.dispatch(tr);
  // "aa a a": the two new letters are matches, the next one to show is after them
  expect(editor.state.doc.textContent).toBe("aa a a");
  expect(state(editor).matches).toHaveLength(4);
  expect(state(editor).matches[state(editor).current]).toEqual({ from: 4, to: 5 });
  expect(selected(editor)).toBe("a");
  expect(editor.state.selection.from).toBe(4);
  // one undo takes the replacement back
  editor.commands.undo();
  expect(editor.state.doc.textContent).toBe("a a a");
  expect(state(editor).matches).toHaveLength(3);
});

test("replace_from_the_last_match_wraps_to_the_first", () => {
  const editor = make(p(t("a b a")));
  search(editor, "a");
  const last = state(editor).matches[1];
  const tr = replaceOne(editor.state, last, "c");
  tr.setMeta(findKey, { type: "from", pos: tr.mapping.map(last.to, 1) });
  editor.view.dispatch(tr);
  expect(state(editor).matches).toEqual([{ from: 1, to: 2 }]);
  expect(state(editor).current).toBe(0);
});

test("replace_all_leaves_the_highlights_to_whatever_still_matches", () => {
  const editor = make(p(t("foo foo")));
  search(editor, "foo");
  editor.view.dispatch(replaceAll(editor.state, "foo", "bar")!);
  expect(state(editor).matches).toEqual([]);
  expect(lit(editor)).toEqual([]);
  expect(findState(editor.state)!.query).toBe("foo"); // the field still says foo
});

test("removing_the_plugin_removes_the_highlights", () => {
  const editor = make(p(t("foo")));
  search(editor, "foo");
  expect(lit(editor)).toEqual(["foo"]);
  editor.unregisterPlugin(findKey);
  expect(findState(editor.state)).toBeUndefined();
  expect(lit(editor)).toEqual([]);
});

test("escape_in_the_editor_asks_to_close_the_bar_and_other_keys_do_not", () => {
  const onEscape = vi.fn();
  const editor = make(p(t("foo")));
  editor.unregisterPlugin(findKey);
  editor.registerPlugin(findPlugin({ onEscape }));
  const press = (key: string) =>
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key, cancelable: true })));
  expect(press("a")).toBeFalsy();
  expect(onEscape).not.toHaveBeenCalled();
  expect(press("Escape")).toBe(true);
  expect(onEscape).toHaveBeenCalledOnce();
});

test("each_search_and_step_scrolls_the_current_match_into_view_and_a_plain_edit_does_not", () => {
  // The page's own scroll-to-selection needs the page to have the focus, and the bar's field has it.
  const scrolled: (string | null)[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.textContent + (this.classList.contains("find-current") ? " (current)" : ""));
  };
  try {
    const editor = make(p(t("foo and Foo")), p(t("a foo")));
    search(editor, "foo");
    expect(scrolled).toEqual(["foo (current)"]);
    step(editor, 1);
    expect(scrolled).toEqual(["foo (current)", "Foo (current)"]);
    runFind(editor.view, { type: "from", pos: 1 });
    expect(scrolled).toHaveLength(3);
    editor.commands.insertContentAt(2, "x"); // an edit by the person typing
    editor.commands.setTextSelection(3);
    expect(scrolled).toHaveLength(3);
    search(editor, "zzz"); // nothing to show
    expect(scrolled).toHaveLength(3);
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});
