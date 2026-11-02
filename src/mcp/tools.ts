import type { Editor } from "@tiptap/core";
import { Fragment, type Mark, type MarkType, type Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { partText } from "../doc/meta";
import type { DocSession } from "../doc/session";
import { blockCount, blockRange } from "../editor/blockAddress";
import { liveComments } from "../editor/comment";
import { findAll, replaceAll } from "../editor/find";
import { baseSize, FONTS, fontName, MAX_SIZE, MIN_SIZE, sameFont, SIZES, validSize } from "../editor/fonts";
import { commit } from "../editor/history";
import { formatOf } from "../formats";
import { docToMarkdown, markdownToDoc } from "../formats/markdown";
import { normalizeUrl } from "../layout/blocks";
import { commentOn } from "../layout/comments";
import type { DocLook } from "../doc/meta";
import { docStats, outlineOf } from "../layout/outline";

/**
 * The document tools that AI clients call over MCP, and DocBro's own assistant. Rust
 * forwards each call to the window, which runs it here against the live editor.
 *
 * Blocks are the document's top-level nodes, numbered from 1 (see `blockAddress.ts`). Each edit
 * is one transaction, closed off in the undo history on both sides: one undo takes back exactly
 * one tool call, never with the user's typing before or after it. A refused call changes nothing.
 */

export const TOOL_NAMES = ["document_info", "read_document", "read_fonts", "insert_content", "replace_blocks", "delete_blocks",
  "find_replace", "format_text", "list_comments", "add_comment", "undo", "redo", "open_document", "save_document"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolContext {
  editor: Editor;
  session: DocSession;
  /**
   * Who made the call (the `mcp-call` event's `origin`). The Assistant reads documents that can tell it what to do,
   * so it cannot throw away unsaved work, replace or write another file, or save past a loss; an external client the
   * user connected keeps every option.
   */
  origin?: "assistant" | "external";
}

export interface ToolResult {
  ok: boolean;
  text: string;
}

/** `read_document` returns at most this much text per call, plus the hint for where to go on. */
export const MAX_READ_CHARS = 60_000;

/** Plain, short descriptions for the tool list; Task 11 restates them, with the argument schemas, in Rust. */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  document_info:
    "The open document's name, path, format, whether it has unsaved changes, block count, word count, comment count and outline, as JSON.",
  read_document:
    "Reads blocks from..to as Markdown, each marked [n] with its block number. Blocks are the document's top-level " +
    "paragraphs, headings, lists, quotes, tables, images and dividers. A long document comes in pages; the end says where to go on.",
  read_fonts:
    "The typeface and size in points the text of blocks from..to is set in, as JSON: one font and size for a block in one, " +
    "else its runs of text in each. Text that sets none has the page's own, which document_info gives.",
  insert_content:
    "Inserts Markdown as new top-level blocks before or after a block, or at the end. It cannot go inside a list or a table cell: " +
    "replace the whole list or table instead.",
  replace_blocks: "Replaces blocks from..to (to defaults to from) with Markdown. A whole list or table is one block.",
  delete_blocks: "Deletes blocks from..to (to defaults to from).",
  find_replace:
    "Replaces every occurrence of the literal text find, optionally only in blocks from..to. Case sensitive unless " +
    "case_sensitive is false. A match never crosses from one paragraph into the next.",
  format_text:
    "Formats blocks from..to (to defaults to from). bold, italic, underline, strike: true or false. color, highlight: " +
    "\"#rrggbb\", or null to remove. font: a typeface name, size: points from 1 to 400, each or null for the page's own. " +
    "link: an http, https or mailto URL, or null to remove. With text, these go on that text " +
    "only. style: body, heading1-3 or quote; align: left, center, right, justify or null; list: bullet, numbered or none.",
  list_comments: "The document's comments as JSON, in the order they come: id, author, date, text, and quote, the text they are on.",
  add_comment:
    "Adds a comment by \"AI\" on block n: on the first occurrence of text in it (case sensitive) when text is given, " +
    "else on the whole block.",
  undo: "Undoes the last change, the user's or an AI's. Each edit tool call is one step.",
  redo: "Redoes the last undone change.",
  open_document: "Opens a .docx or .md file by absolute path. Refused while there are unsaved changes, unless discard is true.",
  save_document:
    "Saves the document, to path if given (an absolute .docx or .md path). overwrite replaces another file; " +
    "accept_loss saves even when the file will lose parts DocBro cannot keep.",
};

const MARKS = ["bold", "italic", "underline", "strike"] as const;
const FORMATS = [...MARKS, "color", "highlight", "font", "size", "link", "style", "align", "list"] as const;
const STYLES = ["body", "heading1", "heading2", "heading3", "quote"] as const;
const ALIGNS = ["left", "center", "right", "justify"] as const;
const LIST_KINDS = ["bullet", "numbered", "none"] as const;

/** The arguments each tool takes. Any other is refused, so a misspelt one is not silently ignored. */
const ARGS: Record<ToolName, readonly string[]> = {
  document_info: [],
  read_document: ["from", "to"],
  read_fonts: ["from", "to"],
  insert_content: ["markdown", "before", "after"],
  replace_blocks: ["from", "to", "markdown"],
  delete_blocks: ["from", "to"],
  find_replace: ["find", "replace", "case_sensitive", "from", "to"],
  format_text: ["from", "to", "text", ...FORMATS],
  list_comments: [],
  add_comment: ["block", "text", "comment"],
  undo: [],
  redo: [],
  open_document: ["path", "discard"],
  save_document: ["path", "overwrite", "accept_loss"],
};

type Args = Record<string, unknown>;
type Tool = (ctx: ToolContext, a: Args) => string | Promise<string>;

/** Runs one tool. It never throws: a refusal or a failure is `{ ok: false, text: <why> }`. */
export async function runTool(ctx: ToolContext, name: string, args: Args): Promise<ToolResult> {
  try {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) return { ok: false, text: `Unknown tool: ${name}` };
    const tool = name as ToolName;
    const a: unknown = args ?? {};
    if (typeof a !== "object" || a === null || Array.isArray(a)) throw new Error("Arguments must be an object.");
    const unknown = Object.keys(a).find((key) => !ARGS[tool].includes(key));
    if (unknown !== undefined) {
      const takes = ARGS[tool].length ? `takes ${ARGS[tool].join(", ")}` : "takes no arguments";
      throw new Error(`Unknown argument ${unknown}. ${tool} ${takes}.`);
    }
    return { ok: true, text: await TOOLS[tool](ctx, a as Args) };
  } catch (e) {
    return { ok: false, text: (e instanceof Error && e.message) || String(e) };
  }
}

