import { Extension, type Extensions } from "@tiptap/core";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { Strike } from "@tiptap/extension-strike";
import { Table, TableCell, TableHeader, TableView } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { Color, FontFamily, TextStyle } from "@tiptap/extension-text-style";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import type { Spacing } from "../doc/meta";
import { spacingStyle } from "../layout/look";
import { inkOn, isAutomaticColor } from "./automaticColor";
import { CommentMark } from "./comment";
import { Field } from "./field";
import { firstFamily, fontName, fontStack, sizeOf, sizeStyle, validSize } from "./fonts";
import { PageBreak } from "./pageBreak";
import { PictureTools, pictureAttributes } from "./pictureTools";
import { SizedRow, TableTools } from "./tableTools";
import { REMOTE_SRC, loadsInPage, remotePicture } from "./pictureSource";

// Pasted text brings its source's black or white as a color mark, and a mark stays where a theme change would
// have turned the default text light. Those colors are dropped as the HTML is read; the rest are kept as they came.
const PastedColor = Color.extend({
  addGlobalAttributes() {
    return (this.parent?.() ?? []).map((group) => {
      const original = group.attributes.color?.parseHTML;
      return {
        ...group,
        attributes: {
          ...group.attributes,
          color: {
            ...group.attributes.color,
            parseHTML: (element: HTMLElement) => {
              const value = original?.(element);
              return typeof value === "string" && isAutomaticColor(value) ? null : value;
            },
          },
        },
      };
    });
  },
});

// A typeface is kept by its name (what a .docx stores) and drawn with a stack that has a fallback behind it. The name is the
// first face of a pasted `font-family`; a system or generic one is not a choice, so it leaves the text in the page's own.
const Typeface = FontFamily.extend({
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        fontFamily: {
          default: null,
          parseHTML: (element: HTMLElement) => firstFamily(element.style.fontFamily),
          renderHTML: (attributes: Record<string, unknown>) => {
            const name = fontName(attributes.fontFamily);
            return name ? { style: `font-family: ${fontStack(name)}` } : {};
          },
        },
      },
    }];
  },
});

// A size is kept in points, as Word has it, and drawn as that many of the page's points (`--pt`), which a .docx page scales
// to its sheet. It is set with `setMark("textStyle", { fontSize })` (layout/blocks.ts `applySize`).
const Typesize = Extension.create({
  name: "typesize",
  addGlobalAttributes() {
    return [{
      types: ["textStyle"],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (element: HTMLElement) => sizeOf(element.style.fontSize),
          renderHTML: (attributes: Record<string, unknown>) => {
            const size = validSize(attributes.fontSize);
            return size ? { style: `font-size: ${sizeStyle(size)}` } : {};
          },
        },
      },
    }];
  },
});

// A picture that is a whole page of its own: a cover. Word pins it to the page behind the text; here it fills
// its sheet edge to edge and the next block starts on a new page (layout/pagination.ts). Otherwise it has the size,
// the place on its line and the wrapping of the text that editor/pictureTools.ts sets.
const CoverImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...pictureAttributes,
      cover: {
        default: false,
        parseHTML: (element: HTMLElement) => element.hasAttribute("data-cover"),
        renderHTML: (attributes: Record<string, unknown>) => (attributes.cover ? { "data-cover": "" } : {}),
      },
    };
  },
  // A picture is only drawn from a data or blob URL. One that points at the web is not fetched: it is drawn as its alt
  // text and its address, and the node keeps the address (pictureSource.ts). Every draw of a picture goes through here:
  // the editor, a kept header or footer, a copied selection.
  renderHTML({ node, HTMLAttributes }) {
    const src = node.attrs.src;
    if (loadsInPage(src)) return this.parent?.({ node, HTMLAttributes }) ?? ["img", HTMLAttributes];
    return remotePicture(typeof src === "string" ? src : "", node.attrs.alt);
  },
  parseHTML() {
    const placeholder = {
      tag: `span[${REMOTE_SRC}]`,
      getAttrs: (element: HTMLElement | string) => {
        if (typeof element === "string") return false;
        const src = element.getAttribute(REMOTE_SRC);
        return src ? { src, alt: element.getAttribute("data-alt") || null } : false;
      },
    };
    return [...(this.parent?.() ?? []), placeholder];
  },
});

// A cell's fill, from the file's cell shading: drawn with the text color that reads on it. It is a "#rrggbb" and nothing
// else, because it goes into a style: pasted HTML must not be able to add `url(...)` there and make the window fetch it.
const isFill = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const cellBackground = {
  background: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const fill = element.getAttribute("data-background");
      return isFill(fill) ? fill : null;
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      const background = attributes.background;
      if (!isFill(background)) return {};
      const ink = inkOn(background);
      return { "data-background": background, style: `background-color: ${background}${ink ? `; color: ${ink}` : ""}` };
    },
  },
};
const FilledCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellBackground };
  },
});
const FilledHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellBackground };
  },
});

