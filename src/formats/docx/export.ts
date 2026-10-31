import type { JSONContent } from "@tiptap/core";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Tab,
  TabStopPosition,
  TabStopType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type ILevelsOptions,
  type IParagraphOptions,
} from "docx";
import type { DocMeta } from "../../doc/meta";

type Block = Paragraph | Table;
type Inline = TextRun | ExternalHyperlink | ImageRun;

const MAX_IMAGE_WIDTH = 624; // px: 6.5in, the text width of a Letter page with 1in margins
const LETTER = { width: 12240, height: 15840 }; // twips
const MARGIN = 1440; // 1in
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
}

// `meta.header` and `meta.footer` are the one-line zones DocBro's paper shows; page
// numbers become a Page/NumPages field pair at the footer's right edge.
export async function exportDocx(doc: JSONContent, meta?: DocMeta): Promise<Uint8Array> {
  const ctx: Context = { nextInstance: 0, starts: new Set([1]) };
  const children: Block[] = blocks(doc.content, ctx);
  if (children.length === 0) children.push(new Paragraph({}));
  const header =
    meta && meta.header !== null
      ? new Header({ children: [new Paragraph({ children: meta.header ? [new TextRun(meta.header)] : [] })] })
      : undefined;
  const footer = meta && (meta.footer !== null || meta.pageNumbers) ? new Footer({ children: [footerParagraph(meta)] }) : undefined;

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
        properties: { page: { size: LETTER, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } },
        ...(header && { headers: { default: header } }),
        ...(footer && { footers: { default: footer } }),
        children,
      },
    ],
  });
  return Packer.pack(file, "uint8array");
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

function block(node: JSONContent, ctx: Context, quoted: boolean): Block[] {
  switch (node.type) {
    case "paragraph":
      return [paragraph(node, quoted ? { style: "Quote" } : {})];
    case "heading": {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1));
      return [paragraph(node, { heading: HEADINGS[level - 1] })];
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
    case "image":
      return [new Paragraph({ children: inline([node]) })];
    default:
      return blocks(node.content, ctx, quoted);
  }
}

function paragraph(node: JSONContent, options: IParagraphOptions = {}): Paragraph {
  const align = ALIGNMENT[node.attrs?.textAlign as keyof typeof ALIGNMENT];
  return new Paragraph({ ...options, alignment: align, children: inline(node.content) });
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
      else if (child.type === "paragraph" && index === 0) out.push(paragraph(child, { numbering: { reference, level, instance } }));
      else if (child.type === "paragraph") out.push(paragraph(child, { indent: { left: levelIndent(level).left } }));
      else out.push(...block(child, ctx, false));
    });
  }
  return out;
}

function table(node: JSONContent, ctx: Context): Block[] {
  const rows = (node.content ?? [])
    .filter((row) => row.type === "tableRow" && row.content?.length)
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
            return new TableCell({
              children,
              columnSpan: columnSpan > 1 ? columnSpan : undefined,
              rowSpan: rowSpan > 1 ? rowSpan : undefined,
            });
          }),
        }),
    );
  return rows.length ? [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })] : [];
}

function inline(nodes: JSONContent[] | undefined): Inline[] {
  return (nodes ?? []).flatMap((node): Inline[] => {
    if (node.type === "hardBreak") return [new TextRun({ break: 1 })];
    if (node.type === "image") return [image(node)];
    if (node.type === "text" && node.text) return [text(node)];
    return [];
  });
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

function image(node: JSONContent): ImageRun | TextRun {
  const alt = typeof node.attrs?.alt === "string" && node.attrs.alt !== "" ? (node.attrs.alt as string) : undefined;
  const decoded = decodeImage(String(node.attrs?.src ?? ""));
  if (!decoded) return new TextRun(alt ?? "[image]");

  const scale = Math.min(1, MAX_IMAGE_WIDTH / decoded.width);
  return new ImageRun({
    type: decoded.type,
    data: decoded.data,
    transformation: { width: Math.round(decoded.width * scale), height: Math.max(1, Math.round(decoded.height * scale)) },
    altText: alt ? { description: alt } : undefined,
  });
}
