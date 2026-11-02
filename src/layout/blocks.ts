import { message, open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Command, Editor, JSONContent } from "@tiptap/core";
import { lift } from "@tiptap/pm/commands";
import type { ResolvedPos } from "@tiptap/pm/model";
import { liftListItem } from "@tiptap/pm/schema-list";
import { NodeSelection, TextSelection, type EditorState } from "@tiptap/pm/state";
import { api } from "../api";

export type BlockKey = "p" | "h1" | "h2" | "h3" | "ul" | "ol" | "blockquote" | "hr" | "pagebreak" | "table" | "image";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ------------------------------------------------------------------ slash menu (mock 494–503, 570–604)

export const SLASH_ITEMS: { k: BlockKey; label: string; hint: string; icon: string }[] = [
  { k: "p", label: "Text", hint: "Plain paragraph", icon: "T" },
  { k: "h1", label: "Heading 1", hint: "Document title", icon: "H1" },
  { k: "h2", label: "Heading 2", hint: "Section heading", icon: "H2" },
  { k: "h3", label: "Heading 3", hint: "Subsection", icon: "H3" },
  { k: "ul", label: "Bulleted list", hint: "Simple list", icon: "•" },
  { k: "ol", label: "Numbered list", hint: "Ordered steps", icon: "1." },
  { k: "blockquote", label: "Quote", hint: "Pull a line out", icon: "“" },
  { k: "table", label: "Table", hint: "Rows and columns", icon: "▦" },
  { k: "image", label: "Image", hint: "From a file", icon: "▣" },
  { k: "pagebreak", label: "Page break", hint: "Start a new page", icon: "⤓" },
  { k: "hr", label: "Divider", hint: "Horizontal rule", icon: "—" },
];

/** The text after the `/` when the whole block is a slash command, else null. */
export function slashQuery(blockText: string): string | null {
  return /^\/[\w ]{0,20}$/.test(blockText) ? blockText.slice(1).toLowerCase().trim() : null;
}

/** The items whose label or key contains `q`; an empty `q` lists them all. */
export function filterSlash(q: string): typeof SLASH_ITEMS {
  const s = q.toLowerCase().trim();
  return SLASH_ITEMS.filter((o) => !s || o.label.toLowerCase().includes(s) || o.k.includes(s));
}

export interface SlashLine {
  query: string;
  /** Where the paragraph starts, and where its text starts and ends. */
  pos: number;
  from: number;
  to: number;
}

/** The slash command under the caret: only a collapsed caret in a top-level paragraph whose whole text matches. */
export function slashLine(state: EditorState): SlashLine | null {
  const { selection } = state;
  const { $from } = selection;
  if (!selection.empty || $from.depth !== 1 || $from.parent.type.name !== "paragraph") return null;
  // a line break counts as text, so a paragraph holding one is never a command
  const query = slashQuery($from.parent.textBetween(0, $from.parent.content.size, undefined, "\n"));
  return query === null ? null : { query, pos: $from.before(), from: $from.start(), to: $from.end() };
}

/** What the open slash menu remembers about the command text under the caret. */
export interface SlashMenuState {
  pos: number;
  query: string;
  /** The highlighted row. */
  index: number;
  /** Esc closed the menu for this very text. */
  dismissed: boolean;
}

export type SlashAction = { type: "move"; step: 1 | -1 } | { type: "hover"; index: number } | { type: "dismiss" };

/**
 * The menu's state after a transaction. It lasts only while the same command text stays under the
 * caret: no slash line, a different paragraph or a different query starts over with the first row
 * highlighted and the menu not dismissed (mock `checkSlash` resets `slashIdx` on every check).
 */
export function slashNext(prev: SlashMenuState | null, line: SlashLine | null, action?: SlashAction): SlashMenuState | null {
  if (!line) return null;
  const same = prev && prev.pos === line.pos && prev.query === line.query;
  const state = same ? prev : { pos: line.pos, query: line.query, index: 0, dismissed: false };
  const count = filterSlash(line.query).length;
  if (!action || !count) return state;
  if (action.type === "dismiss") return { ...state, dismissed: true };
  if (action.type === "hover") return { ...state, index: Math.min(Math.max(action.index, 0), count - 1) };
  return { ...state, index: (state.index + action.step + count) % count };
}

/** The slash text goes, then the block is applied to the empty line (mock `choose`). */
export function chooseSlashItem(editor: Editor, key: BlockKey): void {
  const line = slashLine(editor.state);
  if (line) editor.chain().focus().deleteRange({ from: line.from, to: line.to }).run();
  applyBlock(editor, key, true);
}

// ------------------------------------------------------------------ floating positions

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/** Mock `onSel`: centered over the selection, kept 170px from either side of the paper, 48px above it. */
export function bubblePosition(sel: Rect, paper: Rect): { x: number; y: number } {
  return { x: clamp(sel.left + sel.width / 2 - paper.left, 170, paper.width - 170), y: sel.top - paper.top - 48 };
}

