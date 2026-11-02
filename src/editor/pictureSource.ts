import type { DOMOutputSpec } from "@tiptap/pm/model";

/**
 * Whether the page may load a picture from `src`. Only a picture that is in the document itself (a data URL) or made by
 * the page (a blob URL) is drawn. Any other address, from a Markdown link, an AI's answer or pasted HTML, would make the
 * window fetch it, and the address could carry document text out. The node keeps its `src` all the same, so a Markdown
 * file written back has the link it came with.
 */
export function loadsInPage(src: unknown): boolean {
  return typeof src === "string" && /^\s*(data|blob):/i.test(src);
}

/** The attribute that carries the address of a picture that is not loaded, so a copied one pastes back as a picture. */
export const REMOTE_SRC = "data-remote-src";

/** What is drawn instead of a picture that is not loaded: its alt text and its address, as plain text. */
export function remotePicture(src: string, alt: unknown): DOMOutputSpec {
  const label = typeof alt === "string" && alt.trim() ? alt.trim() : "Picture";
  return [
    "span",
    { class: "remote-image", [REMOTE_SRC]: src, "data-alt": typeof alt === "string" ? alt : "", title: src },
    ["span", { class: "remote-image-alt" }, label],
    ["span", { class: "remote-image-src" }, src],
  ];
}
