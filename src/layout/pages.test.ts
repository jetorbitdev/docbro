import { expect, test } from "vitest";
import { paginate, type Unit } from "./pages";

// A 1000px page with 50px above and below the text, and 20px between pages: the second page's text starts at 1070.
const PAGE = { pageHeight: 1000, gap: 20, padTop: 50, padBottom: 50 };

// Blocks laid end to end with 20px between them (the margin that sits there), the first one at 50px.
function stack(heights: number[], flags: Partial<Unit>[] = []): Unit[] {
  let top = 50;
  return heights.map((height, i) => {
    const unit: Unit = { top, height, join: 20, ...flags[i] };
    top += height + 20;
    return unit;
  });
}

test("text_that_fits_one_page_makes_no_gap", () => {
  expect(paginate(stack([400, 400]), PAGE)).toEqual({ gaps: [], pages: 1 });
});

test("a_block_that_does_not_fit_moves_to_the_top_of_the_next_page", () => {
  // the third block would end at 1290; the page's text ends at 950. It goes to 1070, so the gap is 1070 - 870 - 20.
  expect(paginate(stack([400, 400, 400]), PAGE)).toEqual({ gaps: [{ index: 2, height: 180 }], pages: 2 });
});

test("a_block_that_ends_exactly_where_the_page_does_stays", () => {
  // 50 + 450 + 20 + 430 = 950
  expect(paginate(stack([450, 430]), PAGE).gaps).toEqual([]);
  expect(paginate(stack([450, 431]), PAGE).gaps).toHaveLength(1);
});

test("a_page_break_starts_the_next_block_on_a_new_page_however_much_room_is_left", () => {
  const layout = paginate(stack([100, 30, 100], [{}, { forcedAfter: true }]), PAGE);
  expect(layout.gaps).toEqual([{ index: 2, height: 1070 - 200 - 20 }]);
  expect(layout.pages).toBe(2);
});

test("two_page_breaks_in_a_row_leave_a_page_between_them", () => {
  const layout = paginate(stack([100, 30, 30, 100], [{}, { forcedAfter: true }, { forcedAfter: true }]), PAGE);
  expect(layout.gaps.map((g) => g.index)).toEqual([2, 3]);
  expect(layout.pages).toBe(3);
});

test("a_page_break_at_the_very_end_still_opens_a_page", () => {
  expect(paginate(stack([100, 30], [{}, { forcedAfter: true }]), PAGE).pages).toBe(2);
});

test("a_cover_has_its_page_to_itself", () => {
  // a cover is laid over the page's own margin: it fills 0 to 1000, and the 20px margin puts the next block at 1020,
  // which is already inside the second sheet's top margin. The block goes down to 1070; it must not skip a page.
  const units: Unit[] = [
    { top: 0, height: 1000, join: 20, forcedAfter: true },
    { top: 1020, height: 100, join: 20 },
    { top: 1140, height: 100, join: 20 },
  ];
  expect(paginate(units, PAGE)).toEqual({ gaps: [{ index: 1, height: 50 }], pages: 2 });
});

test("a_block_that_falls_in_the_top_margin_of_a_sheet_is_moved_down_to_the_text", () => {
  // the first block runs over its page and ends at 1020, in the margin of the second; the next one is at 1040
  expect(paginate(stack([970, 100]), PAGE).gaps).toEqual([{ index: 1, height: 30 }]);
});

test("a_forced_block_that_already_left_the_page_is_not_pushed_a_second_time", () => {
  // the break marker ends at 1005, in the desk between the sheets; the block after it is at 1025, on the second sheet
  const units: Unit[] = [
    { top: 50, height: 955, join: 20, forcedAfter: true },
    { top: 1025, height: 100, join: 20 },
  ];
  expect(paginate(units, PAGE)).toEqual({ gaps: [{ index: 1, height: 45 }], pages: 2 });
});

test("a_block_marked_to_open_a_page_goes_to_a_new_one_even_when_it_fits", () => {
  const layout = paginate(stack([100, 100], [{}, { forcedBefore: true }]), PAGE);
  expect(layout.gaps.map((g) => g.index)).toEqual([1]);
});

test("a_block_taller_than_a_page_starts_a_page_and_runs_over_and_the_next_block_follows_it", () => {
  // the tall block moves to 1070 and ends at 2570, in the third page (2040 to 3060); the small block after it fits there
  const layout = paginate(stack([400, 1500, 100]), PAGE);
  expect(layout.gaps.map((g) => g.index)).toEqual([1]);
  expect(layout.pages).toBe(3);
});

test("a_first_block_taller_than_a_page_is_not_pushed_anywhere", () => {
  expect(paginate(stack([1500]), PAGE)).toEqual({ gaps: [], pages: 2 });
});

test("the_gap_leaves_out_the_margins_the_blocks_bring_with_them", () => {
  const units = stack([400, 400, 400]);
  units[2].join = 60;
  expect(paginate(units, PAGE).gaps).toEqual([{ index: 2, height: 140 }]);
});

test("no_blocks_is_one_page", () => {
  expect(paginate([], PAGE)).toEqual({ gaps: [], pages: 1 });
});
