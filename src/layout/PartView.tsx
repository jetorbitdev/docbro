import { getSchema, type JSONContent } from "@tiptap/core";
import { DOMSerializer, Node as ProseNode, type Schema } from "@tiptap/pm/model";
import { useEffect, useRef } from "react";
import { createExtensions } from "../editor/extensions";

let schema: Schema | undefined;
const schemaOf = () => (schema ??= getSchema(createExtensions()));

interface Props {
  /** The blocks of a header or footer kept from the file. */
  view: JSONContent | null;
  className: string;
  /** Called with the height in px of what is drawn, now and whenever it changes. */
  onSize?(height: number): void;
}

/** A header or footer kept from the file, drawn read-only from its blocks. The nodes are made by the schema, never from markup. */
export function PartView({ view, className, onSize }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      const node = ProseNode.fromJSON(schemaOf(), view ?? { type: "doc", content: [{ type: "paragraph" }] });
      el.replaceChildren(DOMSerializer.fromSchema(schemaOf()).serializeFragment(node.content));
    } catch {
      el.replaceChildren();
    }
    onSize?.(el.getBoundingClientRect().height);
  }, [view, onSize]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onSize || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => onSize(el.getBoundingClientRect().height));
    observer.observe(el);
    return () => observer.disconnect();
  }, [onSize]);

  return <div ref={ref} className={className} />;
}