// ------------------------------------------------------------------ arguments

const fail = (message: string): never => {
  throw new Error(message);
};
/** null stands for a missing argument, except where it means "remove" (color, highlight, font, size, link, align). */
const given = (a: Args, key: string) => a[key] !== undefined && a[key] !== null;

function optString(a: Args, key: string): string | undefined {
  if (!given(a, key)) return undefined;
  return typeof a[key] === "string" ? a[key] : fail(`${key} must be a string.`);
}
const reqString = (a: Args, key: string): string => (given(a, key) ? optString(a, key)! : fail(`${key} is required.`));

function optBool(a: Args, key: string): boolean | undefined {
  if (!given(a, key)) return undefined;
  return typeof a[key] === "boolean" ? a[key] : fail(`${key} must be true or false.`);
}

function optBlock(a: Args, key: string): number | undefined {
  if (!given(a, key)) return undefined;
  const n = a[key];
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : fail(`${key} must be a whole number of 1 or more.`);
}
const reqBlock = (a: Args, key: string): number => (given(a, key) ? optBlock(a, key)! : fail(`${key} is required.`));

function optChoice<T extends string>(a: Args, key: string, values: readonly T[]): T | undefined {
  if (!given(a, key)) return undefined;
  return values.includes(a[key] as T) ? (a[key] as T) : fail(`${key} must be one of ${values.map((v) => `"${v}"`).join(", ")}.`);
}

