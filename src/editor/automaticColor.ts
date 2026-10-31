const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  windowtext: [0, 0, 0],
  canvastext: [0, 0, 0],
};

// "rgb(0, 0, 0)", "rgba(0 0 0 / 50%)" and the like: the first three numbers
const FUNCTIONAL = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i;

function channels(css: string): [number, number, number] | null {
  const value = css.trim().toLowerCase();
  if (value in NAMED) return NAMED[value];
  const fn = FUNCTIONAL.exec(value);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value)?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * A text color that is the source's own default rather than a choice: black or white and the near-grays
 * either side of them. Word, Google Docs and web pages set one on every run; kept as a color mark it
 * would make the text vanish on the other theme. The palette offers none of these, and the mid grays stay.
 */
export function isAutomaticColor(css: string): boolean {
  const rgb = channels(css);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  if (Math.max(r, g, b) - Math.min(r, g, b) > 20) return false;
  const light = (r + g + b) / 3;
  return light <= 80 || light >= 200;
}
