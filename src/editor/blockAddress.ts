import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Blocks as the MCP tools number them: the document's top-level nodes, counted from 1. A list, a
 * quote or a table is one block however many paragraphs it holds.
 */
export function blockCount(doc: PMNode): number {
  return doc.childCount;
}

/**
 * The ProseMirror positions around blocks `from` to `to` (1-based, both included): `from` is where
 * block `from` starts and `to` is where block `to` ends.
 */
export function blockRange(doc: PMNode, from: number, to: number): { from: number; to: number } {
  const count = doc.childCount;
  for (const n of [from, to]) {
    if (!Number.isInteger(n) || n < 1 || n > count) {
      throw new Error(`Block ${n} does not exist. The document has ${count} ${count === 1 ? "block" : "blocks"}.`);
    }
  }
  if (from > to) throw new Error("to must not be before from.");
  let pos = 0;
  let start = 0;
  for (let i = 0; i < to; i++) {
    if (i === from - 1) start = pos;
    pos += doc.child(i).nodeSize;
  }
  return { from: start, to: pos };
}
