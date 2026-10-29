import type { Node as PMNode } from "@tiptap/pm/model";

export interface OutlineEntry {
  text: string;
  level: 1 | 2 | 3;
  /** Position of the heading node in the document. */
  pos: number;
}

/** The document's headings, in order, wherever they sit (lists and quotes included). */
export function outlineOf(doc: PMNode): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    entries.push({ text: node.textContent.trim() || "Untitled", level: node.attrs.level as 1 | 2 | 3, pos });
    return false;
  });
  return entries;
}

/** Counts for the outline footer. `text` has one line break between blocks. */
export function docStats(text: string): { words: number; characters: number; readMinutes: number } {
  const words = (text.match(/\S+/g) ?? []).length;
  return {
    words,
    characters: [...text.replace(/\n/g, "")].length,
    readMinutes: Math.max(1, Math.round(words / 230)),
  };
}

/** The heading the reader is in: the last one whose top (relative to the scroll area) is under 140px. */
export function activeHeading(tops: number[]): number {
  let active = 0;
  tops.forEach((top, i) => {
    if (top < 140) active = i;
  });
  return active;
}

/** The top bar's breadcrumb: the file's folder and name. */
export function crumbs(path: string | null): { folder: string | null; name: string } {
  if (!path) return { folder: null, name: "Untitled" };
  const parts = path.split(/[\\/]/);
  return { folder: parts.at(-2) || null, name: parts.at(-1) || "Untitled" };
}
