import { expect, test } from "vitest";
import { createHeadlessEditor } from "./headless";
import { baseSize, firstFamily, fontName, fontOptions, fontStack, formatSize, sameFont, sizeOf, sizeStyle, stepSize, validSize } from "./fonts";

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

// ------------------------------------------------------------------ sizes

test("a_size_is_a_number_of_points_in_range_to_the_half_point", () => {
  expect(validSize(12)).toBe(12);
  expect(validSize("10,5")).toBe(10.5);
  expect(validSize(" 11.3 ")).toBe(11.5);
  for (const bad of [0, 0.4, 401, "", "abc", "12pt", NaN, null, undefined]) expect(validSize(bad)).toBeNull();
});

test("a_size_is_drawn_as_that_many_of_the_pages_points", () => {
  expect(sizeStyle(12)).toBe("calc(12 * var(--pt, 1.5455px))");
});

test("a_css_size_comes_back_in_points_and_the_browsers_own_16px_is_no_choice", () => {
  expect(sizeOf("14pt")).toBe(14);
  expect(sizeOf("11.0pt")).toBe(11);
  expect(sizeOf("20px")).toBe(15);
  expect(sizeOf(sizeStyle(18))).toBe(18);
  for (const none of ["16px", "1.2em", "120%", "large", "", "0pt"]) expect(sizeOf(none)).toBeNull();
});

test("minus_and_plus_step_through_the_list_from_any_size", () => {
  expect(stepSize(11, 1)).toBe(12);
  expect(stepSize(11, -1)).toBe(10);
  expect(stepSize(10.5, 1)).toBe(11);
  expect(stepSize(10.5, -1)).toBe(10);
  expect(stepSize(8, -1)).toBe(8);
  expect(stepSize(72, 1)).toBe(72);
  expect(stepSize(100, -1)).toBe(72);
});

test("a_size_for_the_box_has_no_trailing_zero", () => {
  expect(formatSize(12)).toBe("12");
  expect(formatSize(10.5)).toBe("10.5");
});

test("text_has_the_size_the_page_gives_it_where_none_is_set", () => {
  // DocBro's own page, as it is written to a .docx
  expect([null, 1, 2, 3].map((level) => baseSize(level)).join()).toBe("11,20,16,13");
  const look = { font: "Arial", size: 24, spacing: {}, headings: [{ size: 40, spacing: {} }, { size: null, spacing: {} }, { size: null, spacing: {} }],
    margins: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 } };
  expect(baseSize(null, look)).toBe(12);
  expect(baseSize(1, look)).toBe(20);
  expect(baseSize(2, look)).toBe(18); // the page draws it at 1.5em
});

test("the_font_list_puts_a_face_from_a_file_first_and_default_last", () => {
  expect(fontOptions(null)[0]).toBe("Inter");
  expect(fontOptions(null).at(-1)).toBeNull();
  expect(fontOptions("georgia")).toEqual(fontOptions(null));
  expect(fontOptions("Garamond").slice(0, 2)).toEqual(["Garamond", "Inter"]);
  expect(sameFont("Georgia", "georgia")).toBe(true);
  expect(sameFont(null, null)).toBe(false);
});

test("a_size_set_on_the_selection_is_a_text_style_mark_drawn_in_the_pages_points", () => {
  const editor = createHeadlessEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] });
  editor.chain().selectAll().setMark("textStyle", { fontSize: 14 }).run();
  expect(editor.getJSON().content![0].content![0].marks).toEqual([{ type: "textStyle", attrs: expect.objectContaining({ fontSize: 14 }) }]);
  expect(editor.getHTML()).toContain("font-size: calc(14 * var(--pt, 1.5455px))");
  editor.chain().selectAll().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run();
  expect(editor.getJSON().content![0].content![0].marks).toBeUndefined();
  editor.destroy();
});

test("pasted_text_brings_its_size_in_points_but_not_the_browsers_default", () => {
  const editor = createHeadlessEditor("<p><span style=\"font-size: 14pt\">word</span> <span style=\"font-size: 16px\">web</span></p>" as never);
  const sizes = editor.getJSON().content![0].content!.map((n) => n.marks?.[0]?.attrs?.fontSize ?? null);
  expect(sizes[0]).toBe(14);
  expect(sizes.slice(1).every((s) => s === null)).toBe(true);
  editor.destroy();
});
