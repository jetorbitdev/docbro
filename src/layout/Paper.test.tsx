import type { Editor } from "@tiptap/core";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { KeptPart } from "../doc/meta";
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
const kept = (...content: object[]): KeptPart => ({ xml: "", rels: null, media: {}, view: { type: "doc", content } });
const HEADER = kept({ type: "image", attrs: { src: "data:image/png;base64,iVBORw0KGgo=", alt: null, width: 137, height: 25 } }, para("PT Jetorbit", "right"), { type: "horizontalRule" });
const FOOTER = kept(para("Jl. Godean KM 4,5"));
const texts = (selector: string) => [...host.querySelectorAll(selector)].map((e) => e.textContent);

test("a_kept_header_is_shown_at_the_top_of_every_sheet_and_a_kept_footer_at_the_bottom", () => {
  show(LAYOUT, { headerPart: HEADER, footerPart: FOOTER });
  expect(sheets().map((s) => s.querySelector(".hf-sheet-top")?.textContent)).toEqual(["PT Jetorbit", "PT Jetorbit", "PT Jetorbit"]);
  expect(sheets().map((s) => s.querySelector(".hf-sheet-bottom")?.textContent)).toEqual(Array(3).fill("Jl. Godean KM 4,5"));
});

test("a_kept_part_is_drawn_from_its_blocks_with_the_alignment_picture_and_rule_it_had", () => {
  show(LAYOUT, { headerPart: HEADER });
  const top = sheets()[0].querySelector(".hf-sheet-top")!;
  expect((top.querySelector("p") as HTMLElement).style.textAlign).toBe("right");
  const img = top.querySelector("img")!;
  expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["137", "25"]);
  expect(top.querySelector("hr")).not.toBeNull();
});

test("the_page_also_holds_a_copy_in_the_text_flow_for_measuring_and_for_print", () => {
  show(LAYOUT, { headerPart: HEADER, footerPart: FOOTER });
  expect(texts(".hf-flow.hf-flow-top")).toEqual(["PT Jetorbit"]);
  expect(texts(".hf-flow.hf-flow-bottom")).toEqual(["Jl. Godean KM 4,5"]);
});

test("before_the_text_is_laid_out_the_kept_header_shows_in_the_flow_and_there_are_no_sheets", () => {
  show(null, { headerPart: HEADER });
  expect(sheets()).toHaveLength(0);
  expect(texts(".hf-flow-top")).toEqual(["PT Jetorbit"]);
});

test("a_paper_with_no_kept_part_has_none_of_this", () => {
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
    show(LAYOUT, { headerPart: HEADER, footerPart: FOOTER });
    act(() => observers.forEach(({ cb }) => cb()));
    expect(paper().style.getPropertyValue("--hf-h")).toBe("90px");
    expect(paper().style.getPropertyValue("--hf-fh")).toBe("40px");
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