// A table set in from the left edge of the text, as the file had it (`w:tblInd`), in px.
const IndentedTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: {
        default: 0,
        parseHTML: (element: HTMLElement) => Number(element.getAttribute("data-indent")) || 0,
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.indent ? { "data-indent": attributes.indent, style: `margin-left: ${attributes.indent}px` } : {},
      },
    };
  },
});
// The editor draws a table through this view; the attributes above only reach the HTML written out.
// Its widths and its indent, the file's in px, are drawn at the scale of the sheet (`--look-scale`, layout/look.ts) as its
// text is, so in a narrow window the table shrinks with the page instead of running off it.
class IndentedTableView extends TableView {
  private observer?: MutationObserver;
  constructor(...args: ConstructorParameters<typeof TableView>) {
    super(...args);
    this.indent();
    this.scale();
    // dragging a column border writes its width in px straight to the table (prosemirror-tables); it is scaled before it is drawn
    if (typeof MutationObserver !== "undefined") {
      this.observer = new MutationObserver(() => this.scale());
      this.observer.observe(this.table, { attributes: true, attributeFilter: ["style"] });
      this.observer.observe(this.colgroup, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });
    }
  }
  update(node: ConstructorParameters<typeof TableView>[0]): boolean {
    const same = super.update(node);
    if (same) {
      this.indent();
      this.scale();
    }
    return same;
  }
  destroy() {
    this.observer?.disconnect();
  }
  private indent() {
    this.table.style.marginLeft = this.node.attrs.indent ? `calc(${this.node.attrs.indent}px * var(--look-scale, 1))` : "";
  }
  private scale() {
    for (const el of [this.table, ...Array.from(this.colgroup.children)] as HTMLElement[]) {
      scaledPx(el.style, "width");
      scaledPx(el.style, "min-width");
    }
  }
}

// A width in px becomes that many px at the sheet's scale; one already scaled is left as it is, so this can run again.
function scaledPx(style: CSSStyleDeclaration, property: string) {
  const px = /^(\d+(?:\.\d+)?)px$/.exec(style.getPropertyValue(property));
  if (px) style.setProperty(property, `calc(${px[1]}px * var(--look-scale, 1))`);
}

// The spacing a paragraph from a .docx has of its own, where it differs from the file's (doc/meta.ts `Spacing`, in twips),
// and the indent of its first line.
// The page draws it only for a document set as its file (layout/look.ts); a new line keeps it, as in Word.
const ParagraphSpacing = Extension.create({
  name: "paragraphSpacing",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading"],
      attributes: {
        spacing: {
          default: null,
          parseHTML: (element: HTMLElement) => {
            try {
              const spacing = JSON.parse(element.getAttribute("data-spacing") ?? "null");
              return spacing && typeof spacing === "object" ? spacing : null;
            } catch {
              return null;
            }
          },
          renderHTML: (attributes: Record<string, unknown>) => {
            const spacing = attributes.spacing as Spacing | null;
            return spacing ? { "data-spacing": JSON.stringify(spacing), style: spacingStyle(spacing) } : {};
          },
        },
        // how far the first line is set in from the rest, in twips; a hanging one is less than 0
        firstLine: {
          default: null,
          parseHTML: (element: HTMLElement) => Number(element.getAttribute("data-first-line")) || null,
          renderHTML: (attributes: Record<string, unknown>) =>
            attributes.firstLine ? { "data-first-line": attributes.firstLine, style: `--p-first: ${Number(attributes.firstLine) / 20}` } : {},
        },
      },
    }];
  },
});

// The one schema every part of DocBro shares: the editor, the headless
// conversions (docx, Markdown, MCP tools) and the tests. `trailingNode: false` is for
// an editor whose last block is the writer's own, such as a header (layout/PartEditor.tsx).
export function createExtensions({ trailingNode = true }: { trailingNode?: boolean } = {}): Extensions {
  return [
    StarterKit.configure({
      code: false,
      codeBlock: false,
      strike: false, // replaced below: its Mod-Shift-s is Save As
      blockquote: {},
      horizontalRule: {},
      heading: { levels: [1, 2, 3] },
      // a click on a link puts the caret in it; opening it would navigate the window away from the document
      link: { openOnClick: false },
      ...(!trailingNode && { trailingNode: false }),
    }),
    // ⇧⌘X, as in the Format menu; StarterKit's ⇧⌘S would strike the selection on its way to Save As
    Strike.extend({
      addKeyboardShortcuts() {
        return { "Mod-Shift-x": () => this.editor.commands.toggleStrike() };
      },
    }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    ParagraphSpacing,
    TextStyle,
    PastedColor,
    Typeface,
    Typesize,
    Highlight.configure({ multicolor: true }),
    CommentMark,
    IndentedTable.configure({ resizable: true, View: IndentedTableView }),
    SizedRow,
    TableTools,
    FilledHeader,
    FilledCell,
    CoverImage.configure({ allowBase64: true, inline: false }),
    PictureTools,
    PageBreak,
    Field,
    Markdown,
  ];
}
