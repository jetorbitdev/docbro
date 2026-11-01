import { Node } from "@tiptap/core";

/** The first word of a field's instruction, upper-cased: "PAGE", "NUMPAGES", "DATE", … */
export const fieldName = (instr: string) => (instr.trim().split(/\s+/)[0] ?? "").toUpperCase();

/**
 * A Word field in a header or footer: its instruction ("PAGE", "DATE \@ …") and the value it last showed. The page
 * draws PAGE and NUMPAGES with the number of the sheet and of all sheets (layout/PartView.tsx); Word works out
 * every field again when it opens the file.
 */
export const Field = Node.create({
  name: "field",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { instr: { default: "" }, text: { default: "" } };
  },

  parseHTML() {
    return [{ tag: "span[data-field]", getAttrs: (el) => ({ instr: el.getAttribute("data-field") ?? "", text: el.textContent ?? "" }) }];
  },

  renderHTML({ node }) {
    return ["span", { "data-field": node.attrs.instr, class: "field" }, node.attrs.text || "#"];
  },

  renderText: ({ node }) => node.attrs.text,
});
