import type { JSONContent } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { useRef, type CSSProperties } from "react";
import { createExtensions } from "../editor/extensions";

interface Props {
  kind: "header" | "footer";
  view: JSONContent | null;
  style: CSSProperties;
  onChange(view: JSONContent): void;
  /** Esc, or the focus left the editor. */
  onClose(): void;
}

/** A header or footer kept from the file, being edited: an editor of its own, with its own undo, over the sheet it was opened on. */
export function PartEditor({ kind, view, style, onChange, onClose }: Props) {
  // The editor is made once; it calls whatever the handlers are now.
  const handlers = useRef({ onChange, onClose });
  handlers.current = { onChange, onClose };

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
    onBlur: () => handlers.current.onClose(),
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (event.key !== "Escape") return false;
        handlers.current.onClose();
        return true;
      },
    },
  });

  return (
    <div className={`hf-rich hf-editor hf-editor-${kind}`} style={style}>
      <span className="hf-tag">{kind === "header" ? "HEADER" : "FOOTER"} · Esc to finish</span>
      <EditorContent editor={editor} />
    </div>
  );
}