/** `from` (required) and `to` (default `from`) as block numbers, with their positions. */
function blockSpan(editor: Editor, a: Args) {
  const first = reqBlock(a, "from");
  const last = optBlock(a, "to") ?? first;
  return { first, last, ...blockRange(editor.state.doc, first, last) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Markdown as top-level blocks, made to fit the schema the way the Markdown importer does. */
function parseBlocks(editor: Editor, markdown: string): Fragment {
  if (!markdown.trim()) fail("markdown is empty.");
  const doc = editor.schema.nodeFromJSON(markdownToDoc(markdown));
  doc.check();
  return doc.content;
}

// ------------------------------------------------------------------ reading

function documentInfo({ editor, session }: ToolContext): string {
  const { doc } = editor.state;
  const { words, characters } = docStats(editor.getText({ blockSeparator: "\n" }));
  return JSON.stringify({
    name: session.name,
    path: session.path,
    dirty: session.dirty,
    format: session.path ? formatOf(session.path) : null,
    blocks: blockCount(doc),
    words,
    characters,
    header: session.meta.header ?? partText(session.meta.headerPart),
    footer: session.meta.footer ?? partText(session.meta.footerPart),
    page_numbers: session.meta.pageNumbers,
    // what text that sets no typeface or size of its own is drawn in, and what format_text offers
    font: pageFont(session.meta.look),
    size: baseSize(null, session.meta.look),
    heading_sizes: [1, 2, 3].map((level) => baseSize(level, session.meta.look)),
    fonts: FONTS.map((f) => f.name),
    sizes: SIZES,
    comments: liveComments(session.meta.comments, doc).length,
    dropped: session.dropped,
    outline: outlineOf(doc).map(({ pos, level, text }) => ({ block: doc.resolve(pos).index(0) + 1, level, text })),
  });
}

const blockMarkdown = (node: PMNode) => docToMarkdown({ type: "doc", content: [node.toJSON()] }).replace(/^\n+|\n+$/g, "");
const more = (count: number, next: number, tool = "read_document") => `… ${plural(count, "more block")}. Call ${tool} with from=${next}.`;

/** A block too long for one page, cut to fit, with a note saying so. */
function cutBlock(part: string, n: number): string {
  const note = `\n… block ${n} is cut here: it has ${part.length - `[${n}] `.length} characters of Markdown.`;
  let end = MAX_READ_CHARS - note.length;
  if (/[\ud800-\udbff]/.test(part[end - 1])) end--; // never split an emoji
  return part.slice(0, end) + note;
}

function readDocument({ editor }: ToolContext, a: Args): string {
  const { doc } = editor.state;
  const from = optBlock(a, "from") ?? 1;
  const to = optBlock(a, "to") ?? blockCount(doc);
  blockRange(doc, from, to);
  const parts: string[] = [];
  let size = 0;
  for (let n = from; n <= to; n++) {
    const part = `[${n}] ${blockMarkdown(doc.child(n - 1))}`.trimEnd();
    const cost = (parts.length ? 2 : 0) + part.length;
    if (size + cost > MAX_READ_CHARS) {
      if (parts.length) return `${parts.join("\n\n")}\n\n${more(to - n + 1, n)}`;
      // One block bigger than a page: show what fits and move on, or the next call would ask for it again.
      const cut = cutBlock(part, n);
      return n < to ? `${cut}\n\n${more(to - n, n + 1)}` : cut;
    }
    parts.push(part);
    size += cost;
  }
  return parts.join("\n\n");
}

/** The typeface text that sets none is drawn in: the file's own for a .docx that says, else DocBro's (FormatControls shows the same). */
const pageFont = (look: DocLook | null) => look?.font ?? "Inter";

/** How much of a run's text `read_fonts` quotes: enough to tell which run it is, not to read it. */
const QUOTE_CHARS = 60;
const quote = (text: string) => (text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS).trimEnd()}…` : text);

/** A block's text in runs of one typeface and size, as the page draws them: text that sets none in the page's own. */
function fontRuns(block: PMNode, look: DocLook | null) {
  const runs: { text: string; font: string; size: number }[] = [];
  const visit = (node: PMNode): void => {
    if (!node.isTextblock) return node.forEach(visit);
    const level = node.type.name === "heading" ? (node.attrs.level as number) : null;
    let previous: (typeof runs)[number] | undefined;
    node.forEach((child) => {
      if (!child.isText) return;
      const style = child.marks.find((m) => m.type.name === "textStyle")?.attrs;
      const font = fontName(style?.fontFamily) ?? pageFont(look);
      const size = validSize(style?.fontSize) ?? baseSize(level, look);
      // runs only join within a paragraph: the next one starts its own, even in the same face
      if (previous && sameFont(previous.font, font) && previous.size === size) previous.text += child.text;
      else runs.push((previous = { text: child.text!, font, size }));
    });
  };
  visit(block);
  return runs;
}

function readFonts({ editor, session }: ToolContext, a: Args): string {
  const { doc } = editor.state;
  const from = optBlock(a, "from") ?? 1;
  const to = optBlock(a, "to") ?? blockCount(doc);
  blockRange(doc, from, to);
  const blocks: object[] = [];
  let size = 0;
  for (let n = from; n <= to; n++) {
    const runs = fontRuns(doc.child(n - 1), session.meta.look);
    if (!runs.length) continue; // a picture or a divider has no text to set
    const one = runs.every((r) => sameFont(r.font, runs[0].font) && r.size === runs[0].size);
    const entry = one
      ? { block: n, font: runs[0].font, size: runs[0].size }
      : { block: n, runs: runs.map((r) => ({ ...r, text: quote(r.text) })) };
    const cost = JSON.stringify(entry).length + 1;
    if (blocks.length && size + cost > MAX_READ_CHARS) {
      return JSON.stringify({ blocks, more: more(to - n + 1, n, "read_fonts") });
    }
    blocks.push(entry);
    size += cost;
  }
  return JSON.stringify({ blocks });
}

// ------------------------------------------------------------------ blocks

function insertContent({ editor }: ToolContext, a: Args): string {
  const markdown = reqString(a, "markdown");
  const before = optBlock(a, "before");
  const after = optBlock(a, "after");
  if (before !== undefined && after !== undefined) fail("Give before or after, not both.");
  const { doc } = editor.state;
  const where = before ?? after;
  const range = where === undefined ? null : blockRange(doc, where, where);
  const blocks = parseBlocks(editor, markdown);
  const { tr } = editor.state;
  let at: number; // the number the first new block gets
  if (range) {
    tr.insert(before !== undefined ? range.from : range.to, blocks);
    at = before !== undefined ? before : after! + 1;
  } else {
    // At the end, but before the empty line the editor keeps after a last heading, list or table,
    // and in place of it when that line is the whole document.
    const count = blockCount(doc);
    const last = doc.lastChild!;
    const emptyLast = last.type.name === "paragraph" && last.content.size === 0;
    if (emptyLast && count === 1) tr.replaceWith(0, doc.content.size, blocks);
    else tr.insert(doc.content.size - (emptyLast ? last.nodeSize : 0), blocks);
    at = emptyLast ? count : count + 1;
  }
  commit(editor, tr);
  return `Inserted ${plural(blocks.childCount, "block")} at ${at}–${at + blocks.childCount - 1}.`;
}

function replaceBlocks({ editor }: ToolContext, a: Args): string {
  const { first, last, from, to } = blockSpan(editor, a);
  const blocks = parseBlocks(editor, reqString(a, "markdown"));
  commit(editor, editor.state.tr.replaceWith(from, to, blocks));
  return `Replaced blocks ${first}–${last} with ${plural(blocks.childCount, "block")}.`;
}

function deleteBlocks({ editor }: ToolContext, a: Args): string {
  const { first, last, from, to } = blockSpan(editor, a);
  const { tr } = editor.state;
  // A document always has a block: deleting them all leaves an empty paragraph.
  if (from === 0 && to === tr.doc.content.size) tr.replaceWith(from, to, editor.schema.nodes.paragraph.create());
  else tr.delete(from, to);
  commit(editor, tr);
  return `Deleted blocks ${first}–${last}.`;
}

function findReplace({ editor }: ToolContext, a: Args): string {
  const find = reqString(a, "find");
  const replace = reqString(a, "replace");
  if (!find) fail("find must not be empty.");
  const caseSensitive = optBool(a, "case_sensitive") ?? true;
  const { doc } = editor.state;
  const first = optBlock(a, "from") ?? 1;
  const last = optBlock(a, "to") ?? blockCount(doc);
  const opts = { caseSensitive, ...blockRange(doc, first, last) };
  const count = findAll(doc, find, opts).length;
  const tr = replaceAll(editor.state, find, replace, opts);
  if (tr) commit(editor, tr);
  return `Replaced ${plural(count, "occurrence")}.`;
}

// ------------------------------------------------------------------ formatting

const TEXTBLOCKS = new Set(["paragraph", "heading"]);
const LIST_NODES = new Set(["bulletList", "orderedList"]);
const HEADING_LEVEL: Record<string, number> = { heading1: 1, heading2: 2, heading3: 3 };

/** Every paragraph and heading between `lo` and `hi`, at any depth (in lists, quotes and table cells too). */
function textblocks(doc: PMNode, lo: number, hi: number) {
  const found: { node: PMNode; pos: number; parent: PMNode; index: number }[] = [];
  doc.nodesBetween(lo, hi, (node, pos, parent, index) => {
    if (!TEXTBLOCKS.has(node.type.name)) return true;
    found.push({ node, pos, parent: parent!, index });
    return false;
  });
  return found;
}

/** Runs of consecutive top-level blocks between `lo` and `hi` that `fits` accepts. */
function runs(doc: PMNode, lo: number, hi: number, fits: (node: PMNode) => boolean) {
  const found: { from: number; to: number; nodes: PMNode[] }[] = [];
  let run: (typeof found)[number] | null = null;
  doc.forEach((node, pos) => {
    if (pos < lo || pos >= hi || !fits(node)) return void (run = null);
    if (!run) found.push((run = { from: pos, to: pos, nodes: [] }));
    run.nodes.push(node);
    run.to = pos + node.nodeSize;
  });
  return found;
}

const children = (node: PMNode) => {
  const kids: PMNode[] = [];
  node.forEach((kid) => void kids.push(kid));
  return kids;
};

/** A list's content as plain blocks, nested lists included. */
const unwrapList = (list: PMNode): PMNode[] =>
  children(list).flatMap((item) => children(item).flatMap((kid) => (LIST_NODES.has(kid.type.name) ? unwrapList(kid) : [kid])));

/** Takes apart every list between `lo` and `hi` (the outermost ones; their nested lists go with them). */
function unlist(tr: Transaction, lo: number, hi: number) {
  const lists: { node: PMNode; pos: number }[] = [];
  tr.doc.nodesBetween(lo, hi, (node, pos) => {
    if (!LIST_NODES.has(node.type.name)) return true;
    lists.push({ node, pos });
    return false;
  });
  for (const { node, pos } of lists.reverse()) tr.replaceWith(pos, pos + node.nodeSize, unwrapList(node));
}

/** Makes each run of top-level paragraphs, headings and lists one list of `kind`. */
function listify(tr: Transaction, lo: number, hi: number, kind: "bullet" | "numbered") {
  const { nodes } = tr.doc.type.schema;
  const type = kind === "bullet" ? nodes.bulletList : nodes.orderedList;
  const fits = (node: PMNode) => TEXTBLOCKS.has(node.type.name) || LIST_NODES.has(node.type.name);
  for (const run of runs(tr.doc, lo, hi, fits).reverse()) {
    const [first] = run.nodes;
    if (run.nodes.length === 1 && first.type === type) continue;
    const items = run.nodes.flatMap((node) =>
      LIST_NODES.has(node.type.name)
        ? children(node)
        : // a list item starts with a paragraph, so a heading becomes one
          [nodes.listItem.create(null, nodes.paragraph.create({ textAlign: node.attrs.textAlign }, node.content))],
    );
    tr.replaceWith(run.from, run.to, type.create(first.type === type ? first.attrs : null, items));
  }
}

/** Paragraph styles. Body also takes top-level quotes away; quote wraps runs of top-level paragraphs, headings and lists. */
function restyle(tr: Transaction, lo: number, hi: number, style: (typeof STYLES)[number]) {
  const { nodes } = tr.doc.type.schema;
  if (style === "quote") {
    const fits = (node: PMNode) => TEXTBLOCKS.has(node.type.name) || LIST_NODES.has(node.type.name);
    for (const run of runs(tr.doc, lo, hi, fits).reverse()) tr.replaceWith(run.from, run.to, nodes.blockquote.create(null, run.nodes));
    return;
  }
  const level = HEADING_LEVEL[style];
  const type = level ? nodes.heading : nodes.paragraph;
  for (const { node, pos, parent, index } of textblocks(tr.doc, lo, hi)) {
    if (node.type === type && (!level || node.attrs.level === level)) continue;
    if (!parent.canReplaceWith(index, index + 1, type)) continue;
    tr.setNodeMarkup(pos, type, { textAlign: node.attrs.textAlign, ...(level && { level }) });
  }
  if (style !== "body") return;
  const quotes = runs(tr.doc, lo, hi, (node) => node.type === nodes.blockquote);
  for (const { from, to, nodes: found } of quotes.reverse()) {
    tr.replaceWith(from, to, found.flatMap(children));
  }
}

function colorArg(a: Args, key: string): string | null {
  if (a[key] === null) return null;
  const value = a[key];
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) fail("color must look like #1a2b3c");
  return (value as string).toLowerCase();
}

/** A typeface by name, spelt as the Font list spells it when it is one of its faces ("georgia" is Georgia). */
function fontArg(a: Args): string | null {
  if (a.font === null) return null;
  const name = fontName(a.font) ?? fail('font must be the name of a typeface, such as "Georgia".');
  return FONTS.find((f) => sameFont(f.name, name))?.name ?? name;
}

/** A size in points, to the half point as Word keeps it. */
function sizeArg(a: Args): number | null {
  if (a.size === null) return null;
  return (typeof a.size === "number" && validSize(a.size)) || fail(`size must be a number of points from ${MIN_SIZE} to ${MAX_SIZE}.`);
}

/**
 * Sets text color, typeface and size between `from` and `to`. They are one mark (textStyle), so each piece of text keeps
 * what `patch` does not name: a new size leaves the text's color and face as they were. A piece left with none loses the mark.
 */
function setTextStyle(tr: Transaction, from: number, to: number, patch: Record<string, unknown>) {
  const type = tr.doc.type.schema.marks.textStyle;
  const pieces: { from: number; to: number; attrs: Record<string, unknown> }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const attrs = { ...type.isInSet(node.marks)?.attrs, ...patch };
    pieces.push({ from: Math.max(pos, from), to: Math.min(pos + node.nodeSize, to), attrs });
  });
  for (const piece of pieces) {
    if (Object.values(piece.attrs).some((v) => v != null)) tr.addMark(piece.from, piece.to, type.create(piece.attrs));
    else tr.removeMark(piece.from, piece.to, type);
  }
}

function formatText({ editor }: ToolContext, a: Args): string {
  const { first, last, from, to } = blockSpan(editor, a);
  const { marks } = editor.schema;
  const has = (key: string) => a[key] !== undefined;

  // what to do with each mark: put this one on, or (null) take the mark type off
  const changes: { type: MarkType; mark: Mark | null }[] = [];
  for (const name of MARKS) {
    const on = optBool(a, name);
    if (on !== undefined) changes.push({ type: marks[name], mark: on ? marks[name].create() : null });
  }
  if (has("highlight")) {
    const color = colorArg(a, "highlight");
    changes.push({ type: marks.highlight, mark: color ? marks.highlight.create({ color }) : null });
  }
  const textStyle: Record<string, unknown> = {};
  if (has("color")) textStyle.color = colorArg(a, "color");
  if (has("font")) textStyle.fontFamily = fontArg(a);
  if (has("size")) textStyle.fontSize = sizeArg(a);
  const restyled = Object.keys(textStyle).length > 0;
  if (has("link")) {
    const href = typeof a.link === "string" ? normalizeUrl(a.link) : null;
    if (a.link !== null && !href) fail("link must be an http, https or mailto URL");
    changes.push({ type: marks.link, mark: href ? marks.link.create({ href }) : null });
  }
  const style = optChoice(a, "style", STYLES);
  const list = optChoice(a, "list", LIST_KINDS);
  let align: (typeof ALIGNS)[number] | null | undefined;
  if (has("align")) {
    align = a.align === null || ALIGNS.includes(a.align as never) ? (a.align as typeof align) : undefined;
    if (align === undefined) fail(`align must be one of ${ALIGNS.map((v) => `"${v}"`).join(", ")}, or null.`);
  }
  if (!changes.length && !restyled && !style && !list && align === undefined) {
    fail("Give at least one of bold, italic, underline, strike, color, highlight, font, size, link, style, align or list.");
  }
  if (style && HEADING_LEVEL[style] && list && list !== "none") fail("A list item can't be a heading. Give style or list, not both.");
  const text = optString(a, "text");
  if (text === "") fail("text must not be empty.");
  if (text && !findAll(editor.state.doc, text, { caseSensitive: true, from, to }).length) {
    fail(`"${text}" was not found in blocks ${first}–${last}.`);
  }

  // One transaction. Each phase can move blocks, so the range is carried through what it did.
  const { tr } = editor.state;
  let lo = from;
  let hi = to;
  const phase = (run: () => void) => {
    const start = tr.steps.length;
    run();
    const mapping = tr.mapping.slice(start);
    lo = mapping.map(lo, -1);
    hi = mapping.map(hi, 1);
  };
  if (list) phase(() => (list === "none" ? unlist(tr, lo, hi) : listify(tr, lo, hi, list)));
  // a list item can't start with a heading: a heading style takes lists apart, as the editor's Heading command does
  if (style && HEADING_LEVEL[style]) phase(() => unlist(tr, lo, hi));
  if (style) phase(() => restyle(tr, lo, hi, style));
  if (align !== undefined) {
    for (const { node, pos } of textblocks(tr.doc, lo, hi)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: align });
  }
  const ranges = text ? findAll(tr.doc, text, { caseSensitive: true, from: lo, to: hi }) : [{ from: lo, to: hi }];
  for (const range of ranges) {
    for (const { type, mark } of changes) {
      if (mark) tr.addMark(range.from, range.to, mark);
      else tr.removeMark(range.from, range.to, type);
    }
    if (restyled) setTextStyle(tr, range.from, range.to, textStyle);
  }
  commit(editor, tr);
  return `Formatted blocks ${first}–${last}.`;
}

// ------------------------------------------------------------------ comments

function listComments({ editor, session }: ToolContext): string {
  const { doc } = editor.state;
  return JSON.stringify(
    liveComments(session.meta.comments, doc).map(({ id, author, date, text, from, to }) => ({
      id, author, date, text, quote: doc.textBetween(from, to, "\n"),
    })),
  );
}

function addComment({ editor, session }: ToolContext, a: Args): string {
  const block = reqBlock(a, "block");
  const comment = reqString(a, "comment");
  if (!comment.trim()) fail("comment must not be empty.");
  const text = optString(a, "text");
  if (text === "") fail("text must not be empty.");
  const { doc } = editor.state;
  const range = blockRange(doc, block, block);
  const on = text ? findAll(doc, text, { caseSensitive: true, ...range })[0] : range;
  if (!on) fail(`"${text}" was not found in block ${block}.`);
  if (!doc.textBetween(on.from, on.to, " ").trim()) fail(`Block ${block} has no text to comment on.`);
  return `Added comment ${commentOn(editor, session, on, { author: "AI", text: comment })}.`;
}

// ------------------------------------------------------------------ history and files

const ASK_TO_OPEN = "Ask the user to open the file.";
const ASK_TO_SAVE = "Ask the user to save it somewhere else.";

async function openDocument({ editor, session, origin }: ToolContext, a: Args): Promise<string> {
  const path = reqString(a, "path");
  const discard = optBool(a, "discard") ?? false;
  if (origin === "assistant") {
    if (discard) fail(`The assistant can't discard unsaved changes. ${ASK_TO_OPEN}`);
    if (session.dirty) fail("The document has unsaved changes, so the assistant can't open another file. Ask the user to save or open it.");
  }
  await session.open(path, { discard });
  const opened = `Opened ${session.name} (${plural(blockCount(editor.state.doc), "block")}).`;
  if (!session.dropped.length) return opened;
  const parts = session.dropped.map((part) => part.replace(/_/g, " ")).join(", ");
  return `${opened} DocBro can't keep these parts of the file: ${parts}. Saving over the file will remove them.`;
}

