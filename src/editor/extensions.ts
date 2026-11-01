import { Extension, type Extensions } from "@tiptap/core";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { Strike } from "@tiptap/extension-strike";
import { Table, TableCell, TableHeader, TableRow, TableView } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { Color, FontFamily, TextStyle } from "@tiptap/extension-text-style";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import type { Spacing } from "../doc/meta";
import { spacingStyle } from "../layout/look";
import { inkOn, isAutomaticColor } from "./automaticColor";
import { CommentMark } from "./comment";
import { Field } from "./field";
import { firstFamily, fontName, fontStack } from "./fonts";
import { PageBreak } from "./pageBreak";

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

// A picture that is a whole page of its own: a cover. Word pins it to the page behind the text; here it fills
// its sheet edge to edge and the next block starts on a new page (layout/pagination.ts).
const CoverImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      cover: {
        default: false,
        parseHTML: (element: HTMLElement) => element.hasAttribute("data-cover"),
        renderHTML: (attributes: Record<string, unknown>) => (attributes.cover ? { "data-cover": "" } : {}),
      },
    };
  },
});

// A cell's fill, from the file's cell shading: drawn with the text color that reads on it.
const cellBackground = {
  background: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-background"),
    renderHTML: (attributes: Record<string, unknown>) => {
      const background = attributes.background;
      if (typeof background !== "string") return {};
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
class IndentedTableView extends TableView {
  constructor(...args: ConstructorParameters<typeof TableView>) {
    super(...args);
    this.indent();
  }
  update(node: ConstructorParameters<typeof TableView>[0]): boolean {
    const same = super.update(node);
    if (same) this.indent();
    return same;
  }
  private indent() {
    this.table.style.marginLeft = this.node.attrs.indent ? `${this.node.attrs.indent}px` : "";
  }
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
    Highlight.configure({ multicolor: true }),
    CommentMark,
    IndentedTable.configure({ resizable: true, View: IndentedTableView }),
    TableRow,
    FilledHeader,
    FilledCell,
    CoverImage.configure({ allowBase64: true, inline: false }),
    PageBreak,
    Field,
    Markdown,
  ];
}
