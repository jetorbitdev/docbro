import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  SimpleField,
  Tab,
  TabStopPosition,
  TabStopType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  TextWrappingSide,
  TextWrappingType,
  UnderlineType,
  VerticalPositionRelativeFrom,
  WidthType,
  type ILevelsOptions,
  type IParagraphOptions,
} from "docx";
import { PAPER, TWIPS_PER_PX, type DocMeta, type KeptPart } from "../../doc/meta";
import { fieldName } from "../../editor/field";
import { MEDIA_TYPES } from "./media";

type Block = Paragraph | Table;
type Inline = TextRun | ExternalHyperlink | ImageRun | PageBreak | SimpleField;

const MARGIN = 1440; // 1in
const MIN_COLUMN = 40; // px: the least a column nobody sized is given
const LEVEL_INDENT = 720;
const LEVEL_HANGING = 360;
const BULLETS = ["•", "◦", "▪"];

const ALIGNMENT = {
  left: AlignmentType.START,
  center: AlignmentType.CENTER,
  right: AlignmentType.END,
  justify: AlignmentType.BOTH,
} as const;

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3] as const;

// State shared across one export: `docx` has no per-list start, so each distinct
// start gets its own numbering reference, and every list gets its own instance.
interface Context {
  nextInstance: number;
  starts: Set<number>;
  imageWidth: number; // px: the text width of the page, the widest a picture is written
  page: { width: number; height: number }; // px: what a cover is stretched to
}

// `meta.header` and `meta.footer` are the one-line zones DocBro's paper shows; page
// numbers become a Page/NumPages field pair at the footer's right edge. A header or footer
// part the file came with is written back as it was, after the package is made.
export async function exportDocx(doc: JSONContent, meta?: DocMeta): Promise<Uint8Array> {
  const paper = PAPER[meta?.pageSize ?? "letter"];
  const ctx: Context = { nextInstance: 0, starts: new Set([1]), imageWidth: (paper.width - 2 * MARGIN) / TWIPS_PER_PX,
    page: { width: paper.width / TWIPS_PER_PX, height: paper.height / TWIPS_PER_PX },
  };
  const children: Block[] = blocks(doc.content, ctx);
  if (children.length === 0) children.push(new Paragraph({}));
  // The library makes the part, the relationship and the section's reference; `graft` swaps in the file's own content.
  // An edited part is written from what it shows.
  const header = meta?.headerPart
    ? new Header({ children: partChildren(meta.headerPart, ctx) })
    : meta && meta.header !== null
      ? new Header({ children: [new Paragraph({ children: meta.header ? [new TextRun(meta.header)] : [] })] })
      : undefined;
  const footer = meta?.footerPart
    ? new Footer({ children: partChildren(meta.footerPart, ctx) })
    : meta && (meta.footer !== null || meta.pageNumbers)
      ? new Footer({ children: [footerParagraph(meta)] })
      : undefined;

  const file = new Document({
    creator: "DocBro",
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22 }, paragraph: { spacing: { after: 160, line: 276 } } },
        heading1: { run: { size: 40, bold: true }, paragraph: { spacing: { before: 360, after: 120 } } },
        heading2: { run: { size: 32, bold: true }, paragraph: { spacing: { before: 280, after: 100 } } },
        heading3: { run: { size: 26, bold: true }, paragraph: { spacing: { before: 240, after: 80 } } },
      },
      paragraphStyles: [
        {
          id: "Quote",
          name: "Quote",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          paragraph: {
            indent: { left: LEVEL_INDENT },
            border: { left: { style: BorderStyle.SINGLE, size: 18, space: 12, color: "a0a0a0" } },
          },
          run: { color: "595959" },
        },
      ],
    },
    numbering: {
      config: [
        { reference: "docbro-bullet", levels: bulletLevels() },
        ...[...ctx.starts].map((start) => ({ reference: numberReference(start), levels: numberLevels(start) })),
      ],
    },
    sections: [
      {
        properties: { page: { size: paper, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } },
        ...(header && { headers: { default: header } }),
        ...(footer && { footers: { default: footer } }),
        children,
      },
    ],
  });
  const bytes = await Packer.pack(file, "uint8array");
  const untouched = (part: KeptPart | null | undefined): Untouched | null => (part && part.xml !== null ? { ...part, xml: part.xml } : null);
  const parts = { header: untouched(meta?.headerPart), footer: untouched(meta?.footerPart) };
  return parts.header || parts.footer ? graft(bytes, parts) : bytes;
}

