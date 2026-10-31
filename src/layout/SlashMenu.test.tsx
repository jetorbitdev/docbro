import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHeadlessEditor } from "../editor/headless";
import { slashLine, slashNext, type SlashMenuState } from "./blocks";
import { SlashMenu } from "./SlashMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let editor: Editor;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  editor = createHeadlessEditor();
  editor.mount(host.appendChild(document.createElement("div")));
  const paper = host.appendChild(document.createElement("div"));
  root = createRoot(paper);
  act(() => root.render(<SlashMenu editor={editor} paper={paper} suspended={false} />));
  // the menu opens only while the editor has the focus
  act(() => void editor.view.dom.dispatchEvent(new FocusEvent("focus")));
});

afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  host.remove();
});

const type = (text: string) => act(() => void editor.commands.insertContent(text));
/** Backspace over the last character of the first line. */
const erase = () => editor.chain().deleteRange({ from: editor.state.selection.from - 1, to: editor.state.selection.from }).run();
/** A key through the editor's own handlers, in order, like a real key press. */
const press = (key: string) =>
  act(() => void editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key, cancelable: true }))));
const menu = () => host.querySelector(".slash");
const row = () => host.querySelector(".slash .sel .label")?.textContent;
const rows = () => [...host.querySelectorAll(".slash .label")].map((e) => e.textContent);
const top = <T,>(pick: (n: Node) => T) => {
  const out: T[] = [];
  editor.state.doc.forEach((n) => out.push(pick(n)));
  return out;
};
const lines = () => top((n) => n.textContent);

// ------------------------------------------------------------------ the component

test("a_slash_on_an_empty_line_opens_the_menu_and_a_sentence_does_not", () => {
  type("/");
  expect(rows()).toHaveLength(11);
  expect(row()).toBe("Text");
  type("zz");
  expect(menu()).toBeNull(); // "/zz" matches nothing
});

test("a_slash_in_the_middle_of_a_line_never_opens_it", () => {
  type("see /t");
  expect(menu()).toBeNull();
  type(" and");
  expect(menu()).toBeNull();
});

test("esc_closes_the_menu_and_retyping_the_slash_opens_it_again", () => {
  type("/");
  expect(menu()).not.toBeNull();
  press("Escape");
  expect(menu()).toBeNull();
  expect(lines()).toEqual(["/"]); // Esc leaves the text alone

  act(() => void erase());
  expect(menu()).toBeNull();
  type("/");
  expect(menu()).not.toBeNull();
});

test("esc_then_backspace_and_slash_in_one_go_still_reopens_it", () => {
  type("/");
  press("Escape");
  // two transactions in one React update: the menu state follows the editor, not the renders
  act(() => {
    erase();
    editor.commands.insertContent("/");
  });
  expect(menu()).not.toBeNull();
});

test("esc_stays_closed_for_the_same_text_and_typing_another_character_reopens_it", () => {
  type("/t");
  expect(menu()).not.toBeNull();
  press("Escape");
  expect(menu()).toBeNull();
  // moving the caret within the same command text does not bring it back
  act(() => void editor.commands.setTextSelection(1));
  act(() => void editor.commands.setTextSelection(3));
  expect(menu()).toBeNull();
  type("a");
  expect(rows()).toEqual(["Table"]);
});

test("the_highlighted_row_goes_back_to_the_first_whenever_the_query_changes", () => {
  type("/");
  press("ArrowDown");
  press("ArrowDown");
  press("ArrowDown");
  expect(row()).toBe("Heading 3");
  type("h"); // "/h": Heading 1-3 and Divider
  expect(row()).toBe("Heading 1");
  act(() => void erase()); // back to "/": the row it was left on is not remembered
  expect(row()).toBe("Text");

  press("ArrowUp");
  expect(row()).toBe("Divider"); // wraps
  press("ArrowDown");
  expect(row()).toBe("Text");
  type("h");
  press("ArrowDown");
  expect(row()).toBe("Heading 2");
  type("e"); // "/he": Heading 1-3 again, from the top
  expect(row()).toBe("Heading 1");
});

test("hovering_a_row_highlights_it", () => {
  type("/");
  const quote = [...host.querySelectorAll(".slash-item")].find((b) => b.textContent?.includes("Quote"))!;
  act(() => void quote.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(row()).toBe("Quote");
});

test("enter_picks_the_highlighted_row_and_with_no_match_it_stays_a_newline", () => {
  type("/zz");
  expect(menu()).toBeNull();
  press("Enter");
  expect(lines()).toEqual(["/zz", ""]);

  act(() => void editor.commands.clearContent());
  type("/tab");
  expect(rows()).toEqual(["Table"]);
  press("Enter");
  expect(menu()).toBeNull();
  expect(top((n) => n.type.name)).toEqual(["table", "paragraph"]);
  expect(editor.getText()).not.toContain("/tab");
});

test("enter_after_esc_is_a_newline_too", () => {
  type("/h");
  press("Escape");
  press("Enter");
  expect(lines()).toEqual(["/h", ""]);
});

// ------------------------------------------------------------------ the state it keeps

const line = (query: string, pos = 0) => ({ query, pos, from: pos + 1, to: pos + 1 + query.length + 1 });

test("slash_state_starts_at_the_first_row_and_is_gone_with_the_line", () => {
  expect(slashNext(null, null)).toBeNull();
  expect(slashNext({ pos: 0, query: "", index: 3, dismissed: true }, null)).toBeNull();
  expect(slashNext(null, line(""))).toEqual({ pos: 0, query: "", index: 0, dismissed: false });
});

test("slash_state_moves_wraps_and_clamps", () => {
  const at = (index: number): SlashMenuState => ({ pos: 0, query: "", index, dismissed: false });
  expect(slashNext(at(0), line(""), { type: "move", step: 1 })!.index).toBe(1);
  expect(slashNext(at(10), line(""), { type: "move", step: 1 })!.index).toBe(0);
  expect(slashNext(at(0), line(""), { type: "move", step: -1 })!.index).toBe(10);
  expect(slashNext(at(0), line(""), { type: "hover", index: 4 })!.index).toBe(4);
  expect(slashNext(at(0), line(""), { type: "hover", index: 99 })!.index).toBe(10);
});

test("slash_state_dismisses_only_the_text_it_was_dismissed_for", () => {
  const dismissed = slashNext(slashNext(null, line("t")), line("t"), { type: "dismiss" })!;
  expect(dismissed.dismissed).toBe(true);
  // the same text, the caret moving about: still dismissed
  expect(slashNext(dismissed, line("t"))!.dismissed).toBe(true);
  // another character, another paragraph, or the line gone and back: open again, first row
  expect(slashNext({ ...dismissed, index: 2 }, line("ta"))).toEqual({ pos: 0, query: "ta", index: 0, dismissed: false });
  expect(slashNext({ ...dismissed, index: 2 }, line("t", 40))).toEqual({ pos: 40, query: "t", index: 0, dismissed: false });
  expect(slashNext(slashNext(dismissed, null), line("t"))).toEqual({ pos: 0, query: "t", index: 0, dismissed: false });
});

test("slash_state_has_nothing_to_move_when_no_row_matches", () => {
  const state = slashNext(null, line("zzzz"))!;
  expect(slashNext(state, line("zzzz"), { type: "move", step: 1 })).toEqual(state);
});

test("the_menu_state_reads_the_same_line_the_menu_opens_on", () => {
  type("/h2");
  expect(slashLine(editor.state)).toMatchObject({ query: "h2", pos: 0 });
});
