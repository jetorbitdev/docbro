import { getSchema, type JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import JSZip from "jszip";
import { PAPER, TWIPS_PER_PX, emptyMeta, type DocMeta, type KeptPart, type PageSize } from "../../doc/meta";
import { isAutomaticColor } from "../../editor/automaticColor";
import { createExtensions } from "../../editor/extensions";
import { MEDIA_TYPES } from "./media";
import { NS, attr, children, descendants, first, is, parseXml } from "./xml";

export type DroppedPart = "headers" | "footers" | "comments" | "footnotes" | "tracked_changes" | "page_setup" | "other_content";

export interface DocxImport {
  doc: JSONContent;
  meta: DocMeta;
  dropped: DroppedPart[];
}

type Mark = NonNullable<JSONContent["marks"]>[number];

const DROPPED_ORDER: DroppedPart[] = ["headers", "footers", "comments", "footnotes", "tracked_changes", "page_setup", "other_content"];
const PICTURE = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const STRICT = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const SAFE_LINK = /^(https?|mailto|tel|ftp):/i;

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp",
};
const ALIGN: Record<string, string> = {
  left: "left", start: "left", center: "center", right: "right", end: "right",
  both: "justify", distribute: "justify", lowKashida: "justify", mediumKashida: "justify", highKashida: "justify", thaiDistribute: "justify",
};
// ST_HighlightColor, the only colors `w:highlight` can name.
const HIGHLIGHT: Record<string, string> = {
  black: "#000000", blue: "#0000ff", cyan: "#00ffff", green: "#00ff00", magenta: "#ff00ff", red: "#ff0000", yellow: "#ffff00",
  white: "#ffffff", darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000",
  darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0",
};

// Values come from the file, so never let one reach a prototype key ("constructor").
const lookup = (table: Record<string, string>, key: string | null) => (key !== null && Object.hasOwn(table, key) ? table[key] : undefined);

interface Style { name: string; basedOn: string | null; pPr: Element | null }
interface Level { ordered: boolean; start: number; indent: number | null }
interface Relation { target: string; external: boolean }

interface Context {
  styles: Map<string, Style>;
  nums: Map<string, Element>;
  abstracts: Map<string, Element>;
  links: Map<string, string>; // relationship id -> safe external URL
  images: Map<string, string | null>; // relationship id -> data URL, or null for a format a browser cannot show
  counts: Map<string, number[]>; // numId -> items numbered so far, per level
  dropped: Set<DroppedPart>;
  page: { width: number; height: number }; // EMU, the paper of the last section: what a cover has to match
  textWidth: number; // px, the paper less its side margins: the widest a table is kept
  sized?: boolean; // a picture is given the size the file drew it at: for the view of a header or footer, which has no text width to hold it to
}

// A block of the body before consecutive list and quote paragraphs are grouped.
interface Item {
  node: JSONContent;
  quote?: boolean;
  list?: { numId: string; ilvl: number };
  indent?: number | null; // a plain paragraph's left indent, which can make it part of the list item above
}

export async function importDocx(bytes: Uint8Array): Promise<DocxImport> {
  const zip = await open(bytes);
  if (!zip.file("word/document.xml")) throw new Error("Not a Word document");
  const root = (await readXml(zip, "word/document.xml"))!.documentElement;
  if (root.namespaceURI === STRICT)
    throw new Error("This Word document is saved as Strict Open XML, which DocBro cannot read. Save it as a regular .docx in Word.");
  const body = is(root, "w:document") ? first(root, "w:body") : null;
  if (!body) throw new Error("This Word document is damaged: it has no body");

  const [styles, numbering, rels] = await Promise.all(
    ["word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels"].map((path) => readXml(zip, path)),
  );
  const relations = relationships(rels);
  const ctx: Context = {
    styles: readStyles(styles),
    nums: byId(numbering, "w:num", "w:numId"),
    abstracts: byId(numbering, "w:abstractNum", "w:abstractNumId"),
    links: safeLinks(relations),
    images: await images(zip, body, relations),
    counts: new Map(),
    dropped: await droppedParts(zip, body),
    page: pageEmu(lastSection(body)),
    textWidth: textWidthPx(lastSection(body)),
  };
  const doc = finish(trimCovers(blocks(body, ctx)));
  const meta = await readHeaderFooter(zip, body, relations, ctx);
  meta.pageSize = pageSizeOf(lastSection(body));
  return { doc, meta, dropped: DROPPED_ORDER.filter((part) => ctx.dropped.has(part)) };
}

// Relationship id -> external URL, for the links a person can click.
const safeLinks = (relations: Map<string, Relation>): Map<string, string> =>
  new Map([...relations].filter(([, rel]) => rel.external && SAFE_LINK.test(rel.target.trim())).map(([id, rel]) => [id, rel.target.trim()]));

// The properties of the last section: the one whose header, footer and paper DocBro keeps.
function lastSection(body: Element): Element | null {
  const sections = descendants(body, "w:sectPr").filter((s) => !is(s.parentElement!, "w:sectPrChange"));
  return sections[sections.length - 1] ?? null;
}

const EMU_PER_TWIP = 635;

// The paper less the margins on its sides (an inch each when the file does not say), in px.
function textWidthPx(sectPr: Element | null): number {
  const width = int(attr(sectPr && first(sectPr, "w:pgSz"), "w:w")) ?? PAPER.letter.width;
  const margin = (side: string) => int(attr(sectPr && first(sectPr, "w:pgMar"), side)) ?? 1440;
  return Math.max(1, (width - margin("w:left") - margin("w:right")) / TWIPS_PER_PX);
}

