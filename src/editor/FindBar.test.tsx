import type { Editor, JSONContent } from "@tiptap/core";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FindBar, type FindRequest } from "./FindBar";
import { findState } from "./findPlugin";
import { createHeadlessEditor } from "./headless";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (text: string, bold = false): JSONContent => ({ type: "text", text, ...(bold && { marks: [{ type: "bold" }] }) });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

let editor: Editor;
let root: Root;
let host: HTMLElement;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let ids = 0;

function load(...content: JSONContent[]) {
  editor.commands.setContent({ type: "doc", content });
}
const request = (patch: Partial<FindRequest> = {}): FindRequest => ({ id: ++ids, replace: false, seed: "", ...patch });
const frame = () => act(async () => void (await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))));
const show = async (req: FindRequest = request()) => {
  act(() => root.render(<FindBar editor={editor} request={req} onClose={onClose} />));
  await frame();
};

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  editor = createHeadlessEditor({ type: "doc", content: [p(t("one foo two foo")), p(t("Foo three"))] });
  editor.mount(document.body.appendChild(document.createElement("div")));
  root = createRoot(host);
  onClose = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  editor.view.dom.parentElement?.remove();
  editor.destroy();
  host.remove();
});

const find = () => host.querySelector<HTMLInputElement>('input[aria-label="Find"]')!;
const replaceField = () => host.querySelector<HTMLInputElement>('input[aria-label="Replace with"]');
const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const count = () => host.querySelector(".find-count")?.textContent;
const lit = (cls = ".find-match") => [...editor.view.dom.querySelectorAll(cls)].map((e) => e.textContent);
const text = () => editor.state.doc.textBetween(0, editor.state.doc.content.size, "|", "|");

const typeInto = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const key = (input: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })));
const click = (el: HTMLElement) => act(() => el.click());
const undo = () => {
  let ok = false;
  act(() => void (ok = editor.commands.undo()));
  return ok;
};

test("it_opens_with_a_find_field_that_has_the_focus_and_no_replace_field", async () => {
  await show();
  expect(find()).not.toBeNull();
  expect(document.activeElement).toBe(find());
  expect(replaceField()).toBeNull();
  expect(button("Replace")).toBeNull();
  expect(count()).toBe(""); // nothing typed
  expect(host.querySelector('[role="search"]')).not.toBeNull();
});

test("a_replace_request_adds_the_replace_field_and_its_buttons", async () => {
  await show(request({ replace: true }));
  expect(replaceField()).not.toBeNull();
  expect(button("Replace")).not.toBeNull();
  expect(button("Replace all")).not.toBeNull();
  expect(document.activeElement).toBe(find());
});

test("typing_highlights_the_matches_and_counts_them", async () => {
  await show();
  typeInto(find(), "foo");
  expect(count()).toBe("1 of 3");
  expect(lit()).toEqual(["foo", "foo", "Foo"]);
  expect(lit(".find-current")).toEqual(["foo"]);
  typeInto(find(), "zzz");
  expect(count()).toBe("No results");
  expect(lit()).toEqual([]);
  typeInto(find(), "");
  expect(count()).toBe("");
});

test("enter_goes_to_the_next_match_shift_enter_to_the_previous_and_both_wrap", async () => {
  await show();
  typeInto(find(), "foo");
  key(find(), "Enter");
  expect(count()).toBe("2 of 3");
  key(find(), "Enter");
  expect(count()).toBe("3 of 3");
  key(find(), "Enter");
  expect(count()).toBe("1 of 3");
  key(find(), "Enter", { shiftKey: true });
  expect(count()).toBe("3 of 3");
  key(find(), "Enter", { shiftKey: true });
  expect(count()).toBe("2 of 3");
  // the selection in the page follows
  expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe("foo");
  expect(document.activeElement).toBe(find()); // the field keeps the focus
});

test("the_arrow_buttons_step_too", async () => {
  await show();
  typeInto(find(), "foo");
  click(button("Next match"));
  expect(count()).toBe("2 of 3");
  click(button("Previous match"));
  click(button("Previous match"));
  expect(count()).toBe("3 of 3");
});

test("enter_with_no_match_does_nothing", async () => {
  await show();
  typeInto(find(), "zzz");
  key(find(), "Enter");
  expect(count()).toBe("No results");
  expect(button("Next match").disabled).toBe(true);
  expect(button("Previous match").disabled).toBe(true);
});

