import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import type { CSSProperties, ReactNode, Ref } from "react";
import type { PageLayout } from "./pages";

interface Props {
  editor: Editor;
  /** View ▸ Larger text: the page at 1.2×. */
  large: boolean;
  /** Where the pages break, once the text has been laid out; until then the paper is one long sheet. */
  layout?: PageLayout | null;
  /** The header zone above the text and the footer zone below it (Task 14). */
  header?: ReactNode;
  footer?: ReactNode;
  /** Overlays positioned against the paper: selection bubble, slash menu (Task 8). */
  children?: ReactNode;
  paperRef?: Ref<HTMLDivElement>;
}

/** Mock 133–182: the 780px page. It is `position: relative`, so overlays can sit on it. */
export function Paper({ editor, large, layout, header, footer, children, paperRef }: Props) {
  // The text is one flow; the sheets are drawn behind it, and the paper is tall enough for all of them.
  const style = layout
    ? ({
        minHeight: layout.pages * layout.pageHeight + (layout.pages - 1) * layout.gap,
        "--page-h": `${layout.pageHeight}px`,
      } as CSSProperties)
    : undefined;
  return (
    <div className={`paper${layout ? " paged" : ""}`} ref={paperRef} style={style}>
      {layout && (
        <div className="sheets" aria-hidden="true">
          {Array.from({ length: layout.pages }, (_, i) => (
            <div key={i} className="sheet" style={{ top: i * (layout.pageHeight + layout.gap), height: layout.pageHeight }} />
          ))}
        </div>
      )}
      {header}
      <EditorContent editor={editor} className={`doc${large ? " large" : ""}`} />
      {footer}
      {children}
    </div>
  );
}