// What a kept part is written as: a placeholder for `graft` while it is as the file had it, else its blocks. A picture
// floats at the left of the line of text after it, with the text running beside it, as the page shows it (PartView).
function partChildren(part: KeptPart, ctx: Context): Block[] {
  if (part.xml !== null) return [new Paragraph({})];
  const out: Block[] = [];
  let pictures: Inline[] = [];
  for (const node of part.view?.content ?? []) {
    if (node.type === "image") {
      pictures.push(image(node, ctx, true));
    } else if ((node.type === "paragraph" || node.type === "heading") && pictures.length) {
      out.push(...block(node, ctx, false, pictures));
      pictures = [];
    } else {
      if (pictures.length) out.push(new Paragraph({ children: pictures }));
      pictures = [];
      out.push(...block(node, ctx, false));
    }
  }
  if (pictures.length) out.push(new Paragraph({ children: pictures }));
  return out.length ? out : [new Paragraph({})];
}

// The library writes files only, and so does the graft: a package with folder entries is not what Word makes.
const NO_FOLDERS = { createFolders: false };

// Puts the kept parts, their relationships and their pictures into a package that has a placeholder for each.
type Untouched = KeptPart & { xml: string };

async function graft(bytes: Uint8Array, parts: { header: Untouched | null; footer: Untouched | null }): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const relsPath = "word/_rels/document.xml.rels";
  const documentRels = await zip.file(relsPath)!.async("string");
  const extensions = new Set<string>();

  for (const [kind, part] of [["header", parts.header], ["footer", parts.footer]] as const) {
    if (!part) continue;
    const reference = [...documentRels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((tag) => new RegExp(`Type="[^"]*/${kind}"`).test(tag));
    const target = reference && /Target="([^"]+)"/.exec(reference)?.[1];
    if (!target) throw new Error(`The ${kind} could not be written`);
    const path = `word/${target.replace(/^\/?(word\/)?/, "")}`;
    zip.file(path, part.xml, NO_FOLDERS);
    if (part.rels) zip.file(`word/_rels/${path.slice(path.lastIndexOf("/") + 1)}.rels`, part.rels, NO_FOLDERS);
    for (const [name, data] of Object.entries(part.media)) {
      zip.file(`word/media/${name}`, data, { ...NO_FOLDERS, base64: true });
      extensions.add(name.slice(name.lastIndexOf(".") + 1));
    }
  }

  // A picture's extension needs a content type of its own, which the library only adds for pictures it wrote.
  const typesPath = "[Content_Types].xml";
  let types = await zip.file(typesPath)!.async("string");
  for (const extension of extensions) {
    if (new RegExp(`<Default\\b[^>]*Extension="${extension}"`, "i").test(types)) continue;
    types = types.replace(/(<Types\b[^>]*>)/, `$1<Default Extension="${extension}" ContentType="${MEDIA_TYPES[extension] ?? "application/octet-stream"}"/>`);
  }
  zip.file(typesPath, types, NO_FOLDERS);
  return zip.generateAsync({ type: "uint8array" });
}

function footerParagraph(meta: DocMeta): Paragraph {
  const children: TextRun[] = [];
  if (meta.footer) children.push(new TextRun(meta.footer));
  if (meta.pageNumbers) {
    if (meta.footer) children.push(new TextRun({ children: [new Tab()] }));
    children.push(
      new TextRun("Page "),
      new TextRun({ children: [PageNumber.CURRENT] }),
      new TextRun(" of "),
      new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
    );
  }
  return new Paragraph({
    tabStops: meta.footer && meta.pageNumbers ? [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }] : undefined,
    children,
  });
}

const numberReference = (start: number) => (start === 1 ? "docbro-number" : `docbro-number-${start}`);

