import type { Editor } from "@tiptap/core";
import { AllSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { commit } from "../editor/history";
import { markdownToDoc } from "../formats/markdown";

/** How long inserted blocks stay tinted (mock 480–486). */
const FLASH_MS = 1200;

/**
 * "Insert into doc": the answer's Markdown as blocks after the block that holds the selection,
 * or at the end when the selection is no place in particular (all of the document). One undo
 * step, like a tool call. The new blocks end up selected, so `flashSelection` can show them.
 */
export function insertAssistantText(editor: Editor, text: string): void {
  const blocks = editor.schema.nodeFromJSON(markdownToDoc(text)).content;
  if (!blocks.size) return;
  const { doc, selection } = editor.state;
  const last = doc.lastChild!;
  const emptyLast = last.type.name === "paragraph" && last.content.size === 0;
  const { tr } = editor.state;
  let at: number;
  if (doc.childCount === 1 && emptyLast) {
    // an empty document: the answer takes the place of its empty line
    at = 0;
    tr.replaceWith(0, doc.content.size, blocks);
  } else {
    const $end = selection.$to;
    if (selection instanceof AllSelection) at = doc.content.size - (emptyLast ? last.nodeSize : 0);
    // between two blocks (a selected image, a gap cursor) or inside one
    else at = $end.depth === 0 ? $end.pos : $end.after(1);
    tr.insert(at, blocks);
  }
  tr.setSelection(TextSelection.between(tr.doc.resolve(at), tr.doc.resolve(at + blocks.size))).scrollIntoView();
  commit(editor, tr);
}

const flashKey = new PluginKey<DecorationSet>("assistantFlash");

const flashPlugin = new Plugin<DecorationSet>({
  key: flashKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const range: { from: number; to: number } | null | undefined = tr.getMeta(flashKey);
      if (range === undefined) return set.map(tr.mapping, tr.doc);
      if (!range) return DecorationSet.empty;
      const marks: Decoration[] = [];
      tr.doc.nodesBetween(range.from, range.to, (node, pos) => {
        marks.push(Decoration.node(pos, pos + node.nodeSize, { class: "assistant-flash" }));
        return false; // top-level blocks only
      });
      return DecorationSet.create(tr.doc, marks);
    },
  },
  props: { decorations: (state) => flashKey.getState(state) },
});

/** Tints the top-level blocks the selection covers for a moment. */
export function flashSelection(editor: Editor): void {
  if (editor.isDestroyed) return;
  if (!flashKey.getState(editor.state)) editor.registerPlugin(flashPlugin);
  const { from, to } = editor.state.selection;
  editor.view.dispatch(editor.state.tr.setMeta(flashKey, { from, to }).setMeta("addToHistory", false));
  window.setTimeout(() => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(flashKey, null).setMeta("addToHistory", false));
  }, FLASH_MS);
}
