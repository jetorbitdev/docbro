import type { JSONContent } from "@tiptap/core";
import { emptyMeta, type DocMeta } from "../doc/meta";
import { exportDocx } from "./docx/export";
import { importDocx, type DocxImport } from "./docx/import";
import { docToMarkdown, markdownToDoc } from "./markdown";

export type DocFormat = "docx" | "md";

export const UNKNOWN_FORMAT = "DocBro opens .docx and .md files.";

const EXTENSION = /\.(docx|md|markdown)$/i;

/** The format a file name stands for, or null for a file DocBro does not handle. */
export function formatOf(path: string): DocFormat | null {
  const ext = EXTENSION.exec(path)?.[1].toLowerCase();
  return ext === undefined ? null : ext === "docx" ? "docx" : "md";
}

/** Reads the file's bytes into a document. Markdown has no header, comments or lost parts. */
export async function readDocument(path: string, bytes: Uint8Array): Promise<DocxImport> {
  switch (formatOf(path)) {
    case "docx":
      return importDocx(bytes);
    case "md":
      return { doc: markdownToDoc(new TextDecoder().decode(bytes)), meta: emptyMeta(), dropped: [] };
    default:
      throw new Error(UNKNOWN_FORMAT);
  }
}

export async function writeDocument(path: string, doc: JSONContent, meta: DocMeta): Promise<Uint8Array> {
  switch (formatOf(path)) {
    case "docx":
      return exportDocx(doc, meta);
    case "md":
      return new TextEncoder().encode(docToMarkdown(doc));
    default:
      throw new Error(UNKNOWN_FORMAT);
  }
}