const levelIndent = (level: number) => ({ left: (level + 1) * LEVEL_INDENT, hanging: LEVEL_HANGING });

function bulletLevels(): ILevelsOptions[] {
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    format: LevelFormat.BULLET,
    text: BULLETS[level % BULLETS.length],
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: levelIndent(level) } },
  }));
}

function numberLevels(start: number): ILevelsOptions[] {
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    start,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: levelIndent(level) } },
  }));
}

function blocks(nodes: JSONContent[] | undefined, ctx: Context, quoted = false): Block[] {
  return (nodes ?? []).flatMap((node) => block(node, ctx, quoted));
}

// `lead` goes in front of the text of a paragraph or heading: pictures floating beside it.
function block(node: JSONContent, ctx: Context, quoted: boolean, lead: Inline[] = []): Block[] {
  switch (node.type) {
    case "paragraph":
      return [paragraph(node, ctx, quoted ? { style: "Quote" } : {}, lead)];
    case "heading": {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1));
      return [paragraph(node, ctx, { heading: HEADINGS[level - 1] }, lead)];
    }
    case "blockquote":
      return blocks(node.content, ctx, true);
    case "horizontalRule":
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: "auto" } } })];
    case "bulletList":
    case "orderedList":
      return list(node, ctx, 0);
    case "table":
      return table(node, ctx);
    case "pageBreak":
      return [new Paragraph({ children: [new PageBreak()] })];
    case "image":
      // a cover is pinned to the page behind the text, and the page break ends it
      return [new Paragraph({ children: node.attrs?.cover ? [...inline([node], ctx), new PageBreak()] : inline([node], ctx) })];
    default:
      return blocks(node.content, ctx, quoted);
  }
}

function paragraph(node: JSONContent, ctx: Context, options: IParagraphOptions = {}, lead: Inline[] = []): Paragraph {
  const align = ALIGNMENT[node.attrs?.textAlign as keyof typeof ALIGNMENT];
  return new Paragraph({ ...options, alignment: align, children: [...lead, ...inline(node.content, ctx)] });
}

function list(node: JSONContent, ctx: Context, depth: number): Block[] {
  const level = Math.min(depth, 8);
  let reference = "docbro-bullet";
  let instance = 0;
  if (node.type === "orderedList") {
    const start = Number.isInteger(node.attrs?.start) && node.attrs!.start >= 0 ? (node.attrs!.start as number) : 1;
    ctx.starts.add(start);
    reference = numberReference(start);
    instance = ctx.nextInstance++;
  }

  const out: Block[] = [];
  for (const item of node.content ?? []) {
    (item.content ?? []).forEach((child, index) => {
      if (child.type === "bulletList" || child.type === "orderedList") out.push(...list(child, ctx, depth + 1));
      else if (child.type === "paragraph" && index === 0) out.push(paragraph(child, ctx, { numbering: { reference, level, instance } }));
      else if (child.type === "paragraph") out.push(paragraph(child, ctx, { indent: { left: levelIndent(level).left } }));
      else out.push(...block(child, ctx, false));
    });
  }
  return out;
}

// Where each cell starts in the table's grid, and the width in px that dragging gave each grid column (a column nobody
// sized has none). Cells below a cell that spans rows leave its columns out of their count, as in the table's markup.
function gridOf(rows: JSONContent[]): { start: Map<JSONContent, number>; widths: (number | undefined)[]; columns: number } {
  const start = new Map<JSONContent, number>();
  const widths: (number | undefined)[] = [];
  let columns = 0;
  let spanning: number[] = []; // rows each column is still covered for by a cell from above
  for (const row of rows) {
    const next = spanning.map((n) => Math.max(0, n - 1));
    let col = 0;
    for (const cell of row.content ?? []) {
      while ((spanning[col] ?? 0) > 0) col++;
      const span = Math.max(1, Number(cell.attrs?.colspan) || 1);
      const rowspan = Math.max(1, Number(cell.attrs?.rowspan) || 1);
      const colwidth = Array.isArray(cell.attrs?.colwidth) ? (cell.attrs!.colwidth as number[]) : [];
      start.set(cell, col);
      for (let k = 0; k < span; k++) {
        if (colwidth[k] > 0) widths[col + k] = colwidth[k];
        next[col + k] = rowspan - 1;
      }
      col += span;
    }
    columns = Math.max(columns, col, spanning.length);
    spanning = next;
  }
  return { start, widths, columns };
}

