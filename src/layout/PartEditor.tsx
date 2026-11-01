import type { Editor, JSONContent } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef, type CSSProperties } from "react";
import type { Zone } from "../doc/meta";
import { createExtensions } from "../editor/extensions";
import { numberFields } from "./PartView";

interface Props {
  kind: Zone;
  view: JSONContent | null;
  /** The sheet it was opened on and the number of sheets: what its page fields show. */
  page: number;
  pages: number;
  style: CSSProperties;
  onChange(view: JSONContent): void;
  /** Esc, or a click in the text or the desk around the sheets. */
  onClose(): void;
  /** The editor once it exists, and null when it goes: the menus, the dock and the bubble act on it meanwhile. */
  onEditor?(editor: Editor | null): void;
}

/**
 * A header or footer being edited: an editor of its own, with its own undo, over the sheet it was opened on. A click
 * in a menu, the dock or the bubble leaves it open, so that their commands reach it.
 */
export function PartEditor({ kind, view, page, pages, style, onChange, onClose, onEditor }: Props) {
  // The editor is made once; it calls whatever the handlers are now.
  const handlers = useRef({ onChange, onClose });
  handlers.current = { onChange, onClose };
  const box = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    // no empty line kept after the last block: in a header it would be written to the file
    extensions: createExtensions({ trailingNode: false }),
    content: view ?? { type: "doc", content: [{ type: "paragraph" }] },
    // At the end of the last line of text: the end of the part is often a rule, and a selected rule takes no typing.
    onCreate: ({ editor }) => {
      const { doc } = editor.state;
      const end = Selection.findFrom(doc.resolve(doc.content.size), -1, true);
      editor.chain().setTextSelection(end ? end.from : doc.content.size).focus().run();
    },
    onUpdate: ({ editor }) => handlers.current.onChange(editor.getJSON()),
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (event.key !== "Escape") return false;
        handlers.current.onClose();
        return true;
      },
    },
  });

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  // Page fields show this sheet's number while it is edited, as they do on the sheet.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const number = () => numberFields(el, page, pages);
    number();
    editor.on("update", number);
    return () => void editor.off("update", number);
  }, [editor, page, pages]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || box.current?.contains(target) || target.closest(".no-print")) return;
      if (target.closest(".canvas")) handlers.current.onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);

  return (
    <div ref={box} className={`hf-rich hf-editor hf-editor-${kind}`} style={style}>
      <span className="hf-tag no-print">{kind === "header" ? "HEADER" : "FOOTER"} · Esc to finish</span>
      <EditorContent editor={editor} />
    </div>
  );
}
