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
  editLoses?: "other_content"[];
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
    if (node.type === "field") return void (lines[lines.length - 1] += node.attrs?.text ?? "");
    if (node.type === "paragraph" || node.type === "heading") lines.push("");
    (node.content ?? []).forEach(walk);
  };
  walk(part.view ?? { type: "doc" });
  return lines.filter((line) => line.trim() !== "").join("\n");
}

/** The question to ask before a kept part is edited, when editing it would lose something; null when nothing is lost. */
export function editWarning(part: KeptPart, kind: "header" | "footer"): string | null {
  if (!(part.editLoses ?? []).includes("other_content")) return null;
  return `This ${kind} has content DocBro can't show, such as a text box. Editing it leaves that out. Edit it anyway?`;
}

// ------------------------------------------------------------------ every header and footer, shown and edited one way

export type Zone = "header" | "footer";

const line = (content: JSONContent[] = [], textAlign: string | null = null): JSONContent => ({ type: "paragraph", attrs: { textAlign }, content });
const field = (instr: string): JSONContent => ({ type: "field", attrs: { instr, text: "1" } });
// What page numbers look like on the page, and what an edit has to leave of them to stay the footer's toggle.
const PAGE_LINE = line([{ type: "text", text: "Page " }, field("PAGE"), { type: "text", text: " of " }, field("NUMPAGES")], "right");

/** The header or footer as a document to show and edit: a kept part's blocks, or a text one as a line; null when there is none. */
export function zoneView(meta: DocMeta, kind: Zone): JSONContent | null {
  const part = kind === "header" ? meta.headerPart : meta.footerPart;
  if (part) return part.view;
  const text = kind === "header" ? meta.header : meta.footer;
  const pageNumbers = kind === "footer" && meta.pageNumbers;
  if (text === null && !pageNumbers) return null;
  const content: JSONContent[] = [];
  if (text || !pageNumbers) content.push(line(text ? [{ type: "text", text }] : []));
  if (pageNumbers) content.push(PAGE_LINE);
  return { type: "doc", content };
}

// The text of a paragraph of plain, unformatted text, left as it falls; null for anything more.
function plainLine(node: JSONContent | undefined): string | null {
  if (node?.type !== "paragraph" || node.attrs?.textAlign) return null;
  const content = node.content ?? [];
  if (content.some((n) => n.type !== "text" || n.marks?.length)) return null;
  return content.map((n) => n.text).join("");
}

const isPageLine = (node: JSONContent | undefined) => !!node && JSON.stringify(line(node.content, node.attrs?.textAlign ?? null)) === JSON.stringify(PAGE_LINE);

/** What an edited header or footer is kept as: still the text zone when it is a line of plain text (and page numbers), else a part. */
export function zonePatch(kind: Zone, view: JSONContent): Partial<DocMeta> {
  const blocks = view.content ?? [];
  const asPart: KeptPart = { xml: null, rels: null, media: {}, view, editLoses: [] };
  if (kind === "header") {
    const text = blocks.length === 1 ? plainLine(blocks[0]) : null;
    return text === null ? { header: null, headerPart: asPart } : { header: text, headerPart: null };
  }
  const pageNumbers = isPageLine(blocks[blocks.length - 1]);
  const rest = pageNumbers ? blocks.slice(0, -1) : blocks;
  const text = rest.length === 0 && pageNumbers ? "" : rest.length === 1 ? plainLine(rest[0]) : null;
  return text === null ? { footer: null, pageNumbers: false, footerPart: asPart } : { footer: text, pageNumbers, footerPart: null };
}
