import { describe, expect, test } from "vitest";
import { pickAnchor, scrollCorrection } from "./readingAnchor";

const VIEW = { top: 88, bottom: 888 };
// three blocks, the first one scrolled half out of sight
const BLOCKS = [
  { top: 20, bottom: 140 },
  { top: 160, bottom: 400 },
  { top: 420, bottom: 600 },
];

describe("pickAnchor", () => {
  test("the_caret_line_when_it_is_inside_the_scroller", () => {
    expect(pickAnchor(VIEW, { top: 300, bottom: 329 }, BLOCKS)).toEqual({ kind: "caret" });
    // touching the edges still counts as inside
    expect(pickAnchor(VIEW, { top: 88, bottom: 117 }, BLOCKS)).toEqual({ kind: "caret" });
    expect(pickAnchor(VIEW, { top: 859, bottom: 888 }, BLOCKS)).toEqual({ kind: "caret" });
  });

  test("the_first_block_at_the_top_edge_when_the_caret_is_out_of_view_or_missing", () => {
    expect(pickAnchor(VIEW, { top: 1200, bottom: 1229 }, BLOCKS)).toEqual({ kind: "block", index: 0 });
    expect(pickAnchor(VIEW, { top: 60, bottom: 89 }, BLOCKS)).toEqual({ kind: "block", index: 0 });
    expect(pickAnchor(VIEW, { top: 870, bottom: 899 }, BLOCKS)).toEqual({ kind: "block", index: 0 });
    expect(pickAnchor(VIEW, null, BLOCKS)).toEqual({ kind: "block", index: 0 });
  });

  test("blocks_wholly_above_the_scroller_are_skipped", () => {
    const scrolled = [
      { top: -500, bottom: -300 },
      { top: -280, bottom: 88 },
      { top: 100, bottom: 300 },
    ];
    expect(pickAnchor(VIEW, null, scrolled)).toEqual({ kind: "block", index: 2 });
  });

  test("nothing_to_hold_in_an_empty_or_fully_scrolled_past_document", () => {
    expect(pickAnchor(VIEW, null, [])).toBeNull();
    expect(pickAnchor(VIEW, null, [{ top: -400, bottom: 50 }])).toBeNull();
  });
});

describe("scrollCorrection", () => {
  test("scrolls_down_by_the_distance_the_anchor_sank", () => {
    expect(scrollCorrection(100, 187, 1500)).toBe(1587);
  });

  test("scrolls_up_by_the_distance_the_anchor_rose", () => {
    expect(scrollCorrection(440, 353, 1734)).toBe(1647);
  });

  test("leaves_the_scroll_alone_when_the_anchor_has_not_moved", () => {
    expect(scrollCorrection(100, 100, 1500)).toBe(1500);
    expect(scrollCorrection(100, 100.004, 1500)).toBe(1500);
  });

  test("works_on_fractional_offsets", () => {
    expect(scrollCorrection(100.5, 112.25, 40)).toBeCloseTo(51.75);
  });
});
