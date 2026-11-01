import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { useState, type CSSProperties, type ReactNode, type Ref } from "react";
import type { KeptPart } from "../doc/meta";
import { PartEditor } from "./PartEditor";
import { PartView } from "./PartView";
import type { PageLayout } from "./pages";

type Kind = "header" | "footer";

interface Props {
  editor: Editor;
  /** View ▸ Larger text: the page at 1.2×. */
  large: boolean;
  /** Where the pages break, once the text has been laid out; until then the paper is one long sheet. */
  layout?: PageLayout | null;
  /** A header and a footer kept from the file: drawn on every sheet, read-only. */
  headerPart?: KeptPart | null;
  footerPart?: KeptPart | null;
  /** The kept part being edited, and on which sheet; null when none is. */
  editing?: { kind: Kind; sheet: number } | null;
  /** A double-click in the top or bottom margin of a sheet: edit its header or footer. Without it, they cannot be edited. */
  onEdit?(kind: Kind, sheet: number): void;
  onPartChange?(kind: Kind, view: JSONContent): void;
  onEditEnd?(): void;
  /** The header zone above the text and the footer zone below it (Task 14). */
  header?: ReactNode;
  footer?: ReactNode;
  /** Overlays positioned against the paper: selection bubble, slash menu (Task 8). */
  children?: ReactNode;
  paperRef?: Ref<HTMLDivElement>;
}

/** Mock 133–182: the 780px page. It is `position: relative`, so overlays can sit on it. */
export function Paper(props: Props) {
  const { editor, large, layout, headerPart, footerPart, editing, onEdit, onPartChange, onEditEnd, header, footer, children, paperRef } = props;
  // How tall each kept part is drawn: the margins of a sheet grow to hold it (styles.css reads these).
  const [headerHeight, setHeaderHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);

  // The text is one flow; the sheets are drawn behind it, and the paper is tall enough for all of them.
  const style = {
    ...(layout && { minHeight: layout.pages * layout.pageHeight + (layout.pages - 1) * layout.gap, "--page-h": `${layout.pageHeight}px` }),
    ...(headerPart && { "--hf-h": `${Math.ceil(headerHeight)}px` }),
    ...(footerPart && { "--hf-fh": `${Math.ceil(footerHeight)}px` }),
  } as CSSProperties;
  const sheetTop = (i: number) => (layout ? i * (layout.pageHeight + layout.gap) : 0);
  const isEditing = (kind: Kind, sheet: number) => editing?.kind === kind && editing.sheet === sheet;
  const editedPart = editing?.kind === "header" ? headerPart : editing?.kind === "footer" ? footerPart : null;

  return (
    <div className={`paper${layout ? " paged" : ""}`} ref={paperRef} style={style}>
      {layout && (
        <div className="sheets" aria-hidden="true">
          {Array.from({ length: layout.pages }, (_, i) => (
            <div key={i} className="sheet" style={{ top: i * (layout.pageHeight + layout.gap), height: layout.pageHeight }}>
              {headerPart && <PartView view={headerPart.view} className={`hf-rich hf-sheet-top${isEditing("header", i) ? " editing" : ""}`} />}
              {footerPart && <PartView view={footerPart.view} className={`hf-rich hf-sheet-bottom${isEditing("footer", i) ? " editing" : ""}`} />}
            </div>
          ))}
        </div>
      )}
      {/* Above the text, where its margins are: what a double-click there opens. */}
      {layout && onEdit && !editing && (headerPart?.view || footerPart?.view) && (
        <div className="hf-hits">
          {Array.from({ length: layout.pages }, (_, i) => (
            <div key={i}>
              {headerPart?.view && <div className="hf-hit hf-hit-top" style={{ top: sheetTop(i) }} title="Double-click to edit the header" onDoubleClick={() => onEdit("header", i)} />}
              {footerPart?.view && <div className="hf-hit hf-hit-bottom" style={{ top: sheetTop(i) + layout.pageHeight }} title="Double-click to edit the footer" onDoubleClick={() => onEdit("footer", i)} />}
            </div>
          ))}
        </div>
      )}
      {layout && editing && editedPart && (
        <PartEditor
          key={`${editing.kind}-${editing.sheet}`}
          kind={editing.kind}
          view={editedPart.view}
          style={editing.kind === "header"
            ? { top: `calc(${sheetTop(editing.sheet)}px + var(--hf-offset))` }
            : { top: `calc(${sheetTop(editing.sheet) + layout.pageHeight}px - var(--hf-offset))` }}
          onChange={(view) => onPartChange?.(editing.kind, view)}
          onClose={() => onEditEnd?.()}
        />
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
