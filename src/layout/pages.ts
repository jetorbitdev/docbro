// --- Where the pages break ---------------------------------------------------------

/** The sheets, in px from the top of the paper: each is `pageHeight` tall with `gap` of desk between it and the next. */
export interface Geometry {
  pageHeight: number;
  gap: number;
  padTop: number; // between a sheet's top edge and its text
  padBottom: number;
}

/** What the page layout found: the sheets' size and how many of them the text takes. */
export interface PageLayout extends Geometry {
  pages: number;
}

/** A top-level block as it lies with no page gaps in the text: `top` and `height` in px from the top of the paper. */
export interface Unit {
  top: number;
  height: number;
  /** The margins this block and the one before it bring to the edge between them, added together. */
  join: number;
  /**
   * How far below its top it reaches when that is more than `height`: a picture with the text beside it takes no room in
   * the flow (`height` 0), but it has to fit on its page, and the text beside it goes where it goes.
   */
  reach?: number;
  /** Starts a page of its own (a cover). */
  forcedBefore?: boolean;
  /** The block after it starts a new page (a page break, a cover). */
  forcedAfter?: boolean;
}

/** The sheet at `y` px from the top of the paper; one in a gap is the sheet above it. */
export function sheetAt(y: number, layout: PageLayout): number {
  return Math.min(layout.pages - 1, Math.max(0, Math.floor(y / (layout.pageHeight + layout.gap))));
}

export interface Layout {
  /** Spacers to put in front of the block at `index`, each as tall as the end of one page and the start of the next. */
  gaps: { index: number; height: number }[];
  pages: number;
}

/**
 * Breaks the blocks into pages. A block that would run past the end of its page moves whole to the top of the
 * next one, unless it is the first on its page (a block taller than a page runs over; so do a table or a list,
 * which are one block). A page break or a cover moves the block after it whatever room is left.
 *
 * A picture with the text beside it (`reach`) is never parted from the blocks that start within its reach: where a
 * page would break among them, the picture goes to the next page with them instead. A gap between them would change how
 * the text wraps, and so how tall it is, so the next layout would not find the gap needed and would take it away again.
 */
export function paginate(units: Unit[], g: Geometry): Layout {
  const pinned = new Map<number, number>(); // pictures that have to start a page, by index
  for (;;) {
    const result = lay(units, g, pinned);
    if (!("pin" in result)) return result;
    pinned.set(result.pin.index, result.pin.page);
  }
}

function lay(units: Unit[], g: Geometry, pinned: Map<number, number>): Layout | { pin: { index: number; page: number } } {
  const pitch = g.pageHeight + g.gap;
  const pageTop = (page: number) => page * pitch + g.padTop;
  const limit = (page: number) => page * pitch + g.pageHeight - g.padBottom;

  const gaps: Layout["gaps"] = [];
  let cursor = 0; // where the last block ends
  let page = 0;
  let first = 0; // the first block of this page
  let floater: { index: number; page: number; bottom: number } | null = null; // the last picture with text beside it, on this page

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const before = units[i - 1];
    let top = i === 0 ? unit.top : cursor + Math.max(0, unit.top - (before.top + before.height));
    const endPage = Math.max(page, Math.floor((cursor - 1) / pitch)); // the page the block before it ends on
    page = Math.max(page, Math.floor(top / pitch));

    // The page this block has to be on, when where it fell is not it.
    let target: number | null = null;
    let forced = false;
    if (i > 0) {
      forced = !!(unit.forcedBefore || before.forcedAfter);
      if (forced) target = page > endPage ? page : page + 1;
      else if (top + Math.max(unit.height, unit.reach ?? 0) > limit(page) && i !== first) target = page + 1;
      else if (page > 0 && top < pageTop(page)) target = page; // in the top margin of a sheet
      const pin = pinned.get(i);
      if (pin !== undefined) target = Math.max(target ?? 0, pin);
    }
    // A break among the blocks beside a picture goes in front of the picture, or, with it first on its page, is not made.
    if (target !== null && !forced && !pinned.has(i) && floater && top < floater.bottom) {
      if (floater.index !== first) return { pin: { index: floater.index, page: Math.max(target, floater.page + 1) } };
      target = null;
    }
    if (target !== null) {
      if (pageTop(target) > top) {
        gaps.push({ index: i, height: Math.max(0, pageTop(target) - cursor - unit.join) });
        top = Math.max(pageTop(target), cursor + unit.join);
      }
      page = target;
      first = i;
      floater = null;
    }
    if (unit.reach) floater = { index: i, page, bottom: top + unit.reach };
    cursor = top + unit.height;
  }

  const last = units[units.length - 1];
  let pages = Math.max(page, Math.floor((cursor - 1) / pitch)) + 1;
  if (last?.forcedAfter) pages += 1;
  return { gaps, pages: Math.max(1, pages) };
}
