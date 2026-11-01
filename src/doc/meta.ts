import type { JSONContent } from "@tiptap/core";

export interface CommentData {
  id: string;
  author: string;
  date: string; // ISO
  text: string;
  editing?: boolean;
}

/** 1440 twips to the inch and 96 px to the inch. */
export const TWIPS_PER_PX = 15;

export type PageSize = "letter" | "a4";

/** The paper in twips (1/20 pt), as Word writes `w:pgSz`; the page layout takes its proportions from it. */
export const PAPER: Record<PageSize, { width: number; height: number }> = {
  letter: { width: 12240, height: 15840 },
  a4: { width: 11906, height: 16838 },
};

/**
 * A header or footer that does not fit the one-line text zone (several paragraphs, a logo, a rule, fields). DocBro
 * keeps it as the file had it and writes it back unchanged, and shows `view` on the page. Once it is edited, `view`
 * is what it is: `xml` is null and the part is written from `view`.
 */
export interface KeptPart {
  /** The part's XML, as the file had it; null once it has been edited. */
  xml: string | null;
  /** The part's relationships, with its pictures renamed to the keys of `media`; null when it has none. */
  rels: string | null;
  /** The pictures it uses, as base64, by the file name they are written under in `word/media/`. */
  media: Record<string, string>;
  /** What the page shows of it; null when it could not be turned into a document. */
  view: JSONContent | null;
  /** What `view` lacks of the file's part, which editing turns into plain text or leaves out. */
  editLoses?: ("fields" | "other_content")[];
}

export interface DocMeta {
  comments: CommentData[];
  header: string | null;
  footer: string | null;
  pageNumbers: boolean;
  pageSize: PageSize;
  /** Set instead of `header` / `footer` when the file's one does not fit a line. Never both. */
  headerPart: KeptPart | null;
  footerPart: KeptPart | null;
}

export const emptyMeta = (): DocMeta => ({
  comments: [], header: null, footer: null, pageNumbers: false, pageSize: "letter", headerPart: null, footerPart: null,
});

/** The text of a kept part, one line per block; null when there is no part. */
export function partText(part: KeptPart | null): string | null {
  if (!part) return null;
  const lines: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "text") return void (lines[lines.length - 1] += node.text ?? "");
    if (node.type === "paragraph" || node.type === "heading") lines.push("");
    (node.content ?? []).forEach(walk);
  };
  walk(part.view ?? { type: "doc" });
  return lines.filter((line) => line.trim() !== "").join("\n");
}

/** The question to ask before a kept part is edited, when editing it would lose something; null when nothing is lost. */
export function editWarning(part: KeptPart, kind: "header" | "footer"): string | null {
  const loses = part.editLoses ?? [];
  const fields = loses.includes("fields");
  const other = loses.includes("other_content");
  if (fields && other)
    return `This ${kind} has fields, such as page numbers or dates, and content DocBro can't show. Editing it turns the fields into plain text and leaves the rest out. Edit it anyway?`;
  if (fields) return `This ${kind} has fields, such as page numbers or dates. Editing it turns them into plain text. Edit it anyway?`;
  if (other) return `This ${kind} has content DocBro can't show. Editing it leaves that out. Edit it anyway?`;
  return null;
}