function pageEmu(sectPr: Element | null): { width: number; height: number } {
  const size = sectPr && first(sectPr, "w:pgSz");
  return {
    width: (int(attr(size, "w:w")) ?? PAPER.letter.width) * EMU_PER_TWIP,
    height: (int(attr(size, "w:h")) ?? PAPER.letter.height) * EMU_PER_TWIP,
  };
}

// Letter unless the file says A4; any other paper is reported by `customPage` and kept as Letter.
function pageSizeOf(sectPr: Element | null): PageSize {
  const size = sectPr && first(sectPr, "w:pgSz");
  const fits = (paper: PageSize) =>
    near(attr(size, "w:w"), PAPER[paper].width) && near(attr(size, "w:h"), PAPER[paper].height);
  return fits("letter") ? "letter" : fits("a4") ? "a4" : "letter";
}

// --- Package -----------------------------------------------------------------

async function open(bytes: Uint8Array): Promise<JSZip> {
  // An OLE compound file: a .doc, or a .docx that Word encrypted with a password.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
    throw new Error("This file is password-protected or in the old .doc format. Open it in Word and save it as .docx.");
  try {
    return await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch {
    throw new Error("Not a Word document, or the file is damaged");
  }
}

async function readXml(zip: JSZip, path: string): Promise<Document | null> {
  const file = zip.file(path);
  if (!file) return null;
  let text: string;
  try {
    text = await file.async("string");
  } catch {
    throw new Error(`This Word document is damaged: ${path} cannot be read`);
  }
  return parseXml(text, path);
}

function relationships(rels: Document | null): Map<string, Relation> {
  const map = new Map<string, Relation>();
  for (const rel of children(rels?.documentElement, "rel:Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (id && target) map.set(id, { target, external: attr(rel, "TargetMode") === "External" });
  }
  return map;
}

// A relationship target, relative to word/ unless it starts with "/", as a zip path.
function partPath(target: string): string {
  let path = target;
  try {
    path = decodeURIComponent(target);
  } catch {
    // keep it as written
  }
  const out: string[] = [];
  for (const segment of (path.startsWith("/") ? path.slice(1) : `word/${path}`).split("/")) {
    if (segment === "..") out.pop();
    else if (segment && segment !== ".") out.push(segment);
  }
  return out.join("/");
}

// Pictures are read up front so that the walk over the body can stay synchronous.
async function images(zip: JSZip, body: Element, relations: Map<string, Relation>): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const ids = [...descendants(body, "a:blip").map((b) => attr(b, "r:embed")), ...descendants(body, "v:imagedata").map((i) => attr(i, "r:id"))];
  await Promise.all([...new Set(ids)].map(async (id) => {
    const rel = id ? relations.get(id) : undefined;
    if (!id || !rel || rel.external) return;
    const path = partPath(rel.target);
    const file = zip.file(path);
    if (!file) return; // a reference to a file that is not there: the picture is skipped
    const mime = lookup(MIME, path.slice(path.lastIndexOf(".") + 1).toLowerCase());
    if (!mime) return void map.set(id, null);
    try {
      map.set(id, `data:${mime};base64,${await file.async("base64")}`);
    } catch {
      // unreadable: skipped like a missing file
    }
  }));
  return map;
}

const near = (value: string | null, target: number) => value === null || Math.abs(Number(value) - target) <= 20;

// Letter or A4, portrait, 1in margins, one column: what DocBro writes back.
function customPage(sectPr: Element): boolean {
  const size = first(sectPr, "w:pgSz");
  const margin = first(sectPr, "w:pgMar");
  const paper = Object.values(PAPER).some(({ width, height }) => near(attr(size, "w:w"), width) && near(attr(size, "w:h"), height));
  const margins = ["w:top", "w:right", "w:bottom", "w:left"].every((side) => near(attr(margin, side), 1440));
  const gutter = Number(attr(margin, "w:gutter") ?? 0) > 0;
  const columns = Number(attr(first(sectPr, "w:cols"), "w:num") ?? 1) > 1;
  return !paper || !margins || gutter || columns;
}

const TRACKED = [
  "w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:cellIns", "w:cellDel", "w:cellMerge", "w:numberingChange",
  "w:rPrChange", "w:pPrChange", "w:sectPrChange", "w:tblPrChange", "w:trPrChange", "w:tcPrChange",
];

async function droppedParts(zip: JSZip, body: Element): Promise<Set<DroppedPart>> {
  const dropped = new Set<DroppedPart>();
  for (const override of children((await readXml(zip, "[Content_Types].xml"))?.documentElement, "ct:Override")) {
    const type = attr(override, "ContentType") ?? "";
    if (type.endsWith(".header+xml")) dropped.add("headers");
    if (type.endsWith(".footer+xml")) dropped.add("footers");
  }
  if (zip.file("word/comments.xml")) dropped.add("comments");
  for (const [path, name] of [["word/footnotes.xml", "w:footnote"], ["word/endnotes.xml", "w:endnote"]]) {
    const notes = await readXml(zip, path);
    // Ids -1, 0 (and 1 in older files) are the separator lines, typed as such.
    if (notes && descendants(notes, name).some((n) => Number(attr(n, "w:id")) > 0 && (attr(n, "w:type") ?? "normal") === "normal"))
      dropped.add("footnotes");
  }
  if (TRACKED.some((name) => descendants(body, name).length)) dropped.add("tracked_changes");
  // A w:sectPr inside w:sectPrChange is the old value of a tracked change, not a section.
  if (descendants(body, "w:sectPr").some((s) => !is(s.parentElement!, "w:sectPrChange") && customPage(s))) dropped.add("page_setup");
  if (["w:txbxContent", "c:chart", "dgm:*", "m:oMath"].some((name) => descendants(body, name).length)) dropped.add("other_content");
  return dropped;
}

// --- Header and footer -------------------------------------------------------------

type HeaderFooterKind = "header" | "footer";

// Anything a one-line zone cannot hold. A part with one of these stays in `dropped`.
const NOT_A_LINE = ["w:tbl", "w:drawing", "w:pict", "w:object", "w:sym", "w:contentPart", "w:txbxContent", "m:oMath", "c:chart", "dgm:*"];

/**
 * The default header and footer of the last section. One that is a single plain paragraph becomes the text
 * zone (the text of a PAGE field is not part of the label; it only turns the footer's page numbers on). Any
 * other is kept whole as a part, and written back as it was. A first/even-page variant, or a part that
 * needs more than pictures, is left for `dropped` to report, as is any header the package has besides this one.
 */
async function readHeaderFooter(
  zip: JSZip,
  body: Element,
  relations: Map<string, Relation>,
  ctx: Context,
): Promise<DocMeta> {
  const meta = emptyMeta();
  const section = lastSection(body);
  const { dropped } = ctx;
  const counts = await partCounts(zip);

  for (const kind of ["header", "footer"] as const) {
    const refs = children(section, kind === "header" ? "w:headerReference" : "w:footerReference");
    if (!refs.length) continue;
    // A first or even page header/footer is a variant DocBro has no room for.
    if (refs.some((ref) => (attr(ref, "w:type") ?? "default") !== "default")) continue;

    const rel = relations.get(attr(refs[refs.length - 1], "r:id") ?? "");
    if (!rel || rel.external) continue;
    const path = partPath(rel.target);
    const doc = await readXml(zip, path);
    if (!doc) continue;
    const line = simpleLine(doc, kind);
    const kept = line ? null : await keepPart(zip, path, doc, kind, ctx);
    if (!line && !kept) continue;

    if (kind === "header") {
      if (line) meta.header = line.text;
      else meta.headerPart = kept;
    } else if (line) {
      meta.footer = line.text;
      meta.pageNumbers = line.pageNumbers;
    } else meta.footerPart = kept;
    // Another part of this kind in the package is not written back, so it stays reported.
    if (counts[kind] <= 1) dropped.delete(kind === "header" ? "headers" : "footers");
  }
  return meta;
}

async function partCounts(zip: JSZip): Promise<Record<HeaderFooterKind, number>> {
  const counts = { header: 0, footer: 0 };
  for (const override of children((await readXml(zip, "[Content_Types].xml"))?.documentElement, "ct:Override")) {
    const type = attr(override, "ContentType") ?? "";
    if (type.endsWith(".header+xml")) counts.header++;
    if (type.endsWith(".footer+xml")) counts.footer++;
  }
  return counts;
}

const escapeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// The part whole: its XML, its relationships and pictures (named so that they cannot clash with the body's), and a
// document to show. Null when the part leans on anything but pictures and outside links: the file would be left
// with a part that points at nothing.
async function keepPart(zip: JSZip, path: string, doc: Document, kind: HeaderFooterKind, ctx: Context): Promise<KeptPart | null> {
  const root = is(doc.documentElement, kind === "header" ? "w:hdr" : "w:ftr") ? doc.documentElement : null;
  if (!root) return null;

  const slash = path.lastIndexOf("/");
  const relsDoc = await readXml(zip, `${path.slice(0, slash)}/_rels/${path.slice(slash + 1)}.rels`);
  const media: Record<string, string> = {};
  const lines: string[] = [];
  for (const rel of children(relsDoc?.documentElement, "rel:Relationship")) {
    const id = attr(rel, "Id");
    const type = attr(rel, "Type") ?? "";
    const target = attr(rel, "Target");
    if (!id || !target) return null;
    const external = attr(rel, "TargetMode") === "External";
    let written = target;
    if (!external) {
      const source = partPath(target);
      const extension = source.slice(source.lastIndexOf(".") + 1).toLowerCase();
      const file = zip.file(source);
      if (!type.endsWith("/image") || !file || !lookup(MEDIA_TYPES, extension)) return null;
      const name = `${kind}-${Object.keys(media).length + 1}.${extension}`;
      media[name] = await file.async("base64");
      written = `media/${name}`;
    }
    lines.push(`<Relationship Id="${escapeAttr(id)}" Type="${escapeAttr(type)}" Target="${escapeAttr(written)}"${external ? ' TargetMode="External"' : ""}/>`);
  }

  const rels = lines.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${lines.join("")}</Relationships>`
    : null;
  return { xml: await zip.file(path)!.async("string"), rels, media, view: await viewOf(zip, root, relationships(relsDoc), ctx) };
}

// What the page shows of a kept part: its blocks, with the pictures put first. Word anchors a logo into a line of
// text and lets the text run beside it; the page floats pictures to the left, which needs them ahead of the text.
async function viewOf(zip: JSZip, root: Element, relations: Map<string, Relation>, ctx: Context): Promise<JSONContent | null> {
  try {
    const part: Context = { ...ctx, images: await images(zip, root, relations), links: safeLinks(relations), counts: new Map(), dropped: new Set(), sized: true };
    const content = blocks(root, part).map((node) =>
      node.type === "image" ? { ...node, attrs: { ...node.attrs, cover: false } } : node);
    return finish([...content.filter((n) => n.type === "image"), ...content.filter((n) => n.type !== "image")]);
  } catch {
    return null;
  }
}

function simpleLine(doc: Document, kind: HeaderFooterKind): { text: string; pageNumbers: boolean } | null {
  const name = kind === "header" ? "w:hdr" : "w:ftr";
  const root = is(doc.documentElement, name) ? doc.documentElement : first(doc.documentElement, name);
  if (!root) return null;
  const content = children(root).filter((el) => !is(el, "w:sectPr"));
  if (content.length !== 1 || !is(content[0], "w:p")) return null;
  const paragraph = content[0];
  if (NOT_A_LINE.some((name) => descendants(paragraph, name).length)) return null;
  return readLine(paragraph);
}

interface Field {
  instr: string;
  phase: "instr" | "result";
  kind: "page" | "total" | null;
}

function readLine(paragraph: Element): { text: string; pageNumbers: boolean } | null {
  let text = "";
  let pageNumbers = false;
  let complex = false;
  let field: Field | null = null;

  const kindOf = (instr: string): "page" | "total" | null => {
    const word = instr.trim().split(/\s+/)[0] ?? "";
    return word === "PAGE" ? "page" : word === "NUMPAGES" ? "total" : null;
  };
  const evaluate = (): "page" | "total" | null => {
    const kind = field ? kindOf(field.instr) : null;
    if (field) field.kind = kind;
    if (!kind) complex = true;
    return kind;
  };
  const add = (value: string) => {
    if (!field || field.phase !== "result") text += value;
  };

  const run = (r: Element) => {
    for (const el of children(r)) {
      if (is(el, "w:t")) add(el.textContent ?? "");
      else if (is(el, "w:tab") || is(el, "w:ptab")) add("\t");
      else if (is(el, "w:br") || is(el, "w:cr")) add("\n");
      else if (is(el, "w:noBreakHyphen")) add("‑");
      else if (is(el, "w:softHyphen")) add("\u00ad");
      else if (is(el, "w:fldChar")) {
        const type = attr(el, "w:fldCharType");
        if (type === "begin") {
          if (field) complex = true;
          field = { instr: "", phase: "instr", kind: null };
        } else if (type === "separate") {
          if (!field) complex = true;
          else {
            evaluate();
            field.phase = "result";
          }
        } else if (type === "end") {
          if (!field) complex = true;
          else {
            if (field.kind === null) evaluate();
            if (field.kind === "page") pageNumbers = true;
            field = null;
          }
        }
      } else if (is(el, "w:instrText")) {
        if (!field) complex = true;
        else field.instr += el.textContent ?? "";
      } else if (is(el, "w:rPr")) continue;
      else complex = true;
    }
  };

  const walk = (parent: Element | null) => {
    for (const el of children(parent)) {
      if (is(el, "w:r")) run(el);
      else if (
        is(el, "w:hyperlink") || is(el, "w:ins") || is(el, "w:smartTag") ||
        is(el, "w:customXml") || is(el, "w:dir") || is(el, "w:bdo")
      ) walk(el);
      else if (is(el, "w:sdt")) walk(first(el, "w:sdtContent"));
      else if (is(el, "mc:AlternateContent")) walk(choice(el));
      else if (is(el, "w:fldSimple")) {
        const kind = kindOf(attr(el, "w:instr") ?? "");
        if (!kind) complex = true;
        if (kind === "page") pageNumbers = true;
      } else if (
        is(el, "w:pPr") || is(el, "w:proofErr") || is(el, "w:bookmarkStart") || is(el, "w:bookmarkEnd") ||
        is(el, "w:commentRangeStart") || is(el, "w:commentRangeEnd") || is(el, "w:permStart") ||
        is(el, "w:permEnd") || is(el, "w:lastRenderedPageBreak")
      ) continue;
      else complex = true;
    }
  };

  walk(paragraph);
  if (complex) return null;
  return { text: cleanLine(text, pageNumbers), pageNumbers };
}

// The tab that pushes the page label right, and the label's own literal words, are not the footer's text.
function cleanLine(text: string, pageNumbers: boolean): string {
  const line = text
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return pageNumbers ? line.replace(/\s*Page\s+of\s*$/i, "").trim() : line;
}

// --- Styles and numbering --------------------------------------------------------

function readStyles(doc: Document | null): Map<string, Style> {
  const styles = new Map<string, Style>();
  for (const style of children(doc?.documentElement, "w:style")) {
    const id = attr(style, "w:styleId");
    if (id) styles.set(id, { name: attr(first(style, "w:name"), "w:val") ?? "", basedOn: attr(first(style, "w:basedOn"), "w:val"), pPr: first(style, "w:pPr") });
  }
  return styles;
}

function byId(doc: Document | null, name: string, idAttr: string): Map<string, Element> {
  return new Map(children(doc?.documentElement, name).map((el) => [attr(el, idAttr) ?? "", el]));
}

// A style and the styles it is based on, nearest first. A style id that is not
// defined is still yielded, so "Heading1" without a styles part is a heading.
function* chain(ctx: Context, styleId: string | null): Generator<[string, Style | undefined]> {
  const seen = new Set<string>();
  for (let id = styleId; id && !seen.has(id); id = ctx.styles.get(id)?.basedOn ?? null) {
    seen.add(id);
    yield [id, ctx.styles.get(id)];
  }
}

// A paragraph property, set on the paragraph or inherited from its style.
function prop(ctx: Context, pPr: Element | null, styleId: string | null, path: string): Element | null {
  let found = first(pPr, path);
  for (const [, style] of chain(ctx, styleId)) found ??= first(style?.pPr, path);
  return found;
}

type Kind = { type: "heading"; level: number } | { type: "paragraph" | "quote" };

// Built-in styles keep their English name in localized Word ("heading 1"), so match the id or the name.
function builtIn(name: string): Kind | null {
  const n = name.toLowerCase().replace(/\s+/g, "");
  const heading = /^heading([1-9])$/.exec(n);
  if (heading) return Number(heading[1]) <= 3 ? { type: "heading", level: Number(heading[1]) } : { type: "paragraph" };
  if (n === "title") return { type: "heading", level: 1 };
  return n === "quote" || n === "intensequote" ? { type: "quote" } : null;
}

function kindOf(ctx: Context, styleId: string | null): Kind {
  for (const [id, style] of chain(ctx, styleId)) {
    const kind = builtIn(id) ?? (style ? builtIn(style.name) : null);
    if (kind) return kind;
  }
  return { type: "paragraph" };
}

const int = (value: string | null) => {
  const n = value === null ? NaN : parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};
const indentOf = (ind: Element | null) => int(attr(ind, "w:left") ?? attr(ind, "w:start"));

// numId -> w:num -> w:abstractNum, with the num's w:lvlOverride taking precedence.
function level(ctx: Context, numId: string, ilvl: number, depth = 0): Level | null {
  const num = ctx.nums.get(numId);
  const abstract = ctx.abstracts.get(attr(first(num, "w:abstractNumId"), "w:val") ?? "");
  if (!num || !abstract) return null;
  // A list style's abstractNum only points at the num that holds the levels.
  const linked = attr(first(abstract, "w:numStyleLink"), "w:val");
  const linkedNum = linked && depth < 3 ? attr(first(ctx.styles.get(linked)?.pPr, "w:numPr/w:numId"), "w:val") : null;
  if (linkedNum) return level(ctx, linkedNum, ilvl, depth + 1);

  const override = children(num, "w:lvlOverride").find((o) => int(attr(o, "w:ilvl")) === ilvl);
  const lvl = first(override, "w:lvl") ?? children(abstract, "w:lvl").find((l) => int(attr(l, "w:ilvl")) === ilvl);
  if (!lvl) return null;
  return {
    ordered: attr(first(lvl, "w:numFmt"), "w:val") !== "bullet",
    start: int(attr(first(override, "w:startOverride"), "w:val")) ?? int(attr(first(lvl, "w:start"), "w:val")) ?? 0,
    indent: indentOf(first(lvl, "w:pPr/w:ind")),
  };
}

// --- Body ------------------------------------------------------------------------

const choice = (el: Element) => first(el, "mc:Choice") ?? first(el, "mc:Fallback");

function blocks(container: Element | null, ctx: Context): JSONContent[] {
  const items: Item[] = [];
  collect(container, ctx, items);
  return assemble(items, ctx);
}

function collect(container: Element | null, ctx: Context, items: Item[]): void {
  for (const el of children(container)) {
    if (is(el, "w:p")) items.push(...paragraph(el, ctx));
    else if (is(el, "w:tbl")) {
      const node = table(el, ctx);
      if (node) items.push({ node });
    } else if (is(el, "w:sdt")) collect(first(el, "w:sdtContent"), ctx, items);
    else if (is(el, "mc:AlternateContent")) collect(choice(el), ctx, items);
    else if (is(el, "w:customXml") || is(el, "w:ins") || is(el, "w:moveTo")) collect(el, ctx, items);
    else if (is(el, "w:altChunk")) ctx.dropped.add("other_content");
  }
}

function assemble(items: Item[], ctx: Context): JSONContent[] {
  const out: JSONContent[] = [];
  let lists: Lists | null = null;
  let quote: JSONContent | null = null;
  for (const item of items) {
    if (item.list) {
      quote = null;
      lists ??= new Lists(ctx);
      lists.add(item.node, item.list.numId, item.list.ilvl);
      continue;
    }
    if (lists && item.indent && lists.continueWith(item.node, item.indent)) continue;
    if (lists) out.push(...lists.out);
    lists = null;
    if (!item.quote) {
      quote = null;
      out.push(item.node);
    } else {
      if (!quote) out.push((quote = { type: "blockquote", content: [] }));
      quote.content!.push(item.node);
    }
  }
  if (lists) out.push(...lists.out);
  return out;
}

const lastItem = (list: JSONContent) => list.content![list.content!.length - 1];

// Builds nested lists from numbered paragraphs: a higher ilvl nests inside the
// item above, and a new numId or list kind at the same level starts a new list.
class Lists {
  readonly out: JSONContent[] = [];
  private stack: { list: JSONContent; numId: string; ilvl: number; indent: number | null }[] = [];

  constructor(private ctx: Context) {}

  private get top() {
    return this.stack[this.stack.length - 1];
  }

  add(paragraph: JSONContent, numId: string, ilvl: number): void {
    const lvl = level(this.ctx, numId, ilvl)!;
    const type = lvl.ordered ? "orderedList" : "bulletList";
    // Word keeps counting a numId across interruptions and restarts deeper levels.
    const counts = this.ctx.counts.get(numId) ?? [];
    counts.length = ilvl + 1;
    const before = counts[ilvl] ?? 0;
    counts[ilvl] = before + 1;
    this.ctx.counts.set(numId, counts);

    while (this.top && this.top.ilvl > ilvl) this.stack.pop();
    if (this.top?.ilvl === ilvl && (this.top.numId !== numId || this.top.list.type !== type)) this.stack.pop();
    if (!this.top || this.top.ilvl < ilvl) {
      const list: JSONContent = { type, ...(lvl.ordered ? { attrs: { start: lvl.start + before } } : {}), content: [] };
      if (this.top) lastItem(this.top.list).content!.push(list);
      else this.out.push(list);
      this.stack.push({ list, numId, ilvl, indent: lvl.indent });
    }
    this.top.list.content!.push({ type: "listItem", content: [paragraph] });
  }

  // An unnumbered paragraph indented like a level's text is a later paragraph of that level's item.
  continueWith(paragraph: JSONContent, indent: number): boolean {
    for (let at = this.stack.length - 1; at >= 0; at--) {
      if (this.stack[at].indent !== indent) continue;
      this.stack.length = at + 1;
      lastItem(this.top.list).content!.push(paragraph);
      return true;
    }
    return false;
  }
}

function paragraph(p: Element, ctx: Context): Item[] {
  const pPr = first(p, "w:pPr");
  const styleId = attr(first(pPr, "w:pStyle"), "w:val");
  const pieces: JSONContent[] = [];
  inlines(p, ctx, null, pieces);
  if (pieces.length === 0 && isRule(pPr)) return [{ node: { type: "horizontalRule" } }];

  const kind = kindOf(ctx, styleId);
  const textAlign = lookup(ALIGN, attr(prop(ctx, pPr, styleId, "w:jc"), "w:val")) ?? null;
  const numId = attr(prop(ctx, pPr, styleId, "w:numPr/w:numId"), "w:val");
  const ilvl = int(attr(prop(ctx, pPr, styleId, "w:numPr/w:ilvl"), "w:val")) ?? 0;
  const list = kind.type !== "heading" && numId && level(ctx, numId, ilvl) ? { numId, ilvl } : undefined;
  const indent = kind.type === "paragraph" ? indentOf(prop(ctx, pPr, styleId, "w:ind")) : undefined;
  const textBlock = (content: JSONContent[]): JSONContent =>
    kind.type === "heading"
      ? { type: "heading", attrs: { level: kind.level, textAlign }, content }
      : { type: "paragraph", attrs: { textAlign }, content };

  // A picture, rule or page break is a block in DocBro, so it splits the paragraph around it.
  const items: Item[] = [];
  let run: JSONContent[] = [];
  const flush = (always: boolean) => {
    if (run.length || always) items.push({ node: textBlock(run), quote: kind.type === "quote", list: items.length ? undefined : list, indent });
    run = [];
  };
  for (const piece of pieces) {
    if (piece.type === "image" || piece.type === "horizontalRule" || piece.type === "pageBreak") {
      flush(false);
      items.push({ node: piece });
    } else run.push(piece);
  }
  flush(items.length === 0);

  // The paragraph's own page break (a property, or the end of a section) is not an inline break.
  const before: Item[] = toggle(prop(ctx, pPr, styleId, "w:pageBreakBefore")) ? [{ node: { type: "pageBreak" } }] : [];
  const section = first(pPr, "w:sectPr");
  const after: Item[] = section && attr(first(section, "w:type"), "w:val") !== "continuous" ? [{ node: { type: "pageBreak" } }] : [];
  return [...before, ...items, ...after];
}

// An empty paragraph whose only property is a bottom border.
function isRule(pPr: Element | null): boolean {
  const borders = children(first(pPr, "w:pBdr"));
  return borders.length === 1 && is(borders[0], "w:bottom") && !["none", "nil"].includes(attr(borders[0], "w:val") ?? "") &&
    children(pPr).every((el) => is(el, "w:pBdr") || is(el, "w:rPr") || is(el, "w:spacing"));
}

const UNWRAP = ["w:ins", "w:moveTo", "w:smartTag", "w:customXml", "w:fldSimple", "w:dir", "w:bdo"];

// Text, breaks and pictures of a paragraph. Deleted text (w:del, w:moveFrom),
// bookmarks, comment anchors and proofing marks have nothing to keep.
function inlines(parent: Element | null, ctx: Context, link: Mark | null, out: JSONContent[]): void {
  for (const el of children(parent)) {
    if (is(el, "w:r")) run(el, ctx, runMarks(first(el, "w:rPr"), link), out);
    else if (is(el, "w:hyperlink")) {
      const href = ctx.links.get(attr(el, "r:id") ?? "");
      inlines(el, ctx, href ? { type: "link", attrs: { href } } : link, out);
    } else if (is(el, "w:sdt")) inlines(first(el, "w:sdtContent"), ctx, link, out);
    else if (is(el, "mc:AlternateContent")) inlines(choice(el), ctx, link, out);
    else if (UNWRAP.some((name) => is(el, name))) inlines(el, ctx, link, out);
  }
}

const toggle = (el: Element | null) => !!el && !["0", "false", "off"].includes((attr(el, "w:val") ?? "").toLowerCase());
const hex = (value: string | null) => (value && /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : undefined);

// Only direct formatting becomes marks: a style's look (heading size, the
// Hyperlink style's blue underline) belongs to the block or the link.
function runMarks(rPr: Element | null, link: Mark | null): Mark[] {
  const marks: Mark[] = [];
  if (toggle(first(rPr, "w:b"))) marks.push({ type: "bold" });
  if (toggle(first(rPr, "w:i"))) marks.push({ type: "italic" });
  const underline = first(rPr, "w:u");
  if (underline && attr(underline, "w:val") !== "none") marks.push({ type: "underline" });
  if (toggle(first(rPr, "w:strike")) || toggle(first(rPr, "w:dstrike"))) marks.push({ type: "strike" });
  // The source's own default text color (Word and Google Docs stamp one on every run) would vanish on the other theme; a choice is kept.
  const color = hex(attr(first(rPr, "w:color"), "w:val"));
  if (color && !isAutomaticColor(color)) marks.push({ type: "textStyle", attrs: { color } });
  const highlight = lookup(HIGHLIGHT, attr(first(rPr, "w:highlight"), "w:val")) ?? hex(attr(first(rPr, "w:shd"), "w:fill"));
  if (highlight) marks.push({ type: "highlight", attrs: { color: highlight } });
  if (link) marks.push(link);
  return marks;
}

function run(r: Element | null, ctx: Context, marks: Mark[], out: JSONContent[]): void {
  const text = (value: string) => {
    if (value) out.push(marks.length ? { type: "text", text: value, marks } : { type: "text", text: value });
  };
  for (const el of children(r)) {
    if (is(el, "w:t")) text(runText(el));
    else if (is(el, "w:tab") || is(el, "w:ptab")) text("\t");
    else if (is(el, "w:br")) {
      const type = attr(el, "w:type");
      if (type === "page") out.push({ type: "pageBreak" });
      else if (type !== "column") out.push({ type: "hardBreak" });
    } else if (is(el, "w:cr")) out.push({ type: "hardBreak" });
    else if (is(el, "w:noBreakHyphen")) text("‑");
    else if (is(el, "w:softHyphen")) text("­");
    else if (is(el, "w:drawing")) drawing(el, ctx, out);
    else if (is(el, "w:pict")) pict(el, ctx, out);
    else if (is(el, "w:object") || is(el, "w:sym") || is(el, "w:contentPart")) ctx.dropped.add("other_content");
    else if (is(el, "w:ruby")) {
      // The base text stays; the phonetic guide above it (w:rt) is lost.
      inlines(first(el, "w:rubyBase"), ctx, marks.find((m) => m.type === "link") ?? null, out);
      ctx.dropped.add("other_content");
    }
    else if (is(el, "mc:AlternateContent")) run(choice(el), ctx, marks, out);
  }
}

// Word drops the spaces at either end of a w:t unless xml:space="preserve" is in scope.
function runText(t: Element): string {
  const text = (t.textContent ?? "").replace(/[\r\n]+/g, " ");
  let scope: Element | null = t;
  while (scope && !scope.hasAttributeNS(NS.xml, "space")) scope = scope.parentElement;
  return scope?.getAttributeNS(NS.xml, "space") === "preserve" ? text : text.replace(/^[ \t]+|[ \t]+$/g, "");
}

function drawing(el: Element, ctx: Context, out: JSONContent[]): void {
  const blip = descendants(el, "a:blip")[0];
  if (attr(descendants(el, "a:graphicData")[0], "uri") !== PICTURE || !blip) return void ctx.dropped.add("other_content"); // shape, chart, group, …
  picture(attr(blip, "r:embed"), attr(descendants(el, "wp:docPr")[0], "descr") || null, ctx, out, isCover(el, ctx.page), ctx.sized ? drawnSize(el) : null);
}

// The size a drawing was given, in px (9525 EMU to the px).
function drawnSize(drawing: Element): { width: number; height: number } | null {
  const extent = descendants(drawing, "wp:extent")[0];
  const width = Math.round(Number(attr(extent, "cx")) / 9525);
  const height = Math.round(Number(attr(extent, "cy")) / 9525);
  return width > 0 && height > 0 ? { width, height } : null;
}

// A picture pinned to the page, text wrapping off, covering nearly all of it: the page's artwork, not a figure in the text.
function isCover(drawing: Element, page: { width: number; height: number }): boolean {
  const anchor = descendants(drawing, "wp:anchor")[0];
  if (!anchor || !first(anchor, "wp:wrapNone")) return false;
  if (["wp:positionH", "wp:positionV"].some((name) => attr(first(anchor, name), "relativeFrom") !== "page")) return false;
  const extent = first(anchor, "wp:extent");
  return Number(attr(extent, "cx")) >= page.width * 0.9 && Number(attr(extent, "cy")) >= page.height * 0.9;
}

// VML, from older files: a picture, Word's "Horizontal Line", or a shape.
function pict(el: Element, ctx: Context, out: JSONContent[]): void {
  if (descendants(el, "w:txbxContent").length) return; // a text box, reported by `droppedParts`
  if (descendants(el, "v:rect").some((rect) => attr(rect, "o:hr") === "t")) return void out.push({ type: "horizontalRule" });
  const image = descendants(el, "v:imagedata")[0];
  if (image) picture(attr(image, "r:id"), attr(image, "o:title") || null, ctx, out);
  else ctx.dropped.add("other_content");
}

function picture(id: string | null, alt: string | null, ctx: Context, out: JSONContent[], cover = false, size: { width: number; height: number } | null = null): void {
  const src = id ? ctx.images.get(id) : null;
  if (src) out.push({ type: "image", attrs: { src, alt, ...(cover && { cover }), ...size } });
  else if (src === null) ctx.dropped.add("other_content"); // linked from outside the file, or EMF/TIFF/…
}

// --- Tables ----------------------------------------------------------------------

// Rows and cells can sit inside content controls and custom XML.
function flatten(container: Element | null, name: string): Element[] {
  return children(container).flatMap((el) =>
    is(el, name) ? [el] : is(el, "w:sdt") ? flatten(first(el, "w:sdtContent"), name) : is(el, "w:customXml") ? flatten(el, name) : []);
}

// The width of each grid column in px, when the table has a width of its own: a fixed one, or a fixed layout. A table that
// is auto or percent wide fits itself to the page, and its grid is only what the writer measured at the time.
function gridWidths(tbl: Element, textWidth: number): number[] | null {
  const props = first(tbl, "w:tblPr");
  const fixed = attr(first(props, "w:tblW"), "w:type") === "dxa" || attr(first(props, "w:tblLayout"), "w:type") === "fixed";
  if (!fixed) return null;
  const columns = children(first(tbl, "w:tblGrid"), "w:gridCol").map((col) => int(attr(col, "w:w")));
  if (!columns.length || columns.some((w) => !w || w <= 0)) return null;
  // A table wider than the text of the page would run off the paper, so its columns are cut in proportion.
  const px = columns.map((w) => w! / TWIPS_PER_PX);
  const scale = Math.min(1, textWidth / px.reduce((sum, w) => sum + w, 0));
  return px.map((w) => Math.max(1, Math.round(w * scale)));
}

function table(tbl: Element, ctx: Context): JSONContent | null {
  const grid = gridWidths(tbl, ctx.textWidth);
  const rows = flatten(tbl, "w:tr").flatMap((tr) => {
    const trPr = first(tr, "w:trPr");
    if (first(trPr, "w:del")) return []; // a tracked deletion
    let col = int(attr(first(trPr, "w:gridBefore"), "w:val")) ?? 0;
    const cells = flatten(tr, "w:tc").map((tc) => {
      const tcPr = first(tc, "w:tcPr");
      const span = Math.max(1, int(attr(first(tcPr, "w:gridSpan"), "w:val")) ?? 1);
      const vMerge = first(tcPr, "w:vMerge");
      const merge = vMerge ? (attr(vMerge, "w:val") === "restart" ? "restart" : "continue") : null;
      // A page break has no place inside a cell: the table is one block, and the layout never splits it.
      const content = blocks(tc, ctx).filter((n) => n.type !== "pageBreak");
      const colwidth = grid && col + span <= grid.length ? grid.slice(col, col + span) : null;
      const cell = { col, span, merge, rowspan: 1, covered: false, content, colwidth };
      col += span;
      return cell;
    });
    return cells.length ? [{ header: toggle(first(trPr, "w:tblHeader")), cells }] : [];
  });

  // A vertical merge is a "restart" cell and the "continue" cells below it in the same grid column.
  rows.forEach((row, r) => {
    for (const cell of row.cells.filter((c) => c.merge === "restart")) {
      for (const below of rows.slice(r + 1)) {
        const next = below.cells.find((c) => c.col === cell.col && c.merge === "continue" && !c.covered);
        if (!next) break;
        next.covered = true;
        cell.rowspan++;
        if (next.content.some((n) => n.type !== "paragraph" || n.content?.length)) cell.content.push(...next.content);
      }
    }
  });

  const content = rows.map((row) => ({
    type: "tableRow",
    content: row.cells.filter((c) => !c.covered).map((c) => ({
      type: row.header ? "tableHeader" : "tableCell",
      attrs: { colspan: c.span, rowspan: c.rowspan, colwidth: c.colwidth },
      content: c.content.length ? c.content : [{ type: "paragraph" }],
    })),
  }));
  return content.length ? { type: "table", content } : null;
}

// A cover ends its page, so what Word needed to get the text below its artwork is not kept: the blank
// paragraphs right after it, and one page break (a second would be a blank page of the writer's own).
function trimCovers(content: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (let i = 0; i < content.length; i++) {
    out.push(content[i]);
    if (content[i].type !== "image" || !content[i].attrs?.cover) continue;
    let breakSeen = false;
    for (let next = content[i + 1]; next; next = content[i + 1]) {
      const blank = next.type === "paragraph" && !next.content?.length;
      const breaks = next.type === "pageBreak" && !breakSeen;
      if (!blank && !breaks) break;
      if (breaks) breakSeen = true;
      i++;
    }
  }
  return out;
}

// --- Result ----------------------------------------------------------------------

let schema: Schema | undefined;

// Through the editor schema: fills default attrs, merges adjacent text and
// checks the structure, so the editor never gets an invalid document.
function finish(content: JSONContent[]): JSONContent {
  schema ??= getSchema(createExtensions());
  try {
    const doc = schema.nodeFromJSON({ type: "doc", content: content.length ? content : [{ type: "paragraph" }] });
    doc.check();
    return doc.toJSON();
  } catch (error) {
    throw new Error(`DocBro could not read this Word document (${(error as Error).message})`);
  }
}
