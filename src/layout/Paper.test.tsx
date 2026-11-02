import type { Editor, JSONContent } from "@tiptap/core";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHeadlessEditor } from "../editor/headless";
import { Paper } from "./Paper";
import type { PageLayout } from "./pages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let editor: Editor;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  editor = createHeadlessEditor();
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  host.remove();
});

const LAYOUT: PageLayout = { pages: 3, pageHeight: 1000, gap: 20, padTop: 50, padBottom: 50 };
const show = (layout: PageLayout | null, parts: Partial<ComponentProps<typeof Paper>> = {}) =>
  act(() => root.render(<Paper editor={editor} large={false} layout={layout} {...parts} />));
const paper = () => host.querySelector<HTMLElement>(".paper")!;
const sheets = () => [...host.querySelectorAll<HTMLElement>(".sheet")];

test("each_page_is_a_sheet_behind_the_text_one_page_height_and_a_gap_apart", () => {
  show(LAYOUT);
  expect(paper().classList.contains("paged")).toBe(true);
  expect(sheets().map((s) => [s.style.top, s.style.height])).toEqual([["0px", "1000px"], ["1020px", "1000px"], ["2040px", "1000px"]]);
  expect(host.querySelector(".sheets")!.getAttribute("aria-hidden")).toBe("true");
});

test("the_paper_is_always_tall_enough_for_the_last_sheet_and_tells_the_cover_how_tall_a_page_is", () => {
  show(LAYOUT);
  expect(paper().style.minHeight).toBe("3040px"); // 3 x 1000 + 2 x 20
  expect(paper().style.getPropertyValue("--page-h")).toBe("1000px");
});

test("without_a_layout_the_paper_is_the_one_long_sheet_it_always_was", () => {
  show(null);
  expect(paper().classList.contains("paged")).toBe(false);
  expect(sheets()).toHaveLength(0);
  expect(paper().style.minHeight).toBe("");
});

// ---------------------------------------------------------------- a header or footer kept from the file

const para = (text: string, textAlign: string | null = null) => ({ type: "paragraph", attrs: { textAlign }, content: [{ type: "text", text }] });
const kept = (...content: object[]): JSONContent => ({ type: "doc", content });
const HEADER = kept({ type: "image", attrs: { src: "data:image/png;base64,iVBORw0KGgo=", alt: null, width: 137, height: 25 } }, para("PT Jetorbit", "right"), { type: "horizontalRule" });
const FOOTER = kept(para("Jl. Godean KM 4,5"));
const texts = (selector: string) => [...host.querySelectorAll(selector)].map((e) => e.textContent);

test("a_kept_header_is_shown_at_the_top_of_every_sheet_and_a_kept_footer_at_the_bottom", () => {
  show(LAYOUT, { headerView: HEADER, footerView: FOOTER });
  expect(sheets().map((s) => s.querySelector(".hf-sheet-top")?.textContent)).toEqual(["PT Jetorbit", "PT Jetorbit", "PT Jetorbit"]);
  expect(sheets().map((s) => s.querySelector(".hf-sheet-bottom")?.textContent)).toEqual(Array(3).fill("Jl. Godean KM 4,5"));
});

test("a_kept_part_is_drawn_from_its_blocks_with_the_alignment_picture_and_rule_it_had", () => {
  show(LAYOUT, { headerView: HEADER });
  const top = sheets()[0].querySelector(".hf-sheet-top")!;
  expect((top.querySelector("p") as HTMLElement).style.textAlign).toBe("right");
  const img = top.querySelector("img")!;
  expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["137", "25"]);
  expect(top.querySelector("hr")).not.toBeNull();
});

test("a_kept_header_never_loads_a_picture_from_the_web", () => {
  const remote = "https://tracker.example/logo.png?d=secret";
  show(LAYOUT, { headerView: kept({ type: "image", attrs: { src: remote, alt: "Logo" } }, para("PT Jetorbit")) });
  expect(host.querySelectorAll(".hf-rich img")).toHaveLength(0);
  expect(host.querySelectorAll("[src]")).toHaveLength(0);
  expect([...host.querySelectorAll(".hf-sheet-top .remote-image-src")].map((e) => e.textContent)).toEqual([remote, remote, remote]);
});

test("the_page_also_holds_a_copy_in_the_text_flow_for_measuring_and_for_print", () => {
  show(LAYOUT, { headerView: HEADER, footerView: FOOTER });
  expect(texts(".hf-flow.hf-flow-top")).toEqual(["PT Jetorbit"]);
  expect(texts(".hf-flow.hf-flow-bottom")).toEqual(["Jl. Godean KM 4,5"]);
});

