import { expect, test } from "vitest";
import type { DocLook } from "../doc/meta";
import { lineHeight, lookStyle, spacingStyle } from "./look";

test("a_line_is_a_multiple_of_the_fonts_single_line_or_a_height_in_points", () => {
  expect(lineHeight({ line: 240, lineRule: "auto" })).toBe("1.15");
  expect(lineHeight({ line: 276 })).toBe("1.322");
  expect(lineHeight({ line: 360, lineRule: "exact" })).toBe("calc(18 * var(--pt))");
  expect(lineHeight({ line: 360, lineRule: "atLeast" })).toBe("max(1.15em, calc(18 * var(--pt)))");
  expect(lineHeight({ before: 120 })).toBeNull();
});

test("a_paragraphs_spacing_is_written_as_the_properties_the_page_reads_in_points", () => {
  expect(spacingStyle({ before: 120, after: 0, line: 240, lineRule: "auto" })).toBe("--p-before: 6; --p-after: 0; --p-line: 1.15");
  expect(spacingStyle({ after: 200 })).toBe("--p-after: 10");
});

const LOOK: DocLook = {
  font: "Arial",
  size: 24,
  spacing: { after: 160, line: 276, lineRule: "auto" },
  headings: [{ size: 40, spacing: { before: 400, after: 120 } }, { size: null, spacing: {} }, { size: null, spacing: {} }],
  margins: { top: 1440, right: 1440, bottom: 1440, left: 1080, header: 720, footer: 720 },
};

test("the_paper_is_sized_by_the_file_at_the_scale_of_the_sheet", () => {
  const style = lookStyle(LOOK, 0.5, 794) as Record<string, unknown>;
  expect(style).toMatchObject({
    "--paper-max": "796px", // the paper and its border
    "--look-scale": 0.5,
    "--pt": "0.667px",
    "--look-size": "8px", // 12pt at half size
    "--look-line": "1.322",
    "--look-after": 8,
    "--look-font": '"Arial", var(--doc-font)',
    "--look-h1": "13.333px",
    "--look-h1-before": 20,
    "--pad-x": "36px", // 1080 twips is 72px, at half size
    "--hf-offset": "24px",
  });
  expect(style["--pad-y"]).toBe("max(48px, calc(var(--hf-offset) + var(--hf-h, 0px)), calc(var(--hf-offset) + var(--hf-fh, 0px)))");
  expect(style).not.toHaveProperty("--look-h2");
});
