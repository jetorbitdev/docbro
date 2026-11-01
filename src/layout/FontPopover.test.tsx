import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHeadlessEditor } from "../editor/headless";
import { FontPopover } from "./Popovers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let editor: Editor;
let root: Root;
let host: HTMLElement;
const onClose = vi.fn();

const mount = () => {
  const paper = host.appendChild(document.createElement("div"));
  root = createRoot(paper);
  act(() => root.render(<FontPopover editor={editor} paper={paper} onClose={onClose} />));
};

beforeEach(() => {
  onClose.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  editor = createHeadlessEditor({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
  });
  editor.mount(host.appendChild(document.createElement("div")));
  editor.commands.selectAll();
});

afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  host.remove();
});

const labels = () => [...host.querySelectorAll(".font-item span:first-child")].map((e) => e.textContent);
const marks = () => editor.getJSON().content![0].content![0].marks?.[0]?.attrs?.fontFamily ?? null;
const dialog = () => host.querySelector<HTMLElement>("[role=dialog]")!;
const press = (key: string) => act(() => void dialog().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

test("it_lists_the_faces_each_in_itself_and_default_last", () => {
  mount();
  const names = labels();
  expect(names.slice(0, 3)).toEqual(["Inter", "Arial", "Calibri"]);
  expect(names.at(-1)).toBe("Default");
  expect(host.querySelector<HTMLElement>(".font-item:nth-of-type(7)")!.style.fontFamily).toContain("Georgia");
});

test("a_click_sets_the_font_on_the_selection_and_closes", () => {
  mount();
  const georgia = [...host.querySelectorAll<HTMLElement>(".font-item")].find((b) => b.textContent === "Georgia")!;
  act(() => georgia.click());
  expect(marks()).toBe("Georgia");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("arrows_and_enter_choose_and_default_removes_the_font", () => {
  editor.chain().setFontFamily("Verdana").run();
  mount();
  // opens on the face the selection is in, ticked
  expect(host.querySelector(".font-item.sel")!.textContent).toContain("Verdana");
  expect(host.querySelector("[aria-current]")!.textContent).toContain("Verdana");
  press("ArrowDown");
  press("Enter");
  expect(marks()).toBe("Trebuchet MS");

  act(() => root.unmount());
  mount();
  // reopens on Trebuchet MS: Courier New is next to last, Default last
  for (let i = 0; i < 5; i++) press("ArrowDown");
  expect(host.querySelector(".font-item.sel")!.textContent).toBe("Default");
  press("Enter");
  expect(marks()).toBeNull();
});

test("escape_closes_without_changing_anything", () => {
  mount();
  press("Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(marks()).toBeNull();
});

test("a_face_from_a_file_that_is_not_in_the_list_is_shown_first_and_ticked", () => {
  editor.chain().setFontFamily("Garamond").run();
  mount();
  expect(labels()[0]).toBe("Garamond");
  expect(host.querySelector("[aria-current]")!.textContent).toContain("Garamond");
});
