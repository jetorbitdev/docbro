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
 */
export function paginate(units: Unit[], g: Geometry): Layout {
  const pitch = g.pageHeight + g.gap;
  const pageTop = (page: number) => page * pitch + g.padTop;
  const limit = (page: number) => page * pitch + g.pageHeight - g.padBottom;

  const gaps: Layout["gaps"] = [];
  let cursor = 0; // where the last block ends
  let page = 0;
  let first = 0; // the first block of this page

  units.forEach((unit, i) => {
    const before = units[i - 1];
    let top = i === 0 ? unit.top : cursor + Math.max(0, unit.top - (before.top + before.height));
    const endPage = Math.max(page, Math.floor((cursor - 1) / pitch)); // the page the block before it ends on
    page = Math.max(page, Math.floor(top / pitch));

    // The page this block has to be on, when where it fell is not it.
    let target: number | null = null;
    if (i > 0) {
      const forced = unit.forcedBefore || before.forcedAfter;
      if (forced) target = page > endPage ? page : page + 1;
      else if (top + unit.height > limit(page) && i !== first) target = page + 1;
      else if (page > 0 && top < pageTop(page)) target = page; // in the top margin of a sheet
    }
    if (target !== null) {
      if (pageTop(target) > top) {
        gaps.push({ index: i, height: Math.max(0, pageTop(target) - cursor - unit.join) });
        top = Math.max(pageTop(target), cursor + unit.join);
      }
      page = target;
      first = i;
    }
    cursor = top + unit.height;
  });

  const last = units[units.length - 1];
  let pages = Math.max(page, Math.floor((cursor - 1) / pitch)) + 1;
  if (last?.forcedAfter) pages += 1;
  return { gaps, pages: Math.max(1, pages) };
}
