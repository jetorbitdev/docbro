import type { Editor } from "@tiptap/core";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHeadlessEditor } from "../editor/headless";
import { markdownToDoc } from "../formats/markdown";
import { insertAssistantText } from "./insert";

let editor: Editor;

beforeEach(() => {
  // mounted, so it has its undo history
  editor = createHeadlessEditor();
  editor.mount(document.createElement("div"));
});

afterEach(() => editor.destroy());

/** Puts `md` in the editor as content the undo history does not hold, as if a file had just been opened. */
function set(md: string) {
  const node = editor.schema.nodeFromJSON(markdownToDoc(md));
  const { tr } = editor.state;
  editor.view.dispatch(tr.replaceWith(0, tr.doc.content.size, node.content).setMeta("addToHistory", false));
}
const blocks = () => editor.state.doc.content.content.map((n) => `${n.type.name}:${n.textContent}`);
/** The caret inside the n-th top-level block (from 0). */
function caretIn(n: number) {
  let pos = 0;
  for (let i = 0; i < n; i++) pos += editor.state.doc.child(i).nodeSize;
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 2)));
}
const selected = () => editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "|");

test("insert_into_doc_adds_blocks_after_the_selection_as_one_undo_step", () => {
  set("# Title\n\nFirst paragraph.\n\nLast paragraph.");
  caretIn(1);
  insertAssistantText(editor, "## Summary\n\n- one\n- two");
  expect(blocks()).toEqual([
    "heading:Title",
    "paragraph:First paragraph.",
    "heading:Summary",
    "bulletList:onetwo",
    "paragraph:Last paragraph.",
  ]);
  // the new blocks are selected, so the panel can show where they went
  expect(selected()).toBe("Summary|one|two");
  editor.commands.undo();
  expect(blocks()).toEqual(["heading:Title", "paragraph:First paragraph.", "paragraph:Last paragraph."]);
});

test("insert_into_doc_appends_at_the_end_when_nothing_is_selected", () => {
  set("# Title\n\nBody.");
  // all of it selected is no place in particular
  editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
  insertAssistantText(editor, "Added at the end.");
  expect(blocks()).toEqual(["heading:Title", "paragraph:Body.", "paragraph:Added at the end."]);
  expect(selected()).toBe("Added at the end.");
  editor.commands.undo();
  expect(blocks()).toEqual(["heading:Title", "paragraph:Body."]);
});

test("insert_into_an_empty_document_replaces_its_empty_line", () => {
  insertAssistantText(editor, "Hello **there**.");
  expect(blocks()).toEqual(["paragraph:Hello there."]);
});

test("typing_right_after_an_insert_is_its_own_undo_step", () => {
  set("Body.");
  caretIn(0);
  insertAssistantText(editor, "Inserted.");
  editor.commands.insertContent("typed");
  editor.commands.undo();
  expect(blocks()).toEqual(["paragraph:Body.", "paragraph:Inserted."]);
});
