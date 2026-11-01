import type { Node as ProseNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { paginate, type Geometry, type PageLayout, type Unit } from "../layout/pages";

/**
 * Lays the document out on sheets. The text stays one flow in one editor; where a page ends, a spacer as tall
 * as the end of that page, the desk between the sheets and the start of the next goes in front of the block
 * that opens the new page. The sheets themselves are drawn behind the text (layout/Paper.tsx). A spacer is a
 * decoration: it is not in the document, so the session sees no edit and the undo history gets nothing.
 */

export interface PaginationOptions {
  /** The sheets' size, read from the page; null while there is nothing to lay out. */
  geometry(paper: HTMLElement): Geometry | null;
  /** Called when the sheets' size or their number changes, and with null when there is no layout. */
  onLayout(layout: PageLayout | null): void;
  /** The CSS zoom of the text (View ▸ Larger text): a spacer's height is scaled by it. */
  zoom?(): number;
}

interface Gap {
  pos: number;
  height: number; // px on screen
}

/** Desk between one sheet and the next, in px. */
export const PAGE_GAP = 28;

/** The sheets' size for a paper `paper.clientWidth` wide: a sheet is as wide as the paper, `ratio` times as tall. */
export function paperGeometry(paper: HTMLElement, ratio: number): Geometry | null {
  const width = paper.clientWidth;
  if (!width) return null;
  const padTop = parseFloat(getComputedStyle(paper).paddingTop) || 0;
  return { pageHeight: Math.round(width * ratio), gap: PAGE_GAP, padTop, padBottom: padTop };
}

const key = new PluginKey<DecorationSet>("docbroPagination");
export const paginationKey = key;
const paginators = new WeakMap<EditorView, Paginator>();

/** Lays the page out now instead of at the next frame. */
export function repaginate(view: EditorView): void {
  paginators.get(view)?.run();
}

const isCover = (node: ProseNode) => node.type.name === "image" && !!node.attrs.cover;

function gapWidget({ pos, height }: Gap, zoom: number): Decoration {
  return Decoration.widget(
    pos,
    () => {
      const el = document.createElement("div");
      el.className = "page-gap";
      el.contentEditable = "false";
      el.setAttribute("aria-hidden", "true");
      el.style.height = `${height / zoom}px`;
      return el;
    },
    { side: -1, key: `page-gap-${height}-${zoom}`, height },
  );
}

const currentGaps = (set: DecorationSet): Gap[] =>
  set.find().map((d) => ({ pos: d.from, height: d.spec.height as number }));

// A pixel of difference is measuring noise, and acting on it would make the layout chase itself.
const sameGaps = (a: Gap[], b: Gap[]) =>
  a.length === b.length && a.every((g, i) => g.pos === b[i].pos && Math.abs(g.height - b[i].height) <= 1);

export function paginationPlugin(options: PaginationOptions): Plugin<DecorationSet> {
  const zoom = () => options.zoom?.() || 1;
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const next = tr.getMeta(key) as { gaps: Gap[] } | undefined;
        if (next) return DecorationSet.create(tr.doc, next.gaps.map((g) => gapWidget(g, zoom())));
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
      },
    },
    props: { decorations: (state) => key.getState(state) },
    view(view) {
      const paginator = new Paginator(view, options);
      paginators.set(view, paginator);
      return {
        update: (_view, prev) => paginator.update(prev),
        destroy: () => paginator.destroy(),
      };
    },
  });
}

class Paginator {
  private frame = 0;
  private reported: string | undefined;
  private observer: ResizeObserver | undefined;
  private observed: Element | null = null;

  constructor(private view: EditorView, private options: PaginationOptions) {
    // the page's width changes the line breaks, and a picture loading changes a height: either lays the text out again
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.schedule());
      this.observer.observe(view.dom);
    }
    this.schedule();
  }

  update(prev: EditorState): void {
    if (!prev.doc.eq(this.view.state.doc)) this.schedule();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.run();
    });
  }

  run(): void {
    const { view, options } = this;
    if (view.isDestroyed) return;
    const paper = view.dom.closest<HTMLElement>(".paper");
    if (paper && paper !== this.observed) {
      if (this.observed) this.observer?.unobserve(this.observed);
      // the border box: a kept header or footer changes the paper's padding, which the content box does not see
      this.observer?.observe(paper, { box: "border-box" });
      this.observed = paper;
    }
    const geometry = paper ? options.geometry(paper) : null;
    const existing = currentGaps(key.getState(view.state) ?? DecorationSet.empty);

    let gaps: Gap[] = [];
    let layout: PageLayout | null = null;
    if (paper && geometry) {
      const { units, positions } = this.measure(paper, existing);
      const result = paginate(units, geometry);
      gaps = result.gaps.map((g) => ({ pos: positions[g.index], height: Math.round(g.height) }));
      layout = { ...geometry, pages: result.pages };
    }

    if (!sameGaps(existing, gaps)) view.dispatch(view.state.tr.setMeta(key, { gaps }).setMeta("addToHistory", false));

    const report = JSON.stringify(layout);
    if (report !== this.reported) {
      this.reported = report;
      options.onLayout(layout);
    }
  }

  // The top-level blocks as they would lie with no gaps: where each is now, less the gaps in front of it.
  private measure(paper: HTMLElement, existing: Gap[]): { units: Unit[]; positions: number[] } {
    const { view } = this;
    const paperTop = paper.getBoundingClientRect().top;
    const units: Unit[] = [];
    const positions: number[] = [];
    let before = 0; // screen px of the gaps in front of the block being measured
    let lastMargin = 0;
    view.state.doc.forEach((node, offset) => {
      before += existing.filter((g) => g.pos === offset).reduce((sum, g) => sum + g.height, 0);
      const dom = view.nodeDOM(offset);
      const box = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
      const style = dom instanceof HTMLElement ? getComputedStyle(dom) : null;
      const margin = { top: parseFloat(style?.marginTop ?? "") || 0, bottom: parseFloat(style?.marginBottom ?? "") || 0 };
      const cover = isCover(node);
      units.push({
        top: (box?.top ?? 0) - paperTop - before,
        height: box?.height ?? 0,
        join: lastMargin + margin.top,
        forcedBefore: cover,
        forcedAfter: cover || node.type.name === "pageBreak",
      });
      positions.push(offset);
      lastMargin = margin.bottom;
    });
    return { units, positions };
  }
}
