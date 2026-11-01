import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Transaction } from "@tiptap/pm/state";

/** Applies `tr` as one undo step of its own, closed off from the change before it and from the one after. */
export function commit(editor: Editor, tr: Transaction): void {
  editor.view.dispatch(closeHistory(tr).setMeta("addToHistory", true));
  // Without this, typing that starts next to the new text within the history's group delay would join the AI's step.
  editor.view.dispatch(closeHistory(editor.state.tr));
}
