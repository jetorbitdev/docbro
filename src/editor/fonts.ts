import type { DocLook } from "../doc/meta";

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

/** The face a name is, ignoring case: "georgia" is Georgia. */
export const sameFont = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a != null && b != null && a.toLowerCase() === b.toLowerCase();

/** What a font list shows: a face from a file that is not among the picker's comes first, then the picker's, and null (Default) last. */
export function fontOptions(current: string | null): (string | null)[] {
  const known = FONTS.some((f) => sameFont(f.name, current));
  return [...(current && !known ? [current] : []), ...FONTS.map((f) => f.name), null];
}

// ------------------------------------------------------------------ sizes

/** The sizes in points the Size list offers, and the ones − and + step through. */
export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
export const MIN_SIZE = 1;
export const MAX_SIZE = 400;

/** DocBro draws a point as this many px when the page is not set as a .docx (`--pt`, layout/look.ts): 11 pt, Word's body text, is the page's 17px. */
const PT_PX = 17 / 11;

/** A size in points as the editor keeps it, or null for one that is not a number in range. */
export function validSize(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.trim().replace(",", ".")) : NaN;
  return Number.isFinite(n) && n >= MIN_SIZE && n <= MAX_SIZE ? Math.round(n * 2) / 2 : null;
}

/** The CSS `font-size` for a size in points: a multiple of the page's point, which a .docx page scales to its sheet. */
export const sizeStyle = (pt: number): string => `calc(${pt} * var(--pt, ${PT_PX.toFixed(4)}px))`;

/**
 * A size in points from a CSS `font-size`: pt as it comes from Word, px as a page sets it (a px is three quarters of a point),
 * and what `sizeStyle` writes. The browser's own 16px is not a choice of the writer's, so it leaves the text at the page's size.
 */
export function sizeOf(css: string): number | null {
  const value = css.trim();
  const calc = /^calc\(\s*([\d.]+)\s*\*\s*var\(--pt/.exec(value);
  if (calc) return validSize(calc[1]);
  const unit = /^([\d.]+)(pt|px)$/.exec(value);
  if (!unit || value === "16px") return null;
  return validSize(unit[2] === "pt" ? unit[1] : Number(unit[1]) * 0.75);
}

/** A size for the box: no trailing zeros, 10.5 stays 10.5. */
export const formatSize = (pt: number): string => String(Math.round(pt * 2) / 2);

/** The next size of the list up or down from `pt`; the same size where the list ends. */
export function stepSize(pt: number, direction: 1 | -1): number {
  const next = direction > 0 ? SIZES.find((s) => s > pt) : [...SIZES].reverse().find((s) => s < pt);
  return next ?? pt;
}

/**
 * The size text has where nothing sets one: a heading's (`level`) or the body's, as the page draws it. A document from a
 * .docx has the file's own (`DocLook`); any other is DocBro's, which Word is given when it is saved as .docx (doc/export).
 */
export function baseSize(level: number | null, look?: DocLook | null): number {
  const body = look ? look.size / 2 : 11;
  if (!level) return body;
  const own = look?.headings[level - 1]?.size;
  if (own) return own / 2;
  return look ? Math.round(body * [2, 1.5, 1.17][level - 1] * 2) / 2 : [20, 16, 13][level - 1];
}
