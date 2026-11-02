import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { DocLook } from "../doc/meta";
import { createHeadlessEditor } from "../editor/headless";
import { FormatControls } from "./FormatControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let editor: Editor;
let root: Root;
let host: HTMLElement;

const doc = (...content: object[]) => ({ type: "doc", content }) as never;
const para = (...content: object[]) => ({ type: "paragraph", content });
const text = (value: string, attrs?: Record<string, unknown>) =>
  attrs ? { type: "text", text: value, marks: [{ type: "textStyle", attrs }] } : { type: "text", text: value };

const mount = (content: object, look?: DocLook | null) => {
  editor = createHeadlessEditor(content as never);
  editor.mount(host.appendChild(document.createElement("div")));
  root = createRoot(host.appendChild(document.createElement("div")));
  act(() => root.render(<FormatControls editor={editor} look={look} />));
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  host.remove();
  document.body.querySelectorAll(".fmt-list").forEach((el) => el.remove());
});

const face = () => host.querySelector(".fmt-font .name")!.textContent;
const box = () => host.querySelector<HTMLInputElement>(".fmt-size-box")!;
const marked = (key: "fontFamily" | "fontSize") => editor.getJSON().content![0].content![0].marks?.[0]?.attrs?.[key] ?? null;
const select = (from: number, to?: number) => act(() => void editor.commands.setTextSelection(to ? { from, to } : from));
const click = (el: Element | null) => act(() => void (el as HTMLElement).click());
const button = (label: string) => host.querySelector(`[aria-label="${label}"]`)!;
const list = () => document.body.querySelector(".fmt-list");
const rows = () => [...document.body.querySelectorAll(".fmt-list [role=option] .label")].map((e) => e.textContent);
/** What typing into a React input is: the value set the way the browser does, then an input event. */
const type = (value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(box(), value);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
const key = (name: string) => act(() => void box().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));

test("text_with_no_font_or_size_shows_the_pages_own", () => {
  mount(doc(para(text("abc"))));
  expect(face()).toBe("Inter");
  expect(box().value).toBe("11");
});

test("a_document_from_a_file_shows_the_files_typeface_and_size", () => {
  const look = { font: "Arial", size: 24, spacing: {}, headings: [{ size: 40, spacing: {} }, { size: null, spacing: {} }, { size: null, spacing: {} }],
    margins: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 } } as DocLook;
  mount(doc(para(text("abc"))), look);
  expect([face(), box().value]).toEqual(["Arial", "12"]);
});

test("the_selection_decides_what_is_shown_and_a_heading_has_its_own_size", () => {
  mount(doc(para(text("abc", { fontFamily: "Georgia", fontSize: 14 })), { type: "heading", attrs: { level: 1 }, content: [text("Title")] }));
  select(1, 4);
  expect([face(), box().value]).toEqual(["Georgia", "14"]);
  select(7);
  expect([face(), box().value]).toEqual(["Inter", "20"]);
});

test("a_selection_in_two_faces_and_sizes_shows_mixed_and_an_empty_box", () => {
  mount(doc(para(text("aa", { fontFamily: "Georgia", fontSize: 14 }), text("bb", { fontFamily: "Arial", fontSize: 9 }))));
  act(() => void editor.commands.selectAll());
  expect([face(), box().value]).toEqual(["Mixed", ""]);
});

test("plus_and_minus_step_the_selections_size_through_the_list", () => {
  mount(doc(para(text("abc"))));
  editor.commands.selectAll();
  click(button("Increase font size"));
  expect(marked("fontSize")).toBe(12);
  expect(box().value).toBe("12");
  click(button("Decrease font size"));
  click(button("Decrease font size"));
  expect(marked("fontSize")).toBe(10);
});

test("a_size_typed_in_the_box_applies_on_enter_and_a_bad_one_changes_nothing", () => {
  mount(doc(para(text("abc"))));
  editor.commands.selectAll();
  type("17,5");
  key("Enter");
  expect(marked("fontSize")).toBe(17.5);
  type("abc");
  key("Enter");
  expect(marked("fontSize")).toBe(17.5);
  expect(box().value).toBe("17.5");
  type("30");
  key("Escape");
  expect(marked("fontSize")).toBe(17.5);
});

test("the_size_list_sets_a_size_and_default_takes_it_away", () => {
  mount(doc(para(text("abc", { fontSize: 20 }))));
  editor.commands.selectAll();
  click(button("Font sizes"));
  expect(rows().slice(0, 3)).toEqual(["8", "9", "10"]);
  expect(document.body.querySelector("[aria-selected=true] .label")!.textContent).toBe("20");
  click([...document.body.querySelectorAll(".fmt-list .menu-item")].find((b) => b.textContent === "28")!);
  expect(marked("fontSize")).toBe(28);
  expect(list()).toBeNull();
  click(button("Font sizes"));
  click([...document.body.querySelectorAll(".fmt-list .menu-item")].find((b) => b.textContent!.startsWith("Default"))!);
  expect(marked("fontSize")).toBeNull();
});

test("the_font_list_opens_under_the_button_with_the_current_face_ticked_and_a_click_applies_it", () => {
  mount(doc(para(text("abc", { fontFamily: "Verdana" }))));
  editor.commands.selectAll();
  click(button("Font"));
  expect(rows()).toHaveLength(10);
  expect(document.body.querySelector("[aria-selected=true] .label")!.textContent).toBe("Verdana");
  click([...document.body.querySelectorAll(".fmt-list .menu-item")].find((b) => b.textContent!.startsWith("Georgia"))!);
  expect(marked("fontFamily")).toBe("Georgia");
  expect(list()).toBeNull();
  expect(face()).toBe("Georgia");
});

test("default_is_the_one_ticked_while_no_face_is_set", () => {
  mount(doc(para(text("abc"))));
  editor.commands.selectAll();
  click(button("Font"));
  expect(document.body.querySelector("[aria-selected=true] .label")!.textContent).toBe("Default");
});

test("escape_and_a_click_elsewhere_close_a_list", () => {
  mount(doc(para(text("abc"))));
  click(button("Font"));
  expect(list()).not.toBeNull();
  act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(list()).toBeNull();
  click(button("Font"));
  act(() => void document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(list()).toBeNull();
});
