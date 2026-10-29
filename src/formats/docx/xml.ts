// Namespace-aware lookups for OOXML parts. Names are written "prefix:local"
// with the prefixes Word uses, but matching goes by namespace URI, so a file
// that binds other prefixes to the same namespaces reads the same.

export const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  dgm: "http://schemas.openxmlformats.org/drawingml/2006/diagram",
  m: "http://schemas.openxmlformats.org/officeDocument/2006/math",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  v: "urn:schemas-microsoft-com:vml",
  o: "urn:schemas-microsoft-com:office:office",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
  xml: "http://www.w3.org/XML/1998/namespace",
} as const;

type Prefix = keyof typeof NS;

function qualified(name: string): [string, string] {
  const colon = name.indexOf(":");
  return [NS[name.slice(0, colon) as Prefix], name.slice(colon + 1)];
}

// Parse with the browser's XML parser: no scripts, no external entities.
export function parseXml(text: string, part: string): Document {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ""), "application/xml");
  if (!doc.documentElement || doc.getElementsByTagNameNS("*", "parsererror").length > 0)
    throw new Error(`This Word document is damaged: ${part} is not valid XML`);
  return doc;
}

export function is(el: Element, name: string): boolean {
  const [ns, local] = qualified(name);
  return el.namespaceURI === ns && (local === "*" || el.localName === local);
}

// Child elements, all of them or only those called `name`.
export function children(el: Element | null | undefined, name?: string): Element[] {
  return el ? Array.from(el.children).filter((child) => !name || is(child, name)) : [];
}

// The first element down a path of child names, such as "w:pPr/w:numPr/w:numId".
export function first(el: Element | null | undefined, path: string): Element | null {
  let current = el ?? null;
  for (const name of path.split("/")) current = children(current, name)[0] ?? null;
  return current;
}

// A qualified attribute ("w:val") by namespace, a plain one ("descr") by name.
export function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  if (!name.includes(":")) return el.getAttribute(name);
  return el.getAttributeNS(...qualified(name));
}

// Every element called `name` below `el`; "dgm:*" matches the whole namespace.
export function descendants(el: Element | Document, name: string): Element[] {
  return Array.from(el.getElementsByTagNameNS(...qualified(name)));
}
