import { Fragment, type Mark, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

/**
 * The find and replace engine: pure functions over ProseMirror documents and states, with no React
 * and no DOM, so the Find bar and the MCP `find_replace` tool run the same code.
 *
 * What a match is:
 * - A match lies inside one textblock (a paragraph or heading, wherever it sits: in a table cell, a
 *   list item or a quote) and never crosses a block boundary.
 * - Inside a textblock, matching sees one uninterrupted run of text. Marks do not interrupt it, so
 *   "he" + bold "llo" matches "hello". A hard break does: it counts as the newline it stands for, and a
 *   query cannot contain one, so no match spans it.
 * - The query is literal text. Matches are found from left to right and never overlap ("aa" in
 *   "aaaa" gives two). Case is ignored unless `caseSensitive`, by Unicode simple case folding, which
 *   never changes the length of the text, so positions stay exact (and an emoji is never split).
 */

export interface FindOptions {
  /** Default false: "É" finds "é". */
  caseSensitive?: boolean;
  /** Search only the text between these ProseMirror positions; a match must lie wholly inside. */
  from?: number;
  to?: number;
}

export interface FindMatch {
  from: number;
  to: number;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** All matches of `query` in `doc`, in document order; `[]` for an empty query. */
export function findAll(doc: PMNode, query: string, opts: FindOptions = {}): FindMatch[] {
  if (!query) return [];
  const from = Math.max(opts.from ?? 0, 0);
  const to = Math.min(opts.to ?? doc.content.size, doc.content.size);
  if (from >= to) return [];
  // `u` makes the pattern work on whole characters (a lone half of an emoji matches nothing) and
  // makes `i` fold case by simple folding; both keep every index a UTF-16 index, as ProseMirror counts.
  const pattern = new RegExp(escapeRegExp(query), opts.caseSensitive ? "gu" : "giu");
  const found: FindMatch[] = [];

  const scan = (start: number, text: string) => {
    const lo = Math.max(from, start);
    const hi = Math.min(to, start + text.length);
    if (lo >= hi) return;
    for (const m of text.slice(lo - start, hi - start).matchAll(pattern)) {
      found.push({ from: lo + m.index, to: lo + m.index + m[0].length });
    }
  };

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    let start = -1; // where the current run of text begins, or -1 between runs
    let text = "";
    const flush = () => {
      if (start >= 0) scan(start, text);
      start = -1;
      text = "";
    };
    node.forEach((child, offset) => {
      if (!child.isText) return flush();
      if (start < 0) start = pos + 1 + offset;
      text += child.text;
    });
    flush();
    return false;
  });
  return found;
}

/** The replacement as inline content wearing `marks`; a newline in it becomes a hard break. */
function inlineContent(schema: Schema, text: string, marks: readonly Mark[]): Fragment {
  const hardBreak = schema.nodes.hardBreak;
  if (!hardBreak) return text ? Fragment.from(schema.text(text, marks)) : Fragment.empty;
  const nodes: PMNode[] = [];
  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    if (i > 0) nodes.push(hardBreak.create(null, null, marks));
    if (line) nodes.push(schema.text(line, marks));
  });
  return Fragment.fromArray(nodes);
}

/** Replaces one range inside `tr`, in the marks of the range's first character. */
function replaceRange(tr: Transaction, { from, to }: FindMatch, replacement: string): void {
  const marks = tr.doc.resolve(from).nodeAfter?.marks ?? [];
  tr.replaceWith(from, to, inlineContent(tr.doc.type.schema, replacement, marks));
}

/**
 * One transaction (so one undo step) that replaces every match with `replacement`, taken literally,
 * each in the marks of its first character; `null` when nothing matches. The matches are found once,
 * on the document as it is, so a replacement that contains the query is not replaced again.
 */
export function replaceAll(state: EditorState, query: string, replacement: string, opts?: FindOptions): Transaction | null {
  const matches = findAll(state.doc, query, opts);
  if (!matches.length) return null;
  const tr = state.tr;
  // last match first: an edit then only moves text after it, so the positions still to do stay right
  for (let i = matches.length - 1; i >= 0; i--) replaceRange(tr, matches[i], replacement);
  return tr;
}

/** Replaces one match, as `replaceAll` does. */
export function replaceOne(state: EditorState, match: FindMatch, replacement: string): Transaction {
  const tr = state.tr;
  replaceRange(tr, match, replacement);
  return tr;
}

const MAX_SEED = 200;

/** The text to put in the find field when it opens: the selection, if it is a short piece of one line. */
export function seedQuery(state: EditorState): string {
  const { empty, from, to, $from, $to } = state.selection;
  if (empty || !$from.parent.isTextblock || !$from.sameParent($to) || to - from > MAX_SEED) return "";
  const text = state.doc.textBetween(from, to, "\n", "\n");
  return text.includes("\n") || !text.trim() ? "" : text;
}
