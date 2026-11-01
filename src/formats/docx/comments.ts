import type { JSONContent } from "@tiptap/core";
import { CommentRangeEnd, CommentRangeStart, CommentReference, Paragraph, TextRun, type ICommentOptions } from "docx";
import type { CommentData } from "../../doc/meta";
import { attr, children, descendants, is } from "./xml";

// Word comments, both ways. In the file a comment is an entry in word/comments.xml and, in the text, a range
// (w:commentRangeStart … w:commentRangeEnd) followed by a run with its w:commentReference. In DocBro it is a
// `comment` mark on the text and an entry in `DocMeta.comments` (editor/comment.ts).

type Mark = NonNullable<JSONContent["marks"]>[number];

// ------------------------------------------------------------------ reading

/** A comment of word/comments.xml, with the thread it is in from word/commentsExtended.xml. */
export interface WordComment {
  /** `w:id`, which the text's range and reference name */
  wordId: string;
  /** what DocBro calls it */
  id: string;
  author: string;
  date: string;
  text: string;
  /** the `wordId` of the comment it replies to */
  parent: string | null;
  /** marked done in Word, itself or its thread */
  resolved: boolean;
}

const on = (value: string | null) => ["1", "true", "on"].includes((value ?? "").toLowerCase());

// The text of one of a comment's paragraphs, with its tabs and line breaks.
function paragraphText(p: Element): string {
  let text = "";
  for (const el of descendants(p, "w:*")) {
    if (is(el, "w:t")) text += el.textContent ?? "";
    else if (is(el, "w:tab")) text += "\t";
    else if (is(el, "w:br") || is(el, "w:cr")) text += "\n";
  }
  return text;
}

/** The comments the file has, in its order; a reply is a comment of its own, which knows the one it answers. */
export function wordComments(comments: Document | null, extended: Document | null): WordComment[] {
  const root = comments?.documentElement;
  if (!root || !is(root, "w:comments")) return [];
  // A reply and a resolved thread are told by the paragraph id of the comment's last paragraph.
  const threads = new Map<string, { parent: string | null; done: boolean }>();
  for (const ex of children(extended?.documentElement, "w15:commentEx")) {
    const paraId = attr(ex, "w15:paraId");
    if (paraId) threads.set(paraId.toUpperCase(), { parent: attr(ex, "w15:paraIdParent")?.toUpperCase() ?? null, done: on(attr(ex, "w15:done")) });
  }

  const seen = new Set<string>();
  const read = children(root, "w:comment").flatMap((el, index) => {
    const wordId = attr(el, "w:id");
    if (wordId === null || seen.has(wordId)) return [];
    seen.add(wordId);
    const paragraphs = descendants(el, "w:p");
    const paraId = attr(paragraphs[paragraphs.length - 1], "w14:paraId")?.toUpperCase() ?? null;
    const text = paragraphs.map(paragraphText).join("\n").replace(/\s+$/, "");
    return [{ wordId, id: `w${index}`, author: attr(el, "w:author") ?? "", date: attr(el, "w:date") ?? "", text, paraId }];
  });

  const byParaId = new Map(read.flatMap((c) => (c.paraId ? [[c.paraId, c] as const] : [])));
  return read.map(({ paraId, ...comment }) => {
    const thread = paraId ? threads.get(paraId) : undefined;
    const parent = thread?.parent ? byParaId.get(thread.parent) : undefined;
    const parentDone = parent?.paraId ? threads.get(parent.paraId)?.done : false;
    return { ...comment, parent: parent?.wordId ?? null, resolved: !!thread?.done || !!parentDone };
  });
}

/** What the walk over the text keeps track of: the comments whose range it is in, and what it has seen of each. */
export interface CommentWalk {
  comments: WordComment[];
  byWordId: Map<string, WordComment>;
  /** DocBro ids of the comments whose range is open where the walk is */
  open: string[];
  /** DocBro ids of the comments some text was marked with */
  marked: Set<string>;
  /** the comments the text refers to, by a range or a reference */
  anchored: Set<string>;
}

export const commentWalk = (comments: WordComment[]): CommentWalk => ({
  comments,
  byWordId: new Map(comments.map((c) => [c.wordId, c])),
  open: [],
  marked: new Set(),
  anchored: new Set(),
});

/**
 * Takes a range's start or end, or a reference, as the walk comes to it; true when `el` was one. A resolved comment
 * gets no mark: DocBro shows the open ones.
 */
export function commentEdge(el: Element, walk: CommentWalk | undefined): boolean {
  const start = is(el, "w:commentRangeStart");
  if (!start && !is(el, "w:commentRangeEnd") && !is(el, "w:commentReference")) return false;
  const comment = walk?.byWordId.get(attr(el, "w:id") ?? "");
  if (!walk || !comment) return true;
  walk.anchored.add(comment.wordId);
  if (is(el, "w:commentReference")) return true;
  walk.open = walk.open.filter((id) => id !== comment.id);
  if (start && !comment.resolved) walk.open.push(comment.id);
  return true;
}