test("before_the_text_is_laid_out_the_kept_header_shows_in_the_flow_and_there_are_no_sheets", () => {
  show(null, { headerView: HEADER });
  expect(sheets()).toHaveLength(0);
  expect(texts(".hf-flow-top")).toEqual(["PT Jetorbit"]);
});

test("a_paper_with_no_header_or_footer_has_none_of_this", () => {
  show(LAYOUT);
  expect(host.querySelector(".hf-rich")).toBeNull();
  expect(paper().style.getPropertyValue("--hf-h")).toBe("");
});

test("the_margins_grow_to_the_height_of_the_header_and_the_footer_once_they_are_measured", () => {
  const observers: { cb: () => void; el: Element }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(private cb: () => void) {}
    observe(el: Element) { observers.push({ cb: this.cb, el }); }
    disconnect() {}
    unobserve() {}
  });
  const heights: Record<string, number> = { "hf-flow-top": 90, "hf-flow-bottom": 40 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = Object.entries(heights).find(([cls]) => this.classList.contains(cls))?.[1] ?? 0;
    return { top: 0, bottom: height, left: 0, right: 0, width: 0, height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  try {
    show(LAYOUT, { headerView: HEADER, footerView: FOOTER });
    act(() => observers.forEach(({ cb }) => cb()));
    expect(paper().style.getPropertyValue("--hf-h")).toBe("90px");
    expect(paper().style.getPropertyValue("--hf-fh")).toBe("40px");
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

// ---------------------------------------------------------------- editing a kept part

const PARTS = { headerView: HEADER, footerView: FOOTER };
type Editing = ComponentProps<typeof Paper>["editing"];

function editable(editing: Editing, handlers: Partial<ComponentProps<typeof Paper>> = {}) {
  show(LAYOUT, { ...PARTS, editing, onEdit: () => {}, onPartChange: () => {}, onEditEnd: () => {}, ...handlers });
}
const hits = (where: "top" | "bottom") => [...host.querySelectorAll<HTMLElement>(`.hf-hit-${where}`)];
const proseIn = (el: Element) => el.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };

test("a_double_click_in_the_margin_of_any_sheet_asks_to_edit_that_sheets_header_or_footer", () => {
  const onEdit = vi.fn();
  editable(null, { onEdit });
  expect(hits("top")).toHaveLength(3);
  expect(hits("bottom")).toHaveLength(3);
  act(() => void hits("top")[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(onEdit).toHaveBeenLastCalledWith("header", 1);
  act(() => void hits("bottom")[2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(onEdit).toHaveBeenLastCalledWith("footer", 2);
});

test("without_a_way_to_edit_there_is_nothing_to_double_click", () => {
  show(LAYOUT, PARTS);
  expect(hits("top")).toHaveLength(0);
});

test("a_sheet_with_no_header_or_footer_can_be_double_clicked_to_add_one", () => {
  const onEdit = vi.fn();
  show(LAYOUT, { onEdit });
  expect(hits("top")).toHaveLength(3);
  expect(hits("top")[0].title).toBe("Double-click to add a header");
  act(() => void hits("bottom")[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(onEdit).toHaveBeenLastCalledWith("footer", 0);
});

test("an_added_header_opens_an_empty_editor", () => {
  show(LAYOUT, { editing: { kind: "header", sheet: 0 }, onEdit: () => {} });
  expect(proseIn(host.querySelector(".hf-editor")!).textContent).toBe("");
});

test("page_fields_show_the_number_of_their_sheet_and_of_all_sheets", () => {
  const footer = kept({ type: "paragraph", content: [{ type: "text", text: "Hal " }, { type: "field", attrs: { instr: "PAGE", text: "1" } }, { type: "text", text: "/" }, { type: "field", attrs: { instr: "NUMPAGES", text: "1" } }, { type: "text", text: " · " }, { type: "field", attrs: { instr: "DATE", text: "1/11" } }] });
  show(LAYOUT, { footerView: footer });
  expect(sheets().map((s) => s.querySelector(".hf-sheet-bottom")!.textContent)).toEqual(["Hal 1/3 · 1/11", "Hal 2/3 · 1/11", "Hal 3/3 · 1/11"]);
});

test("clicking_in_the_text_finishes_editing_and_clicking_a_menu_or_the_bubble_does_not", () => {
  const onEditEnd = vi.fn();
  const canvas = host.appendChild(document.createElement("div"));
  canvas.className = "canvas";
  const inner = createRoot(canvas);
  act(() => inner.render(<Paper editor={editor} large={false} layout={LAYOUT} {...PARTS} editing={{ kind: "header", sheet: 0 }} onEdit={() => {}} onEditEnd={onEditEnd} />));
  const press = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  press(canvas.querySelector(".hf-editor")!); // its box (jsdom cannot place a click inside the editor itself)
  const bubble = canvas.querySelector(".paper")!.appendChild(document.createElement("div"));
  bubble.className = "bubble no-print";
  press(bubble);
  press(document.body);
  expect(onEditEnd).not.toHaveBeenCalled();
  press(canvas.querySelector(".doc")!);
  expect(onEditEnd).toHaveBeenCalledOnce();
  act(() => inner.unmount());
});

test("the_header_editor_is_handed_out_so_the_menus_can_act_on_it", () => {
  const onEditor = vi.fn();
  show(LAYOUT, { ...PARTS, editing: { kind: "header", sheet: 0 }, onEdit: () => {}, onEditor });
  expect(onEditor).toHaveBeenLastCalledWith(expect.objectContaining({ isEditable: true }));
  show(LAYOUT, { ...PARTS, editing: null, onEdit: () => {}, onEditor });
  expect(onEditor).toHaveBeenLastCalledWith(null);
});

test("while_a_header_is_edited_an_editor_holding_it_sits_on_that_sheet_in_place_of_its_copy", () => {
  editable({ kind: "header", sheet: 1 });
  const editor = host.querySelector<HTMLElement>(".hf-editor")!;
  expect(proseIn(editor).textContent).toBe("PT Jetorbit");
  expect(editor.style.top).toContain("1020px"); // the second sheet starts a page and a gap down
  expect(sheets().map((s) => s.querySelector(".hf-sheet-top")!.classList.contains("editing"))).toEqual([false, true, false]);
  expect(hits("top")).toHaveLength(0); // the margins are not double-clicked while editing
});

test("what_is_typed_in_the_header_editor_is_sent_as_the_new_view", () => {
  const onPartChange = vi.fn();
  editable({ kind: "header", sheet: 0 }, { onPartChange });
  act(() => void proseIn(host.querySelector(".hf-editor")!).editor.commands.insertContentAt(2, "Baru ")); // after the logo (0) and inside the paragraph that follows
  const [kind, view] = onPartChange.mock.lastCall!;
  expect(kind).toBe("header");
  expect(JSON.stringify(view)).toContain("Baru PT Jetorbit");
  // nothing is added to it: no empty line after the rule, which Word would show
  expect(view.content.map((n: { type: string }) => n.type)).toEqual(["image", "paragraph", "horizontalRule"]);
});

test("escape_finishes_editing", () => {
  const onEditEnd = vi.fn();
  editable({ kind: "footer", sheet: 2 }, { onEditEnd });
  const prose = proseIn(host.querySelector(".hf-editor")!);
  expect(prose.textContent).toBe("Jl. Godean KM 4,5");
  act(() => void prose.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onEditEnd).toHaveBeenCalled();
});

test("the_caret_starts_at_the_end_of_the_last_line_of_text_even_when_a_rule_comes_after_it", async () => {
  editable({ kind: "header", sheet: 0 });
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0)))); // the editor's create event comes a tick later
  const { selection } = proseIn(host.querySelector(".hf-editor")!).editor.state;
  expect(selection.empty).toBe(true);
  expect(selection.$from.parent.textContent).toBe("PT Jetorbit");
  expect(selection.$from.parentOffset).toBe("PT Jetorbit".length);
});

test("a_document_from_a_docx_is_set_as_its_file_sets_it_and_one_without_a_look_in_docbros_type", () => {
  const look = {
    font: "Arial", size: 24, spacing: { line: 276, lineRule: "auto" as const },
    headings: [{ size: null, spacing: {} }, { size: null, spacing: {} }, { size: null, spacing: {} }],
    margins: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720 },
  };
  show(LAYOUT, { look, paperWidth: 794 });
  expect(paper().classList.contains("look")).toBe(true);
  expect([paper().style.getPropertyValue("--paper-max"), paper().style.getPropertyValue("--look-size"), paper().style.getPropertyValue("--pad-x")])
    .toEqual(["796px", "16px", "96px"]); // the paper's own width, 12pt and an inch at full size
  show(LAYOUT);
  expect(paper().classList.contains("look")).toBe(false);
  expect(paper().style.getPropertyValue("--look-size")).toBe("");
});
