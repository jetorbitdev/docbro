import type { Extensions } from "@tiptap/core";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { Strike } from "@tiptap/extension-strike";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

// The one schema every part of DocBro shares: the editor, the headless
// conversions (docx, Markdown, MCP tools) and the tests.
export function createExtensions(): Extensions {
  return [
    StarterKit.configure({
      code: false,
      codeBlock: false,
      strike: false, // replaced below: its Mod-Shift-s is Save As
      blockquote: {},
      horizontalRule: {},
      heading: { levels: [1, 2, 3] },
    }),
    // ⇧⌘X, as in the Format menu; StarterKit's ⇧⌘S would strike the selection on its way to Save As
    Strike.extend({
      addKeyboardShortcuts() {
        return { "Mod-Shift-x": () => this.editor.commands.toggleStrike() };
      },
    }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ allowBase64: true, inline: false }),
    Markdown,
  ];
}