/** A popover `gap` px under its anchor (mock `checkSlash`: 6), kept inside the paper. */
export function popoverPosition(anchor: { left: number; bottom: number }, paper: Rect, width: number, gap = 8): { x: number; y: number } {
  return { x: clamp(anchor.left - paper.left, 8, Math.max(8, paper.width - width - 8)), y: anchor.bottom - paper.top + gap };
}

// ------------------------------------------------------------------ blocks (mock 607–615)

const HEADINGS = { h1: 1, h2: 2, h3: 3 } as const;
const LISTS = ["bulletList", "orderedList"] as const;
const WRAPPERS = [...LISTS, "blockquote"] as const;

const NODE_BLOCKS = new Map<string, BlockKey>([
  ["bulletList", "ul"], ["orderedList", "ol"], ["blockquote", "blockquote"], ["table", "table"],
  ["horizontalRule", "hr"], ["pageBreak", "pagebreak"], ["image", "image"],
]);

/** The key of the block at the selection: the heading, else the nearest list, quote or table around it, else text. */
export function blockOf(editor: Editor): BlockKey {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection) {
    const kind = NODE_BLOCKS.get(selection.node.type.name);
    if (kind) return kind;
  }
  const { $from } = selection;
  if ($from.parent.type.name === "heading") return `h${$from.parent.attrs.level}` as BlockKey;
  const nearest = innermost($from, [...NODE_BLOCKS.keys()]);
  return (nearest && NODE_BLOCKS.get(nearest)) || "p";
}

function innermost($pos: ResolvedPos, names: readonly string[]): string | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (names.includes(name)) return name;
  }
  return null;
}

/** Takes the selected block out of the lists or quotes around it (all of them, or `times` levels), as one step of a chain. */
function liftOut(names: readonly string[], times = 8): Command {
  return ({ state, dispatch }) => {
    if (!dispatch) return true;
    for (let i = 0; i < times; i++) {
      const found = innermost(state.selection.$from, names);
      if (!found) break;
      const moved = found === "blockquote" ? lift(state, dispatch) : liftListItem(state.schema.nodes.listItem)(state, dispatch);
      if (!moved) break;
    }
    return true;
  };
}

const cell = (type: string): JSONContent => ({ type, content: [{ type: "paragraph" }] });
const row = (type: string): JSONContent => ({ type: "tableRow", content: [cell(type), cell(type), cell(type)] });
const TABLE: JSONContent = { type: "table", content: [row("tableHeader"), row("tableCell"), row("tableCell")] };

/** Inserted in the middle of a line, a block (divider, table, image) and its empty paragraph leave the caret in front of the rest of the line; bring it back into the empty one. */
const caretIntoEmptyLine: Command = ({ tr }) => {
  const { $from } = tr.selection;
  if ($from.depth === 0 || $from.parentOffset !== 0 || $from.parent.content.size === 0) return true;
  const before = tr.doc.resolve($from.before()).nodeBefore;
  if (before?.type.name === "paragraph" && before.content.size === 0) {
    tr.setSelection(TextSelection.create(tr.doc, $from.before() - 1));
  }
  return true;
};

/**
 * Turns the block at the selection into `key`. Applying the block it already is turns it back into a
 * paragraph (the dock), unless `force` (menus and the palette). A divider or table is inserted and
 * followed by an empty paragraph, which the caret moves into.
 */
export function applyBlock(editor: Editor, key: BlockKey, force = false): void {
  if (key === "image") return void pickImage(editor);
  const chain = editor.chain().focus();
  if (key === "hr") return void chain.insertContent([{ type: "horizontalRule" }, { type: "paragraph" }]).command(caretIntoEmptyLine).run();
  if (key === "pagebreak") return void chain.insertContent([{ type: "pageBreak" }, { type: "paragraph" }]).command(caretIntoEmptyLine).run();
  if (key === "table") return void chain.insertContent([TABLE, { type: "paragraph" }]).command(caretIntoEmptyLine).run();

  if (key === "p") return void chain.setParagraph().command(liftOut(WRAPPERS)).run();
  if (key === "blockquote") {
    if (!editor.isActive("blockquote")) return void chain.command(liftOut(LISTS)).setBlockquote().run();
    return void (force ? chain : chain.command(liftOut(["blockquote"], 1))).run();
  }
  if (key === "ul" || key === "ol") {
    const name = key === "ul" ? "bulletList" : "orderedList";
    const toggle = () => (key === "ul" ? chain.toggleBulletList() : chain.toggleOrderedList());
    if (!editor.isActive(name)) return void toggle().run();
    return void (force ? chain : toggle()).run();
  }
  const level = HEADINGS[key];
  if (!editor.isActive("heading", { level })) return void chain.command(liftOut(LISTS)).setHeading({ level }).run();
  return void (force ? chain : chain.setParagraph()).run();
}

