import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
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
const show = (layout: PageLayout | null) => act(() => root.render(<Paper editor={editor} large={false} layout={layout} />));
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
