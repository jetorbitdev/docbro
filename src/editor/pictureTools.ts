import { Extension, type CommandProps, type Editor } from "@tiptap/core";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { NodeSelection, type EditorState } from "@tiptap/pm/state";
import { loadsInPage } from "./pictureSource";

/** The narrowest and widest a picture can be made (px). */
export const MIN_PICTURE = 24;
const MAX_PICTURE = 4000;
/** What "fit to the text" spreads over when the page cannot be measured (no layout): the text width of a page, in px. */
const FALLBACK_WIDTH = 624;

export type Align = "left" | "center" | "right";
/**
 * How a picture lies with the text. `inline`: on a line of its own, set left, center or right. `wrap`: at the left or
 * right edge of the text with the text running beside it. `cover`: a page of its own, edge to edge (layout/pagination.ts).
 */
export type PictureLayout = "inline" | "wrap" | "cover";

const isAlign = (value: unknown): value is "center" | "right" => value === "center" || value === "right";

/** The width (px) a picture was given, or null when it is as big as it is. */
export function pictureWidth(value: unknown): number | null {
  // a pasted `width="50%"` is not a width in px
  const width = typeof value === "string" ? (/^\s*\d+(?:\.\d+)?(?:px)?\s*$/.test(value) ? parseFloat(value) : NaN) : Number(value);
  return width > 0 ? Math.round(width) : null;
}

/** Which edge of the text a picture with its text wrapped beside it sits at; null when it is not wrapped. */
export function wrapSide(attrs: Record<string, unknown> | undefined): "left" | "right" | null {
  if (!attrs?.wrap || attrs.cover) return null;
  return attrs.align === "right" ? "right" : "left";
}

/** How a picture that is not wrapped is set on its line (a wrapped one sits at its side instead). */
export function pictureAlign(attrs: Record<string, unknown> | undefined): Align {
  return isAlign(attrs?.align) ? attrs.align : "left";
}

/** The attributes the picture node has besides the ones TipTap's gives it. Spread into the node (editor/extensions.ts). */
export const pictureAttributes = {
  // a width is kept in px, as the file has it, and drawn at the scale of the sheet (`--look-scale`, layout/look.ts) as a
  // table's widths are; the height follows from the picture's own shape. A cover is as wide as its sheet whatever this is.
  width: {
    default: null,
    parseHTML: (element: HTMLElement) => pictureWidth(element.getAttribute("width")),
    renderHTML: (attributes: Record<string, unknown>) => {
      const width = pictureWidth(attributes.width);
      if (!width) return {};
      return attributes.cover ? { width } : { width, style: `width: calc(${width}px * var(--look-scale, 1))` };
    },
  },
  // set in from the left edge: centered or at the right; null is the left, as a line of text starts
  align: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const align = element.getAttribute("data-align");
      return isAlign(align) ? align : null;
    },
    renderHTML: (attributes: Record<string, unknown>) => (isAlign(attributes.align) ? { "data-align": attributes.align } : {}),
  },
  // the text runs beside the picture, which sits at the left edge or (with `align: "right"`) the right one
  wrap: {
    default: false,
    parseHTML: (element: HTMLElement) => element.hasAttribute("data-wrap"),
    renderHTML: (attributes: Record<string, unknown>) => (attributes.wrap ? { "data-wrap": "" } : {}),
  },
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pictureTools: {
      /** Sets the width (px) of the selected picture, its height following; null makes it as big as it is. */
      setPictureWidth: (px: number | null) => ReturnType;
      /** Sets the width of the selected picture to a share (0 to 1) of the width of the text. */
      fitPicture: (fraction: number) => ReturnType;
      /** Sets the selected picture at the left, center or right of its line, or of the text it is wrapped with. */
      setPictureAlign: (align: Align) => ReturnType;
      /** Sets how the selected picture lies with the text. */
      setPictureLayout: (layout: PictureLayout) => ReturnType;
    };
  }
}

/** The picture node the selection is, with where it is. */
export function selectedPicture(state: EditorState): { node: ProseNode; pos: number } | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "image") return null;
  return { node: selection.node, pos: selection.from };
}

/** The room the text has in the page, in the px a width is in (the page may be drawn at a scale). */
export function textWidth(editor: Editor): number {
  if (!editor.isInitialized || editor.isDestroyed) return FALLBACK_WIDTH;
  try {
    const room = editor.view.dom.clientWidth;
    const scale = parseFloat(getComputedStyle(editor.view.dom).getPropertyValue("--look-scale")) || 1;
    return room ? Math.max(MIN_PICTURE, room / scale) : FALLBACK_WIDTH;
  } catch {
    return FALLBACK_WIDTH;
  }
}

const clamp = (px: number) => Math.min(MAX_PICTURE, Math.max(MIN_PICTURE, Math.round(px)));

export const PictureTools = Extension.create({
  name: "pictureTools",
  addCommands() {
    // Changes some attributes of the selected picture and keeps it selected.
    const change =
      (patch: (attrs: Record<string, unknown>) => Record<string, unknown> | null) =>
      ({ state, tr, dispatch }: CommandProps) => {
        const found = selectedPicture(state);
        if (!found) return false;
        const next = patch(found.node.attrs);
        if (!next) return false;
        if (dispatch) {
          tr.setNodeMarkup(found.pos, null, { ...found.node.attrs, ...next });
          tr.setSelection(NodeSelection.create(tr.doc, found.pos));
        }
        return true;
      };

    return {
      setPictureWidth: (px) =>
        change((attrs) => {
          if (attrs.cover) return null;
          if (px !== null && !(px > 0)) return null;
          // the height is dropped: it follows from the width and the picture's own shape
          return { width: px === null ? null : clamp(px), height: null };
        }),

      fitPicture: (fraction) =>
        change((attrs) => {
          if (attrs.cover || !(fraction > 0)) return null;
          return { width: clamp(textWidth(this.editor) * Math.min(1, fraction)), height: null };
        }),

      setPictureAlign: (align) =>
        change((attrs) => {
          if (attrs.cover) return null;
          // text cannot run down both sides of a picture: a wrapped one is at the left or the right
          if (attrs.wrap && align === "center") return null;
          return { align: align === "left" ? null : align };
        }),

      setPictureLayout: (layout) =>
        change((attrs) => {
          if (layout === "cover") return { cover: true, wrap: false, align: null };
          if (layout === "wrap") return { cover: false, wrap: true, align: attrs.align === "right" ? "right" : null };
          return { cover: false, wrap: false };
        }),
    };
  },
});

/** What the selected picture has, and what can be done to it; null when none is selected or it is not drawn (a web address). */
export interface PictureInfo {
  /** The width (px) it was given; null when it is as big as it is. */
  width: number | null;
  align: Align;
  wrap: boolean;
  cover: boolean;
}

export function pictureInfo(editor: Editor): PictureInfo | null {
  const found = selectedPicture(editor.state);
  if (!found || !loadsInPage(found.node.attrs.src)) return null;
  const { attrs } = found.node;
  return { width: pictureWidth(attrs.width), align: pictureAlign(attrs), wrap: !!attrs.wrap && !attrs.cover, cover: !!attrs.cover };
}
