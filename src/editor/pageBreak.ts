import { Node } from "@tiptap/core";

/**
 * A hard page break: the block after it starts on a new page. It is a block of its own so that it
 * survives a .docx round trip; the page layout (pagination.ts) reads it, and in print it ends the page.
 */
export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: "div[data-page-break]" }];
  },

  renderHTML() {
    return ["div", { "data-page-break": "" }, ["span", {}, "Page break"]];
  },

  // Markdown has no page break, so the file keeps the HTML a reader would use for one. Only that exact
  // line is read back as a break; any other HTML stays whatever the Markdown package makes of it.
  markdownTokenName: "pageBreak",
  markdownTokenizer: {
    name: "pageBreak",
    level: "block",
    start: (src: string) => src.indexOf("<div data-page-break"),
    tokenize: (src: string) => {
      const match = /^<div data-page-break><\/div>[ \t]*(?:\n|$)/.exec(src);
      return match ? { type: "pageBreak", raw: match[0] } : undefined;
    },
  },
  parseMarkdown: (_token, helpers) => helpers.createNode("pageBreak"),
  renderMarkdown: () => "<div data-page-break></div>",
});
