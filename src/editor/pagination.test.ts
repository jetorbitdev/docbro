import type { Editor, JSONContent } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fixtureDoc } from "../formats/docx/fixture";
import type { PageLayout } from "../layout/pages";
import { createHeadlessEditor } from "./headless";
import { PAGE_GAP, paginationPlugin, paperGeometry, repaginate } from "./pagination";

// jsdom lays nothing out, so the page gets a stand-in for the browser: blocks stacked from 50px down, a
// paragraph 100px tall, a page break 30px, a cover 1000px (it is pulled up over the page's 50px margin, so it
// takes 950 of the flow), a gap as tall as it was told to be (times the zoom). No margins.
const PAGE = { pageHeight: 1000, gap: 20, padTop: 50, padBottom: 50 };
const PIXEL = fixtureDoc().content!.find((n) => n.type === "image")!.attrs!.src as string;

const p = (): JSONContent => ({ type: "paragraph", content: [{ type: "text", text: "x" }] });
const breakNode = (): JSONContent => ({ type: "pageBreak" });
const cover = (): JSONContent => ({ type: "image", attrs: { src: PIXEL, alt: null, cover: true } });

let zoom = 1;
const heightOf = (el: Element): number =>
  el.classList.contains("page-gap") ? parseFloat((el as HTMLElement).style.height) * zoom
  : el.hasAttribute("data-page-break") ? 30
  : el.hasAttribute("data-cover") ? 1000
  : 100;
const flowOf = (el: Element) => (el.hasAttribute("data-cover") ? 950 : heightOf(el));
const rect = (top: number, height: number) =>
  ({ top, bottom: top + height, left: 0, right: 780, width: 780, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

let editors: Editor[] = [];
let layouts: (PageLayout | null)[] = [];

function make(content: JSONContent[], geometry: () => typeof PAGE | null = () => PAGE): Editor {
  const paper = document.body.appendChild(document.createElement("div"));
  paper.className = "paper";
  const editor = createHeadlessEditor({ type: "doc", content });
  editor.mount(paper.appendChild(document.createElement("div")));
  const root = editor.view.dom;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === paper) return rect(0, 0);
    if (this.parentElement !== root) return rect(0, 0);
    let top = 50;
    for (const sibling of root.children) {
      if (sibling === this) break;
      top += flowOf(sibling);
    }
    return this.hasAttribute("data-cover") ? rect(top - 50, 1000) : rect(top, heightOf(this));
  });
  editor.registerPlugin(
    paginationPlugin({ geometry, onLayout: (layout) => layouts.push(layout), zoom: () => zoom }),
  );
  editors.push(editor);
  repaginate(editor.view);
  return editor;
}

const gaps = (editor: Editor) => [...editor.view.dom.querySelectorAll<HTMLElement>(".page-gap")];
const indexOf = (editor: Editor, el: Element) => [...editor.view.dom.children].indexOf(el);

beforeEach(() => {
  zoom = 1;
  layouts = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  editors.forEach((e) => (e.view.dom.closest(".paper")?.remove(), e.destroy()));
  editors = [];
});

test("a_gap_goes_before_the_block_that_does_not_fit_and_fills_the_rest_of_the_page", () => {
  const editor = make(Array.from({ length: 12 }, p));
  // nine paragraphs fill the first sheet (50 to 950); the tenth would end at 1050, so it starts at 1070
  expect(gaps(editor)).toHaveLength(1);
  expect(indexOf(editor, gaps(editor)[0])).toBe(9);
  expect(gaps(editor)[0].style.height).toBe("120px");
  expect(layouts.at(-1)).toMatchObject({ pages: 2, pageHeight: 1000 });
});

test("laying_out_again_changes_nothing_and_sends_nothing", () => {
  const editor = make(Array.from({ length: 12 }, p));
  const sent = vi.fn();
  editor.on("transaction", sent);
  repaginate(editor.view);
  repaginate(editor.view);
  expect(sent).not.toHaveBeenCalled();
  expect(gaps(editor)).toHaveLength(1);
});

test("a_page_break_puts_the_next_block_on_a_new_page", () => {
  const editor = make([p(), p(), p(), breakNode(), p()]);
  // the marker ends at 380, the next block starts at 1070
  expect(gaps(editor).map((g) => g.style.height)).toEqual(["690px"]);
  expect(indexOf(editor, gaps(editor)[0])).toBe(4);
  expect(layouts.at(-1)!.pages).toBe(2);
});

test("a_cover_fills_its_page_and_the_text_starts_the_next", () => {
  const editor = make([cover(), p(), p()]);
  expect(gaps(editor).map((g) => g.style.height)).toEqual(["70px"]);
  expect(layouts.at(-1)!.pages).toBe(2);
});

test("the_gaps_follow_an_edit", () => {
  const editor = make(Array.from({ length: 12 }, p));
  expect(gaps(editor)).toHaveLength(1);
  editor.commands.setContent({ type: "doc", content: Array.from({ length: 9 }, p) });
  repaginate(editor.view);
  expect(gaps(editor)).toHaveLength(0);
  expect(layouts.at(-1)!.pages).toBe(1);
});

test("a_gap_is_as_tall_in_the_zoomed_page_as_it_has_to_look_on_screen", () => {
  zoom = 2;
  const editor = make([p(), p(), p(), breakNode(), p()]);
  // 690 px on screen is 345 css px inside a page zoomed to twice the size
  expect(gaps(editor).map((g) => g.style.height)).toEqual(["345px"]);
  repaginate(editor.view);
  expect(gaps(editor).map((g) => g.style.height)).toEqual(["345px"]); // and it stays so
});

test("without_a_page_to_measure_there_are_no_gaps", () => {
  const editor = make(Array.from({ length: 12 }, p), () => null);
  expect(gaps(editor)).toHaveLength(0);
  expect(layouts.at(-1)).toBeNull();
});

test("a_gap_is_not_part_of_the_document", () => {
  const editor = make(Array.from({ length: 12 }, p));
  expect(editor.state.doc.childCount).toBe(12);
  expect(editor.getText()).not.toContain("page-gap");
});

test("the_sheet_is_as_tall_as_the_paper_is_wide_times_the_page_proportions", () => {
  const paper = document.createElement("div");
  paper.style.paddingTop = "80px";
  Object.defineProperty(paper, "clientWidth", { value: 780 });
  // A4 is 11906 x 16838 twips, Letter 12240 x 15840
  expect(paperGeometry(paper, 16838 / 11906)).toEqual({ pageHeight: 1103, gap: PAGE_GAP, padTop: 80, padBottom: 80 });
  expect(paperGeometry(paper, 15840 / 12240)!.pageHeight).toBe(1009);
});

test("a_paper_with_no_width_has_no_sheets", () => {
  expect(paperGeometry(document.createElement("div"), 1.4)).toBeNull();
});
