import type { Editor } from "@tiptap/core";
import type { CommentData } from "../doc/meta";
import type { DocSession } from "../doc/session";
import { commit } from "../editor/history";

/** The cards' heights the mock lays them out with (539–548), when a card has not been measured yet. */
const EDITING_HEIGHT = 170;
const VIEWING_HEIGHT = 118;

export interface CardAnchor {
  id: string;
  /** Where the comment's text starts, in the rail's own coordinates. */
  top: number;
  editing: boolean;
  /** The card's height as drawn, once it has been. */
  height?: number;
}

/**
 * Where each card goes, top to bottom in the order given: level with its text (10px above), unless the card
 * above is still there, in which case it goes `gap` below that one.
 */
export function layoutCards(anchors: CardAnchor[], gap = 12): Record<string, number> {
  const tops: Record<string, number> = {};
  let bottom = -Infinity;
  for (const anchor of anchors) {
    const top = Math.max(anchor.top - 10, bottom + gap);
    tops[anchor.id] = top;
    bottom = top + (anchor.height ?? (anchor.editing ? EDITING_HEIGHT : VIEWING_HEIGHT));
  }
  return tops;
}

// "c" and the time, as the mock names them; two made in the same millisecond still differ.
function newId(comments: CommentData[]): string {
  const taken = new Set(comments.map((c) => c.id));
  let n = Date.now();
  while (taken.has(`c${n}`)) n++;
  return `c${n}`;
}

/**
 * Puts a new comment on `from`..`to`: the mark as one undo step, and its entry in the session's meta. Returns its id.
 * `editing` opens its card's text box.
 */
export function commentOn(
  editor: Editor,
  session: DocSession,
  range: { from: number; to: number },
  comment: { author: string; text: string; editing?: boolean },
): string {
  const id = newId(session.meta.comments);
  commit(editor, editor.state.tr.addMark(range.from, range.to, editor.schema.marks.comment.create({ id })));
  const entry: CommentData = { id, author: comment.author, date: new Date().toISOString(), text: comment.text };
  session.setMeta({ comments: [...session.meta.comments, comment.editing ? { ...entry, editing: true } : entry] });
  return id;
}

/** A comment by `author` on the selected text, with its card open for typing; null when no text is selected. */
export function addComment(editor: Editor, session: DocSession, author: string): string | null {
  const { from, to, empty } = editor.state.selection;
  if (empty || editor.state.doc.textBetween(from, to, " ").trim() === "") return null;
  return commentOn(editor, session, { from, to }, { author, text: "", editing: true });
}

/**
 * Takes the comment's mark off its text, as one undo step. The entry stays, so undo brings the comment back with its
 * text: as posted, unless nothing was written yet.
 */
export function resolveComment(editor: Editor, session: DocSession, id: string): void {
  const comments = session.meta.comments;
  if (comments.some((c) => c.id === id && c.editing && c.text.trim()))
    session.setMeta({ comments: comments.map((c) => (c.id === id ? { ...c, editing: false } : c)) });
  const { tr } = editor.state;
  commit(editor, tr.removeMark(0, tr.doc.content.size, editor.schema.marks.comment.create({ id })));
}

const MINUTE = 60_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** How long ago `iso` was, as the mock's cards put it ("now", "40m", "2h", "3d"), then the date; "" for no date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor((now - at) / MINUTE);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`;
  const date = new Date(at);
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}