// The columns in twips, with the page's text width shared among those nobody sized; null when none has a width.
function columnTwips({ widths, columns }: ReturnType<typeof gridOf>, textWidth: number): number[] | null {
  const sized = Array.from({ length: columns }, (_, i) => widths[i]);
  if (!sized.some((w) => w !== undefined)) return null;
  const unsized = sized.filter((w) => w === undefined).length;
  const share = unsized ? Math.max(MIN_COLUMN, (textWidth - sized.reduce<number>((sum, w) => sum + (w ?? 0), 0)) / unsized) : 0;
  return sized.map((w) => Math.round((w ?? share) * TWIPS_PER_PX));
}

function table(node: JSONContent, ctx: Context): Block[] {
  const sourceRows = (node.content ?? []).filter((row) => row.type === "tableRow" && row.content?.length);
  const grid = gridOf(sourceRows);
  const twips = columnTwips(grid, ctx.imageWidth);
  const rows = sourceRows
    .map(
      (row) =>
        new TableRow({
          // Left unset for a body row: `docx` would write `w:tblHeader w:val="off"` for false.
          tableHeader: row.content!.every((cell) => cell.type === "tableHeader") ? true : undefined,
          children: row.content!.map((cell) => {
            const children = blocks(cell.content, ctx) as (Paragraph | Table)[];
            if (children.length === 0 || children[children.length - 1] instanceof Table) children.push(new Paragraph({}));
            const columnSpan = Number(cell.attrs?.colspan) || 1;
            const rowSpan = Number(cell.attrs?.rowspan) || 1;
            const first = grid.start.get(cell) ?? 0;
            const width = twips && twips.slice(first, first + columnSpan).reduce((sum, w) => sum + w, 0);
            return new TableCell({
              children,
              columnSpan: columnSpan > 1 ? columnSpan : undefined,
              rowSpan: rowSpan > 1 ? rowSpan : undefined,
              width: width ? { size: width, type: WidthType.DXA } : undefined,
            });
          }),
        }),
    );
  if (!rows.length) return [];
  // Widths the writer dragged are kept exactly (a fixed layout); a table nobody resized is as wide as the page.
  return [
    twips
      ? new Table({
          rows,
          columnWidths: twips,
          width: { size: twips.reduce((sum, w) => sum + w, 0), type: WidthType.DXA },
          layout: TableLayoutType.FIXED,
        })
      : new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }),
  ];
}

function inline(nodes: JSONContent[] | undefined, ctx: Context): Inline[] {
  return (nodes ?? []).flatMap((node): Inline[] => {
    if (node.type === "hardBreak") return [new TextRun({ break: 1 })];
    if (node.type === "image") return [image(node, ctx)];
    if (node.type === "field") return [field(node)];
    if (node.type === "text" && node.text) return [text(node)];
    return [];
  });
}

// A page number is written as Word writes one; any other field as the instruction and the value it showed.
function field(node: JSONContent): TextRun | SimpleField {
  const instr = String(node.attrs?.instr ?? "");
  const number = { PAGE: PageNumber.CURRENT, NUMPAGES: PageNumber.TOTAL_PAGES, SECTIONPAGES: PageNumber.TOTAL_PAGES_IN_SECTION }[fieldName(instr)];
  const bold = node.marks?.some((m) => m.type === "bold") || undefined;
  const italics = node.marks?.some((m) => m.type === "italic") || undefined;
  return number ? new TextRun({ children: [number], bold, italics }) : new SimpleField(instr, String(node.attrs?.text ?? ""));
}

// Only a "#rrggbb" color is written; `shd` and `color` take a bare hex value.
const hex = (color: unknown): string | undefined =>
  typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : undefined;

