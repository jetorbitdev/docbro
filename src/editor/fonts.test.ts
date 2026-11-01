import { expect, test } from "vitest";
import { createHeadlessEditor } from "./headless";
import { firstFamily, fontName, fontStack } from "./fonts";

test("a_name_is_kept_only_when_it_is_a_face_that_is_safe_to_write_into_css", () => {
  expect(fontName(" Georgia ")).toBe("Georgia");
  expect(fontName("Times New Roman")).toBe("Times New Roman");
  expect(fontName("宋体")).toBe("宋体");
  for (const bad of ["", "   ", "a;b", "x}body{", "'Arial'", "a".repeat(65), 12, null, undefined])
    expect(fontName(bad)).toBeNull();
});

test("a_generic_or_system_family_is_not_a_choice", () => {
  for (const generic of ["serif", "sans-serif", "monospace", "system-ui", "ui-sans-serif", "-apple-system", "BlinkMacSystemFont", "inherit"])
    expect(fontName(generic)).toBeNull();
});

test("the_first_face_of_a_css_list_is_the_one_kept", () => {
  expect(firstFamily("'Georgia', serif")).toBe("Georgia");
  expect(firstFamily('"Times New Roman", Times, serif')).toBe("Times New Roman");
  expect(firstFamily("Arial, Helvetica, sans-serif")).toBe("Arial");
  expect(firstFamily("-apple-system, BlinkMacSystemFont, Segoe UI")).toBeNull();
  expect(firstFamily("")).toBeNull();
});

test("a_known_face_is_drawn_with_its_stack_and_another_with_the_sans_serif_behind_it", () => {
  expect(fontStack("georgia")).toBe("Georgia, 'Times New Roman', serif");
  expect(fontStack("Garamond")).toBe("'Garamond', system-ui, sans-serif");
});

test("a_font_set_on_the_selection_is_a_text_style_mark_drawn_with_its_stack", () => {
  const editor = createHeadlessEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] });
  editor.chain().selectAll().setFontFamily("Georgia").run();
  expect(editor.getJSON().content![0].content![0].marks).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontFamily: "Georgia" }) }]);
  expect(editor.getHTML()).toContain("font-family: Georgia, &quot;Times New Roman&quot;, serif");
  editor.chain().selectAll().unsetFontFamily().run();
  expect(editor.getJSON().content![0].content![0].marks).toBeUndefined();
  editor.destroy();
});

test("a_font_comes_back_from_html_as_its_name_and_a_system_stack_is_dropped", () => {
  const editor = createHeadlessEditor("<p><span style=\"font-family: 'Courier New', monospace\">code</span> " +
    "<span style=\"font-family: -apple-system, system-ui\">plain</span></p>" as never);
  const marks = editor.getJSON().content![0].content!.map((n) => n.marks?.[0]?.attrs?.fontFamily ?? null);
  expect(marks[0]).toBe("Courier New");
  expect(marks.slice(1).every((m) => m === null)).toBe(true);
  editor.destroy();
});