test("escape_closes_from_either_field_and_from_a_button", async () => {
  await show(request({ replace: true }));
  key(find(), "Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
  key(replaceField()!, "Escape");
  expect(onClose).toHaveBeenCalledTimes(2);
  typeInto(find(), "foo");
  key(button("Replace all"), "Escape"); // focus is on a button after a click on it
  expect(onClose).toHaveBeenCalledTimes(3);
  key(find(), "Escape", { isComposing: true }); // Esc cancels a composition, not the bar
  expect(onClose).toHaveBeenCalledTimes(3);
  click(button("Close"));
  expect(onClose).toHaveBeenCalledTimes(4);
});

test("the_case_button_makes_the_search_case_sensitive", async () => {
  await show();
  typeInto(find(), "foo");
  expect(button("Match case").getAttribute("aria-pressed")).toBe("false");
  expect(count()).toBe("1 of 3");
  click(button("Match case"));
  expect(button("Match case").getAttribute("aria-pressed")).toBe("true");
  expect(count()).toBe("1 of 2");
  click(button("Match case"));
  expect(count()).toBe("1 of 3");
});

test("the_seed_fills_the_field_and_a_new_request_reseeds_and_refocuses", async () => {
  await show(request({ seed: "three" }));
  expect(find().value).toBe("three");
  expect(count()).toBe("1 of 1");
  find().blur();
  await show(request({ seed: "two" }));
  expect(find().value).toBe("two");
  expect(document.activeElement).toBe(find());
  // a request with nothing selected keeps what is in the field, selected, so typing replaces it
  find().blur();
  await show(request());
  expect(find().value).toBe("two");
  expect(document.activeElement).toBe(find());
  expect([find().selectionStart, find().selectionEnd]).toEqual([0, 3]);
  // and ⌥⌘F on an open bar adds the replace field
  await show(request({ replace: true }));
  expect(replaceField()).not.toBeNull();
});

test("replace_replaces_the_current_match_and_moves_on", async () => {
  await show(request({ replace: true }));
  typeInto(find(), "foo");
  typeInto(replaceField()!, "bar");
  click(button("Replace"));
  expect(text()).toBe("one bar two foo|Foo three");
  expect(count()).toBe("1 of 2");
  click(button("Replace"));
  click(button("Replace"));
  expect(text()).toBe("one bar two bar|bar three");
  expect(count()).toBe("No results");
  expect(button("Replace").disabled).toBe(true);
  expect(button("Replace all").disabled).toBe(true);
  // each replacement is its own step in the history
  expect(undo()).toBe(true);
  expect(text()).toBe("one bar two bar|Foo three");
});

test("replace_never_loops_when_the_replacement_contains_the_query", async () => {
  await show(request({ replace: true }));
  typeInto(find(), "foo");
  typeInto(replaceField()!, "foofoo");
  click(button("Replace"));
  expect(text()).toBe("one foofoo two foo|Foo three");
  // the next match is after the new text, not inside it
  expect(editor.state.selection.from).toBe(16);
  expect(count()).toBe("3 of 4"); // foo, foo (in "foofoo"), foo, Foo
});

test("enter_in_the_replace_field_replaces", async () => {
  await show(request({ replace: true }));
  typeInto(find(), "three");
  typeInto(replaceField()!, "4");
  key(replaceField()!, "Enter");
  expect(text()).toBe("one foo two foo|Foo 4");
});

test("replace_all_replaces_every_match_in_one_undo_step_and_says_how_many", async () => {
  await show(request({ replace: true }));
  typeInto(find(), "foo");
  typeInto(replaceField()!, "x");
  click(button("Replace all"));
  expect(text()).toBe("one x two x|x three");
  expect(count()).toBe("Replaced 3 matches");
  expect(lit()).toEqual([]);
  expect(undo()).toBe(true);
  expect(text()).toBe("one foo two foo|Foo three");
  expect(editor.can().undo()).toBe(false);
  // the notice goes when the search changes
  typeInto(find(), "one");
  expect(count()).toBe("1 of 1");
});

test("replace_all_of_one_match_says_match_and_an_empty_replacement_deletes", async () => {
  await show(request({ replace: true }));
  typeInto(find(), "three");
  click(button("Replace all"));
  expect(text()).toBe("one foo two foo|Foo ");
  expect(count()).toBe("Replaced 1 match");
});

test("replace_all_respects_the_case_button", async () => {
  await show(request({ replace: true }));
  typeInto(find(), "foo");
  click(button("Match case"));
  typeInto(replaceField()!, "bar");
  click(button("Replace all"));
  expect(text()).toBe("one bar two bar|Foo three");
});

test("the_edits_the_bar_makes_are_kept_in_the_marks_of_the_text", async () => {
  load(p(t("a "), t("cat", true), t(" b")));
  await show(request({ replace: true }));
  typeInto(find(), "cat");
  typeInto(replaceField()!, "dog");
  click(button("Replace all"));
  expect(editor.getJSON().content![0].content).toEqual([
    { type: "text", text: "a " },
    { type: "text", text: "dog", marks: [{ type: "bold" }] },
    { type: "text", text: " b" },
  ]);
});

test("closing_the_bar_removes_the_highlights_and_the_plugin", async () => {
  await show();
  typeInto(find(), "foo");
  expect(lit()).toHaveLength(3);
  act(() => root.render(null));
  expect(lit()).toEqual([]);
  expect(findState(editor.state)).toBeUndefined();
  // and it can open again
  await show();
  typeInto(find(), "foo");
  expect(lit()).toHaveLength(3);
});

test("esc_in_the_page_closes_the_bar", async () => {
  await show();
  const press = () =>
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  expect(press()).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("the_bar_edits_nothing_by_itself", async () => {
  const before = editor.state.doc;
  await show(request({ replace: true, seed: "foo" }));
  typeInto(find(), "one");
  key(find(), "Enter");
  click(button("Match case"));
  typeInto(replaceField()!, "zzz");
  expect(editor.state.doc).toBe(before);
});

test("a_composing_enter_does_not_step", async () => {
  await show();
  typeInto(find(), "foo");
  key(find(), "Enter", { isComposing: true });
  expect(count()).toBe("1 of 3");
});

test("it_works_under_strict_mode_where_effects_run_twice", async () => {
  act(() => root.render(<StrictMode><FindBar editor={editor} request={request({ seed: "foo" })} onClose={onClose} /></StrictMode>));
  await frame();
  expect(count()).toBe("1 of 3");
  expect(lit()).toEqual(["foo", "foo", "Foo"]);
  expect(document.activeElement).toBe(find());
  key(find(), "Enter");
  expect(count()).toBe("2 of 3");
  act(() => root.render(null));
  expect(findState(editor.state)).toBeUndefined();
});
