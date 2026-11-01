/**
 * The typefaces the Font picker offers: ones a Mac and a Windows PC both have, or that Word brings (Calibri, Cambria),
 * so a .docx keeps its look where it is opened. The stack is what the page draws when the computer lacks the face.
 */
export const FONTS: { name: string; stack: string }[] = [
  { name: "Inter", stack: "'Inter', system-ui, sans-serif" },
  { name: "Arial", stack: "Arial, Helvetica, sans-serif" },
  { name: "Calibri", stack: "Calibri, Carlito, 'Segoe UI', sans-serif" },
  { name: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  { name: "Trebuchet MS", stack: "'Trebuchet MS', Helvetica, sans-serif" },
  { name: "Cambria", stack: "Cambria, Caladea, Georgia, serif" },
  { name: "Georgia", stack: "Georgia, 'Times New Roman', serif" },
  { name: "Times New Roman", stack: "'Times New Roman', Times, serif" },
  { name: "Courier New", stack: "'Courier New', Courier, monospace" },
];

// A name from a file or a paste goes into a style attribute, so it is letters, digits, spaces and a few marks.
const NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;

// What a web page's font stack ends in or starts with when it means "the system's own": not a choice of the writer's.
const SYSTEM = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|inherit|initial|unset)$/i;

/** The name as a typeface the document can keep, or null for one that is empty, generic or not safe to write into CSS. */
export function fontName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return NAME.test(name) && !SYSTEM.test(name) ? name : null;
}

/** The first face of a CSS `font-family` list, without its quotes: `'Georgia', serif` is Georgia. */
export function firstFamily(css: string): string | null {
  const first = css.split(",")[0]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  return fontName(first);
}

/** The CSS `font-family` for a face: the picker's own stack, else the face with the page's sans-serif behind it. */
export function fontStack(name: string): string {
  const known = FONTS.find((f) => f.name.toLowerCase() === name.toLowerCase());
  return known ? known.stack : `'${name}', system-ui, sans-serif`;
}
