import type { CSSProperties } from "react";
import { TWIPS_PER_PX, type DocLook, type Spacing } from "../doc/meta";

/**
 * A document from a .docx is set as the file sets it: its typeface and size, its line and paragraph spacing, its
 * margins, all at the scale of the sheet on screen (a sheet `scale` times the paper's width in px). Its pages then
 * break where Word's and Google Docs' do. Sizes in pt are drawn as a multiple of `--pt`, the px of a point at that scale.
 */

/** Word's single line for the usual text faces (Arial, Times New Roman, Liberation): the font's own height, 1.15 of its size. */
const SINGLE = 1.15;

/** A line's height as CSS: a multiple of the font size for `auto`, a height in `--pt` for `exact`, at least that for `atLeast`. */
export function lineHeight(spacing: Spacing): string | null {
  if (spacing.line === undefined) return null;
  if ((spacing.lineRule ?? "auto") === "auto") return String(round((spacing.line / 240) * SINGLE));
  const height = `calc(${round(spacing.line / 20)} * var(--pt))`;
  return spacing.lineRule === "exact" ? height : `max(${SINGLE}em, ${height})`;
}

/** A paragraph's own spacing as the custom properties the page's rules read (styles.css, `.paper.look`); inert elsewhere. */
export function spacingStyle(spacing: Spacing): string {
  const line = lineHeight(spacing);
  return [
    spacing.before !== undefined && `--p-before: ${round(spacing.before / 20)}`,
    spacing.after !== undefined && `--p-after: ${round(spacing.after / 20)}`,
    line && `--p-line: ${line}`,
  ].filter(Boolean).join("; ");
}

/**
 * The paper's properties for a document set as its file: the sheet is the paper's own width (`paperWidth` px, and its
 * border) where the window has room, so that tables and pictures, which keep the file's widths, fit its text; in a
 * narrower window every size is scaled to a sheet `scale` times the paper's width.
 */
export function lookStyle(look: DocLook, scale: number, paperWidth: number): CSSProperties {
  const px = (twips: number) => `${round((twips / TWIPS_PER_PX) * scale)}px`;
  const pt = (4 / 3) * scale;
  const heading = (level: number) => {
    const h = look.headings[level - 1];
    if (!h) return {};
    const line = lineHeight(h.spacing);
    return {
      ...(h.size && { [`--look-h${level}`]: `${round((h.size / 2) * pt)}px` }),
      [`--look-h${level}-before`]: round((h.spacing.before ?? 0) / 20),
      [`--look-h${level}-after`]: round((h.spacing.after ?? 0) / 20),
      ...(line && { [`--look-h${level}-line`]: line }),
    };
  };
  return {
    "--paper-max": `${paperWidth + 2}px`,
    // what a table's widths, the file's in px, are drawn at (editor/extensions.ts)
    "--look-scale": round(scale),
    "--pt": `${round(pt)}px`,
    "--look-size": `${round((look.size / 2) * pt)}px`,
    "--look-line": lineHeight(look.spacing) ?? String(SINGLE),
    "--look-before": round((look.spacing.before ?? 0) / 20),
    "--look-after": round((look.spacing.after ?? 0) / 20),
    // DocBro's own face stands in for one this computer does not have
    ...(look.font && { "--look-font": `${JSON.stringify(look.font)}, var(--doc-font)` }),
    ...heading(1), ...heading(2), ...heading(3),
    // the text starts at the top margin, or below the header when it reaches further (as Word does)
    "--pad-x": px(look.margins.left),
    "--hf-offset": px(look.margins.header),
    "--pad-y": `max(${px(look.margins.top)}, calc(var(--hf-offset) + var(--hf-h, 0px)), calc(var(--hf-offset) + var(--hf-fh, 0px)))`,
  } as CSSProperties;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
