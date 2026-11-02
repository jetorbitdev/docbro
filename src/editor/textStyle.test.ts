import { expect, test } from "vitest";
import { createHeadlessEditor } from "./headless";
import { MIXED, typeStyleAt } from "./textStyle";

const text = (value: string, attrs?: Record<string, unknown>) =>
  attrs ? { type: "text", text: value, marks: [{ type: "textStyle", attrs }] } : { type: "text", text: value };
const editorOf = (...content: object[]) => createHeadlessEditor({ type: "doc", content: [{ type: "paragraph", content }] } as never);

test("a_selection_in_one_face_and_size_reports_them", () => {
  const editor = editorOf(text("abc", { fontFamily: "Georgia", fontSize: 14 }));
  editor.commands.selectAll();
  expect(typeStyleAt(editor.state)).toEqual({ font: "Georgia", size: 14 });
  editor.destroy();
});

test("text_with_no_font_or_size_set_reports_null", () => {
  const editor = editorOf(text("abc"));
  editor.commands.selectAll();
  expect(typeStyleAt(editor.state)).toEqual({ font: null, size: null });
  editor.destroy();
});

test("a_selection_across_two_faces_or_sizes_is_mixed_and_a_part_of_it_is_not", () => {
  const editor = editorOf(text("aa", { fontFamily: "Georgia", fontSize: 14 }), text("bb", { fontFamily: "Arial", fontSize: 14 }), text("cc"));
  editor.commands.selectAll();
  expect(typeStyleAt(editor.state)).toEqual({ font: MIXED, size: MIXED });
  editor.commands.setTextSelection({ from: 1, to: 3 });
  expect(typeStyleAt(editor.state)).toEqual({ font: "Georgia", size: 14 });
  editor.commands.setTextSelection({ from: 3, to: 5 });
  expect(typeStyleAt(editor.state)).toEqual({ font: "Arial", size: 14 });
  editor.destroy();
});

test("a_caret_reports_the_text_it_is_in_and_what_is_typed_next", () => {
  const editor = editorOf(text("abc", { fontSize: 20 }));
  editor.commands.setTextSelection(2);
  expect(typeStyleAt(editor.state).size).toBe(20);
  editor.chain().setMark("textStyle", { fontSize: 9 }).run(); // a stored mark: the next typed text
  expect(typeStyleAt(editor.state).size).toBe(9);
  editor.destroy();
});