async function saveDocument({ session, origin }: ToolContext, a: Args): Promise<string> {
  const path = optString(a, "path");
  const overwrite = optBool(a, "overwrite") ?? false;
  const acceptLoss = optBool(a, "accept_loss") ?? false;
  if (origin === "assistant") {
    if (path !== undefined && path !== session.path) fail(`The assistant can only save the open file where it already is. ${ASK_TO_SAVE}`);
    if (overwrite) fail(`The assistant can't replace another file. ${ASK_TO_SAVE}`);
    if (acceptLoss) fail("The assistant can't save a file that would lose parts DocBro can't keep. Ask the user to save it.");
  }
  const saved = await session.save(path ?? null, { overwrite, acceptLoss });
  return `Saved to ${saved}.`;
}

const TOOLS: Record<ToolName, Tool> = {
  document_info: documentInfo,
  read_document: readDocument,
  read_fonts: readFonts,
  insert_content: insertContent,
  replace_blocks: replaceBlocks,
  delete_blocks: deleteBlocks,
  find_replace: findReplace,
  format_text: formatText,
  list_comments: listComments,
  add_comment: addComment,
  undo: ({ editor }) => (editor.commands.undo() ? "Undid the last change." : "Nothing to undo."),
  redo: ({ editor }) => (editor.commands.redo() ? "Redid the last undone change." : "Nothing to redo."),
  open_document: openDocument,
  save_document: saveDocument,
};
