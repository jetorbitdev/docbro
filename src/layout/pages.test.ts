import { expect, test } from "vitest";
import { estimatePages, pageLabel } from "./pages";

test("estimates_pages_from_the_paper_height", () => {
  expect(estimatePages(0)).toBe(1);
  expect(estimatePages(1056)).toBe(1);
  expect(estimatePages(1057)).toBe(2);
});

test("page_label_matches_the_mock", () => {
  expect(pageLabel(true, 3)).toBe("Page 1 of 3");
  expect(pageLabel(false, 3)).toBe("# Add page numbers");
});
