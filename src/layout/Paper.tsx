import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { useState, type CSSProperties, type ReactNode, type Ref } from "react";
import type { KeptPart } from "../doc/meta";
import { PartView } from "./PartView";
import type { PageLayout } from "./pages";

interface Props {
  editor: Editor;
  /** View ▸ Larger text: the page at 1.2×. */
  large: boolean;
  /** Where the pages break, once the text has been laid out; until then the paper is one long sheet. */
  layout?: PageLayout | null;
  /** A header and a footer kept from the file: drawn on every sheet, read-only. */
  headerPart?: KeptPart | null;
  footerPart?: KeptPart | null;
  /** The header zone above the text and the footer zone below it (Task 14). */
  header?: ReactNode;
  footer?: ReactNode;
  /** Overlays positioned against the paper: selection bubble, slash menu (Task 8). */
  children?: ReactNode;
  paperRef?: Ref<HTMLDivElement>;
}

/** Mock 133–182: the 780px page. It is `position: relative`, so overlays can sit on it. */
export function Paper({ editor, large, layout, headerPart, footerPart, header, footer, children, paperRef }: Props) {
  // How tall each kept part is drawn: the margins of a sheet grow to hold it (styles.css reads these).
  const [headerHeight, setHeaderHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);

  // The text is one flow; the sheets are drawn behind it, and the paper is tall enough for all of them.
  const style = {
    ...(layout && { minHeight: layout.pages * layout.pageHeight + (layout.pages - 1) * layout.gap, "--page-h": `${layout.pageHeight}px` }),
    ...(headerPart && { "--hf-h": `${Math.ceil(headerHeight)}px` }),
    ...(footerPart && { "--hf-fh": `${Math.ceil(footerHeight)}px` }),
  } as CSSProperties;

  return (
    <div className={`paper${layout ? " paged" : ""}`} ref={paperRef} style={style}>
      {layout && (
        <div className="sheets" aria-hidden="true">
          {Array.from({ length: layout.pages }, (_, i) => (
            <div key={i} className="sheet" style={{ top: i * (layout.pageHeight + layout.gap), height: layout.pageHeight }}>
              {headerPart && <PartView view={headerPart.view} className="hf-rich hf-sheet-top" />}
              {footerPart && <PartView view={footerPart.view} className="hf-rich hf-sheet-bottom" />}
            </div>
          ))}
        </div>
      )}
      {/* In the flow: how the page shows it before it is laid out, what is measured, and what is printed. */}
      {headerPart && <PartView view={headerPart.view} className="hf-rich hf-flow hf-flow-top" onSize={setHeaderHeight} />}
      {header}
      <EditorContent editor={editor} className={`doc${large ? " large" : ""}`} />
      {footer}
      {footerPart && <PartView view={footerPart.view} className="hf-rich hf-flow hf-flow-bottom" onSize={setFooterHeight} />}
      {children}
    </div>
  );
}
