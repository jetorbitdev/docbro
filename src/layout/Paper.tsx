import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import type { ReactNode, Ref } from "react";

interface Props {
  editor: Editor;
  /** View ▸ Larger text: the page at 1.2×. */
  large: boolean;
  /** The header zone above the text and the footer zone below it (Task 14). */
  header?: ReactNode;
  footer?: ReactNode;
  /** Overlays positioned against the paper: selection bubble, slash menu (Task 8). */
  children?: ReactNode;
  paperRef?: Ref<HTMLDivElement>;
}

/** Mock 133–182: the 780px page. It is `position: relative`, so overlays can sit on it. */
export function Paper({ editor, large, header, footer, children, paperRef }: Props) {
  return (
    <div className="paper" ref={paperRef}>
      {header}
      <EditorContent editor={editor} className={`doc${large ? " large" : ""}`} />
      {footer}
      {children}
    </div>
  );
}
