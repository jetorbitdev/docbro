import type { Extensions } from "@tiptap/core";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { Strike } from "@tiptap/extension-strike";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { isAutomaticColor } from "./automaticColor";
import { Field } from "./field";
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
    TextStyle,
    PastedColor,
    Highlight.configure({ multicolor: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    CoverImage.configure({ allowBase64: true, inline: false }),
    PageBreak,
    Field,
    Markdown,
  ];
}