function text(node: JSONContent): TextRun | ExternalHyperlink {
  const mark = (type: string) => node.marks?.find((m) => m.type === type);
  const color = hex(mark("textStyle")?.attrs?.color);
  const fill = hex(mark("highlight")?.attrs?.color);
  const href = mark("link")?.attrs?.href;
  const link = typeof href === "string" && href !== "" ? href : undefined;

  const parts = node.text!.split("\t");
  const run = new TextRun({
    children: parts.flatMap((part, i) => [...(i > 0 ? [new Tab()] : []), ...(part ? [part] : [])]),
    bold: mark("bold") ? true : undefined,
    italics: mark("italic") ? true : undefined,
    underline: mark("underline") ? { type: UnderlineType.SINGLE } : undefined,
    strike: mark("strike") ? true : undefined,
    color,
    shading: fill ? { type: ShadingType.CLEAR, fill, color: "auto" } : undefined,
    style: link ? "Hyperlink" : undefined,
  });
  return link ? new ExternalHyperlink({ link, children: [run] }) : run;
}

type ImageType = "png" | "jpg" | "gif";

// A data URL of a PNG, JPEG or GIF whose header says how big it is. Anything
// else (a remote URL, SVG, WebP, a damaged file) has no picture in the .docx.
function decodeImage(src: string): { type: ImageType; data: Uint8Array; width: number; height: number } | undefined {
  const match = /^data:image\/(png|jpe?g|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
  if (!match) return undefined;
  const type: ImageType = match[1].toLowerCase() === "png" ? "png" : match[1].toLowerCase() === "gif" ? "gif" : "jpg";
  let data: Uint8Array;
  try {
    data = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
  const size = pixelSize(type, data);
  return size && size.width > 0 && size.height > 0 ? { type, data, ...size } : undefined;
}

function pixelSize(type: ImageType, b: Uint8Array): { width: number; height: number } | undefined {
  const be16 = (i: number) => (b[i] << 8) | b[i + 1];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const be32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

  if (type === "png") return b.length >= 24 && be32(0) === 0x89504e47 ? { width: be32(16), height: be32(20) } : undefined;
  if (type === "gif") return b.length >= 10 && b[0] === 0x47 ? { width: le16(6), height: le16(8) } : undefined;

  // JPEG: walk the segments to the first start-of-frame marker.
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: be16(i + 5), width: be16(i + 7) };
    i += 2 + Math.max(2, be16(i + 2));
  }
  return undefined;
}

// `float`: anchored at the left of its paragraph, with the text running down its right side.
function image(node: JSONContent, ctx: Context, float = false): ImageRun | TextRun {
  const alt = typeof node.attrs?.alt === "string" && node.attrs.alt !== "" ? (node.attrs.alt as string) : undefined;
  const decoded = decodeImage(String(node.attrs?.src ?? ""));
  if (!decoded) return new TextRun(alt ?? "[image]");

  if (node.attrs?.cover)
    return new ImageRun({
      type: decoded.type,
      data: decoded.data,
      transformation: ctx.page,
      altText: alt ? { description: alt } : undefined,
      floating: {
        horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
        verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
        behindDocument: true,
        allowOverlap: true,
        wrap: { type: TextWrappingType.NONE },
      },
    });

  // A size the picture was given (a header's logo) is kept; otherwise it is as big as it is, up to the text width.
  const given = Number(node.attrs?.width) > 0 && Number(node.attrs?.height) > 0;
  const scale = Math.min(1, ctx.imageWidth / (given ? Number(node.attrs!.width) : decoded.width));
  const width = given ? Number(node.attrs!.width) : decoded.width;
  const height = given ? Number(node.attrs!.height) : decoded.height;
  return new ImageRun({
    type: decoded.type,
    data: decoded.data,
    transformation: { width: Math.round(width * scale), height: Math.max(1, Math.round(height * scale)) },
    altText: alt ? { description: alt } : undefined,
    ...(float && {
      floating: {
        horizontalPosition: { relative: HorizontalPositionRelativeFrom.COLUMN, offset: 0 },
        verticalPosition: { relative: VerticalPositionRelativeFrom.PARAGRAPH, offset: 0 },
        wrap: { type: TextWrappingType.SQUARE, side: TextWrappingSide.RIGHT },
      },
    }),
  });
}
