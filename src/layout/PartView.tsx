import { getSchema, type JSONContent } from "@tiptap/core";
import { DOMSerializer, Node as ProseNode, type Schema } from "@tiptap/pm/model";
import { useEffect, useRef } from "react";
import { createExtensions } from "../editor/extensions";
import { fieldName } from "../editor/field";

let schema: Schema | undefined;
const schemaOf = () => (schema ??= getSchema(createExtensions()));

/** Puts the sheet's number and the number of sheets in the PAGE and NUMPAGES fields under `root`; other fields keep their last value. */
export function numberFields(root: HTMLElement, page: number, pages: number): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-field]")) {
    const name = fieldName(el.dataset.field ?? "");
    if (name === "PAGE") el.textContent = String(page);
    else if (name === "NUMPAGES" || name === "SECTIONPAGES") el.textContent = String(pages);
  }
}

interface Props {
  /** The blocks of a header or footer kept from the file. */
  view: JSONContent | null;
  className: string;
  /** The number of the sheet it is drawn on and of all sheets: what PAGE and NUMPAGES fields show. */
  page?: number;
  pages?: number;
  /** Called with the height in px of what is drawn, now and whenever it changes. */
  onSize?(height: number): void;
}

/** A header or footer kept from the file, drawn read-only from its blocks. The nodes are made by the schema, never from markup. */
export function PartView({ view, className, page, pages, onSize }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      const node = ProseNode.fromJSON(schemaOf(), view ?? { type: "doc", content: [{ type: "paragraph" }] });
      el.replaceChildren(DOMSerializer.fromSchema(schemaOf()).serializeFragment(node.content));
      if (page) numberFields(el, page, pages ?? page);
    } catch {
      el.replaceChildren();
    }
    onSize?.(el.getBoundingClientRect().height);
  }, [view, page, pages, onSize]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onSize || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => onSize(el.getBoundingClientRect().height));
    observer.observe(el);
    return () => observer.disconnect();
  }, [onSize]);

  return <div ref={ref} className={className} />;
}
