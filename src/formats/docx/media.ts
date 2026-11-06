// The picture formats a Word package can hold, by file extension, with the content type each is listed under.
export const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  emf: "image/x-emf",
  wmf: "image/x-wmf",
};

export type ImageType = "png" | "jpg" | "gif";

// A data URL of a PNG, JPEG or GIF whose header says how big it is. Anything
// else (a remote URL, SVG, WebP, a damaged file) has no picture in the .docx.
export function decodeImage(src: string): { type: ImageType; data: Uint8Array; width: number; height: number } | undefined {
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
