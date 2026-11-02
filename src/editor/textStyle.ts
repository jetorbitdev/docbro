import type { EditorState } from "@tiptap/pm/state";
import { fontName, validSize } from "./fonts";

/** More than one typeface or size in the selection. */
export const MIXED = "mixed";

export interface TypeStyle {
  /** The typeface and the size in points the selection is set in: null where nothing sets one, `MIXED` where it varies. */
  font: string | null | typeof MIXED;
  size: number | null | typeof MIXED;
}

/** The typeface and size of the selection: of the text it covers, or at a caret, of what is typed next. */
export function typeStyleAt(state: EditorState): TypeStyle {
  const { selection, doc } = state;
  const fonts = new Set<string | null>();
  const sizes = new Set<number | null>();
  const take = (marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[]) => {
    const style = marks.find((m) => m.type.name === "textStyle");
    fonts.add(fontName(style?.attrs.fontFamily));
    sizes.add(validSize(style?.attrs.fontSize));
  };
  if (selection.empty) take(state.storedMarks ?? selection.$from.marks());
  else
    doc.nodesBetween(selection.from, selection.to, (node) => {
      if (node.isText) take(node.marks);
    });
  const one = <T,>(set: Set<T>): T | typeof MIXED => (set.size > 1 ? MIXED : [...set][0] ?? (null as T));
  return { font: one(fonts), size: one(sizes) };
}