// ------------------------------------------------------------------ images

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TOO_HEAVY = "Images over 5 MB make the document too heavy. Choose a smaller one.";
// the .docx exporter writes other image types as their alt text
const IMAGE_TYPES = new Map([["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"]]);

/** The dialog, the file read and the error message, so tests can answer them. */
export interface ImagePicker {
  pick(): Promise<string | null>;
  read(path: string): Promise<Uint8Array>;
  alert(text: string): void;
}

const tauriPicker: ImagePicker = {
  pick: async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: [...IMAGE_TYPES.keys()] }] });
    return typeof path === "string" ? path : null;
  },
  read: api.readFile,
  alert: (text) => void message(text, { title: "DocBro", kind: "error" }).catch(() => {}),
};

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Asks for an image file and inserts it as a data URL. It reports its own problems and never rejects. */
export async function pickImage(editor: Editor, io: ImagePicker = tauriPicker): Promise<void> {
  try {
    const path = await io.pick();
    if (!path) return;
    const mime = IMAGE_TYPES.get(path.slice(path.lastIndexOf(".") + 1).toLowerCase());
    if (!mime) return io.alert("Choose a PNG, JPG or GIF image.");
    const bytes = await io.read(path);
    if (bytes.length > MAX_IMAGE_BYTES) return io.alert(TOO_HEAVY);
    if (editor.isDestroyed) return;
    const image = { type: "image", attrs: { src: `data:${mime};base64,${base64(bytes)}` } };
    editor.chain().focus().insertContent([image, { type: "paragraph" }]).command(caretIntoEmptyLine).run();
  } catch (e) {
    io.alert(e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------------ links and colors

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * A link address as typed, made safe to store: `http:`, `https:` and `mailto:` are kept, a bare
 * `example.com/x` gets `https://`, and everything else is null (an empty field, any other
 * scheme, whitespace or control characters anywhere, which browsers drop from a scheme).
 * A bare address may not hold an `@` ("paypal.com@evil.com" is the user name "paypal.com" on
 * evil.com) or start with a slash ("//evil.com"); write `mailto:` or the scheme to mean them.
 */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text || /[\s\u0000-\u001f\u007f-\u009f]/.test(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (scheme && !LINK_SCHEMES.has(`${scheme[1].toLowerCase()}:`)) return null;
  if (!scheme && /^[\\/]|@/.test(text)) return null;
  const address = scheme ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (!LINK_SCHEMES.has(url.protocol)) return null;
  if (url.protocol === "mailto:") return url.pathname ? address : null;
  // a bare word such as "hello" is not an address; "localhost" and anything with a dot is
  return scheme || url.hostname.includes(".") || url.hostname === "localhost" ? address : null;
}

/**
 * The link field's Enter: an empty field removes the link, a good address sets it on the selection
 * (or on the whole link under the caret), and at a bare caret inserts the address as linked text.
 * False when the address is not accepted; nothing changes then.
 */
export function applyLink(editor: Editor, input: string): boolean {
  const chain = editor.chain().focus();
  if (!input.trim()) return chain.extendMarkRange("link").unsetLink().run();
  const href = normalizeUrl(input);
  if (!href) return false;
  if (editor.state.selection.empty && !editor.isActive("link")) {
    return chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
  }
  return chain.extendMarkRange("link").setLink({ href }).run();
}

/**
 * Eight text colors and, in the popover, Default. A color is saved as a fixed `#rrggbb`, so each is mid-luminance:
 * at least 3:1 against both the white page and the dark theme's page (`--surface` #1c1d1b). Gray and Gold are the
 * mock's own tokens (`--muted`, the dark `--hl-line`); the rest are hues in the same register at the same lightness.
 */
export const TEXT_COLORS: { name: string; value: string }[] = [
  { name: "Gray", value: "#7a7c74" },
  { name: "Red", value: "#d34f46" },
  { name: "Amber", value: "#b9671e" },
  { name: "Gold", value: "#8f7d2c" },
  { name: "Green", value: "#318c5e" },
  { name: "Blue", value: "#357fc8" },
  { name: "Purple", value: "#906cba" },
  { name: "Pink", value: "#c65385" },
];

/** A typeface for the selection (or for what is typed next, at a caret), or null for the page's own. */
export function applyFont(editor: Editor, name: string | null): void {
  const chain = editor.chain().focus();
  void (name ? chain.setFontFamily(name) : chain.unsetFontFamily()).run();
}

/** A size in points for the selection (or for what is typed next, at a caret), or null for the page's own. */
export function applySize(editor: Editor, size: number | null): void {
  const chain = editor.chain().focus();
  void (size ? chain.setMark("textStyle", { fontSize: size }) : chain.setMark("textStyle", { fontSize: null }).removeEmptyTextStyle()).run();
}

/** A text color for the selection, or null for the default. */
export function applyColor(editor: Editor, value: string | null): void {
  const chain = editor.chain().focus();
  void (value ? chain.setColor(value) : chain.unsetColor()).run();
}
