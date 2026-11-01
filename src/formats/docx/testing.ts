import { getSchema, type JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import { createExtensions } from "../../editor/extensions";

// Test helpers for the .docx importer. Tasks 6, 13 and 14 reuse `buildDocx`.

type Mark = NonNullable<JSONContent["marks"]>[number];

const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"',
  'mc:Ignorable="w14 w15"',
].join(" ");

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml";

// A string that starts with an XML declaration is a whole part, used as given;
// anything else is the content of the part's root element.
const part = (root: string, inner: string) =>
  inner.trimStart().startsWith("<?xml") ? inner : `${DECLARATION}<${root} ${NAMESPACES}>${inner}</${root}>`;

// A minimal .docx package. `document` is the content of `w:body`; `styles` and
// `numbering` are the content of their root elements. Any of the three may
// instead be a whole part starting with `<?xml`.
export async function buildDocx(parts: {
  document: string;
  styles?: string;
  numbering?: string;
  // "first-page-only" is a header Word shows on the first page alone: a variant DocBro keeps nowhere.
  header?: boolean | "two-paragraphs" | "first-page-only";
  // true: one comment that nothing in the text refers to; a string: the content of `w:comments`
  comments?: boolean | string;
  // the content of `w15:commentsEx`: reply threads and resolved comments
  commentsExtended?: string;
}): Promise<Uint8Array> {
  const overrides = [`<Override PartName="/word/document.xml" ContentType="${TYPE}.document.main+xml"/>`];
  const rels: string[] = [];
  const whole = parts.document.trimStart().startsWith("<?xml");
  const files: Record<string, string> = {};
  const add = (name: string, kind: string, xml: string) => {
    files[`word/${name}.xml`] = xml;
    overrides.push(`<Override PartName="/word/${name}.xml" ContentType="${TYPE}.${kind}+xml"/>`);
    const id = `rId${rels.length + 1}`;
    rels.push(`<Relationship Id="${id}" Type="${REL}/${kind}" Target="${name}.xml"/>`);
    return id;
  };
  if (parts.styles !== undefined) add("styles", "styles", part("w:styles", parts.styles));
  if (parts.numbering !== undefined) add("numbering", "numbering", part("w:numbering", parts.numbering));
  let headerId: string | undefined;
  if (parts.header) {
    const paragraphs =
      parts.header === "two-paragraphs"
        ? "<w:p><w:r><w:t>Header text</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p>"
        : "<w:p><w:r><w:t>Header text</w:t></w:r></w:p>";
    headerId = add("header1", "header", part("w:hdr", paragraphs));
  }
  if (parts.comments)
    add("comments", "comments", part("w:comments", typeof parts.comments === "string" ? parts.comments :
      '<w:comment w:id="0" w:author="Rina" w:date="2026-10-01T09:00:00Z" w:initials="R"><w:p><w:r><w:t>Comment text</w:t></w:r></w:p></w:comment>'));
  if (parts.commentsExtended !== undefined) add("commentsExtended", "commentsExtended", part("w15:commentsEx", parts.commentsExtended));

  // Without a section reference Word would not use the header, and the importer would not see it.
  const section = headerId
    ? `<w:sectPr><w:headerReference w:type="${parts.header === "first-page-only" ? "first" : "default"}" r:id="${headerId}"/>` +
      '<w:pgSz w:w="12240" w:h="15840"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
    : "";
  files["word/document.xml"] = whole
    ? parts.document
    : part("w:document", `<w:body>${parts.document}${section}</w:body>`);

  return zipWith({
    ...files,
    "[Content_Types].xml":
      `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
      `${overrides.join("")}</Types>`,
    "_rels/.rels":
      `${DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels":
      `${DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
  });
}

export async function zipWith(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array" });
}

// Fill in every default attribute the schema adds (`textAlign: null`,
// `alt: null`, …) and merge adjacent text, so both sides of a comparison match.
export function normalize(doc: JSONContent): JSONContent {
  return getSchema(createExtensions()).nodeFromJSON(doc).toJSON();
}

export function findMark(node: JSONContent, type: string): Mark | undefined {
  const mark = node.marks?.find((m) => m.type === type);
  if (mark) return mark;
  for (const child of node.content ?? []) {
    const found = findMark(child, type);
    if (found) return found;
  }
  return undefined;
}

// The document's text, one line per text block.
export function plainText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const inner = (node.content ?? []).map(plainText);
  return node.type === "paragraph" || node.type === "heading" ? inner.join("") : inner.join("\n");
}

// What Word 365 writes, trimmed to the parts the importer reads (plus some of
// the noise it ignores: rsids, w14 ids, theme fonts).

export const WORD_STYLES = `
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="Heading1Char"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi"/><w:color w:val="0F4761" w:themeColor="accent1" w:themeShade="BF"/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="TitleChar"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="80" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr><w:spacing w:val="-10"/><w:kern w:val="28"/><w:sz w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="QuoteChar"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:spacing w:before="160"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>`;

const wordLevel = (ilvl: number, format: string, text: string) =>
  `<w:lvl w:ilvl="${ilvl}" w:tplc="0409000${ilvl + 1}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${(ilvl + 1) * 720}" w:hanging="360"/></w:pPr></w:lvl>`;

export const WORD_NUMBERING = `
<w:abstractNum w:abstractNumId="0" w15:restartNumberingAfterBreak="0"><w:nsid w:val="1A2B3C4D"/><w:multiLevelType w:val="hybridMultilevel"/><w:tmpl w:val="04090001"/>${wordLevel(0, "bullet", "")}${wordLevel(1, "bullet", "o")}</w:abstractNum>
<w:abstractNum w:abstractNumId="1" w15:restartNumberingAfterBreak="0"><w:nsid w:val="5E6F7A8B"/><w:multiLevelType w:val="hybridMultilevel"/><w:tmpl w:val="0409000F"/>${wordLevel(0, "decimal", "%1.")}${wordLevel(1, "lowerLetter", "%2.")}</w:abstractNum>
<w:num w:numId="1" w16cid:durableId="101" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2" w16cid:durableId="102" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"><w:abstractNumId w:val="1"/></w:num>`;

const wordParagraph = (style: string | null, runs: string, numbering = "") =>
  `<w:p w14:paraId="1F2E3D4C" w14:textId="77777777" w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3">` +
  (style || numbering ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${numbering}</w:pPr>` : "") +
  `${runs}</w:p>`;
const wordRun = (text: string, rPr = "") =>
  `<w:r w:rsidRPr="00D4E5F6">${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const numPr = (numId: number, ilvl = 0) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;

export const WORD_STYLE_BODY =
  wordParagraph("Title", wordRun("Laporan Tahunan")) +
  wordParagraph(null, wordRun("Angka ") + '<w:proofErr w:type="spellStart"/>' + wordRun("penting", '<w:highlight w:val="yellow"/>') + '<w:proofErr w:type="spellEnd"/>' + wordRun(" tahun ini.")) +
  wordParagraph("Quote", wordRun("Kutipan dari direktur.")) +
  wordParagraph("ListParagraph", wordRun("Apel"), numPr(1)) +
  wordParagraph("ListParagraph", wordRun("Jeruk"), numPr(1)) +
  wordParagraph("ListParagraph", wordRun("Langkah pertama"), numPr(2)) +
  wordParagraph("ListParagraph", wordRun("Langkah kedua"), numPr(2)) +
  '<w:sectPr w:rsidR="00A1B2C3"><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>';

const TEXT_BOX =
  '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
  '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
  '<wp:extent cx="1828800" cy="457200"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="Text Box 1"/><wp:cNvGraphicFramePr/>' +
  '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr/>' +
  "<wps:txbx><w:txbxContent><w:p><w:r><w:t>Isi kotak teks</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>" +
  '<mc:Fallback><w:pict><v:shape id="Text Box 1" o:spid="_x0000_s1026" type="#_x0000_t202"><v:textbox><w:txbxContent><w:p><w:r><w:t>Isi kotak teks</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>';

export const BODY_WITH_INS_DEL_AND_TEXTBOX =
  wordParagraph(null,
    wordRun("Teks awal, ") +
    '<w:ins w:id="1" w:author="Rina" w:date="2026-10-01T09:00:00Z">' + wordRun("inserted") + "</w:ins>" +
    '<w:del w:id="2" w:author="Rina" w:date="2026-10-01T09:00:00Z"><w:r><w:delText xml:space="preserve">deleted</w:delText></w:r></w:del>' +
    wordRun(" teks akhir.")) +
  wordParagraph(null, wordRun("Di samping kotak. ") + TEXT_BOX);