/** The marks of the comments whose range the walk is in. */
export const openCommentMarks = (walk: CommentWalk | undefined): Mark[] =>
  (walk?.open ?? []).map((id) => ({ type: "comment", attrs: { id } }));

// Puts comment `id` on every node that has comment `on`.
function markAlong(nodes: JSONContent[], on: string, id: string): void {
  for (const node of nodes) {
    if (node.marks?.some((m) => m.type === "comment" && m.attrs?.id === on)) node.marks = [...node.marks, { type: "comment", attrs: { id } }];
    if (node.content) markAlong(node.content, on, id);
  }
}

/**
 * The comments the document keeps, once the walk is done: those with marked text, and a reply with no range of its
 * own over the text of the comment it answers (Word draws a thread as one). `resolved` and `onNoText` say the text
 * has comments DocBro cannot show: resolved ones, and ones on no text (a reference alone, or an empty range). A
 * comment the text never refers to Word does not show either.
 */
export function settleComments(content: JSONContent[], walk: CommentWalk): { comments: CommentData[]; resolved: boolean; onNoText: boolean } {
  const out = { comments: [] as CommentData[], resolved: false, onNoText: false };
  for (const c of walk.comments) {
    if (!walk.anchored.has(c.wordId)) continue;
    if (c.resolved) {
      out.resolved = true;
      continue;
    }
    const parent = c.parent !== null ? walk.byWordId.get(c.parent) : undefined;
    if (!walk.marked.has(c.id) && parent && walk.marked.has(parent.id)) markAlong(content, parent.id, c.id);
    else if (!walk.marked.has(c.id)) {
      out.onNoText = true;
      continue;
    }
    out.comments.push({ id: c.id, author: c.author, date: c.date, text: c.text });
  }
  return out;
}

// ------------------------------------------------------------------ writing

type Inline = TextRun | CommentRangeStart | CommentRangeEnd;

/** Where each comment's range starts and ends: before the first and after the last node that has its mark. */
export interface CommentPlan {
  comments: ICommentOptions[];
  starts: Map<JSONContent, number[]>;
  ends: Map<JSONContent, number[]>;
}

const add = (map: Map<JSONContent, number[]>, node: JSONContent, n: number) => map.set(node, [...(map.get(node) ?? []), n]);

/**
 * The comments to write: those with an entry and a mark, numbered in the order they start. One still being written,
 * with nothing in it yet, is not a comment yet.
 */
export function planComments(doc: JSONContent, entries: CommentData[]): CommentPlan {
  const byId = new Map<string, CommentData>();
  for (const c of entries) if (!byId.has(c.id) && !(c.editing && !c.text.trim())) byId.set(c.id, c);
  const first = new Map<string, JSONContent>();
  const last = new Map<string, JSONContent>();
  const walk = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      const id = mark.attrs?.id;
      if (mark.type !== "comment" || typeof id !== "string" || !byId.has(id)) continue;
      if (!first.has(id)) first.set(id, node);
      last.set(id, node);
    }
    node.content?.forEach(walk);
  };
  walk(doc);

  const plan: CommentPlan = { comments: [], starts: new Map(), ends: new Map() };
  [...first.keys()].forEach((id, n) => {
    add(plan.starts, first.get(id)!, n);
    add(plan.ends, last.get(id)!, n);
    plan.comments.push(wordComment(byId.get(id)!, n));
  });
  return plan;
}

// Word needs an author; the text is one paragraph, its lines kept as line breaks.
function wordComment(comment: CommentData, id: number): ICommentOptions {
  const at = Date.parse(comment.date);
  const author = comment.author.trim() || "Author";
  return {
    id,
    author,
    initials: author[0].toUpperCase(),
    date: Number.isFinite(at) ? new Date(at) : undefined,
    children: [new Paragraph({ children: comment.text.split("\n").map((line, i) => new TextRun({ text: line, break: i ? 1 : undefined })) })],
  };
}

/** `runs`, what `node` is written as, inside the comment ranges that start and end at it. */
export function withCommentRanges<T>(node: JSONContent, runs: T[], plan: CommentPlan | undefined): (T | Inline)[] {
  const starts = plan?.starts.get(node);
  const ends = plan?.ends.get(node);
  if (!starts && !ends) return runs;
  return [
    ...(starts ?? []).map((n) => new CommentRangeStart(n)),
    ...runs,
    ...(ends ?? []).flatMap((n) => [new CommentRangeEnd(n), new TextRun({ children: [new CommentReference(n)] })]),
  ];
}
