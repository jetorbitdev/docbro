import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { useState, type CSSProperties, type ReactNode, type Ref } from "react";
import type { Zone } from "../doc/meta";
import { PartEditor } from "./PartEditor";
import { PartView } from "./PartView";
import type { PageLayout } from "./pages";

interface Props {
  editor: Editor;
  /** View ▸ Larger text: the page at 1.2×. */
  large: boolean;
  /** Where the pages break, once the text has been laid out; until then the paper is one long sheet. */
  layout?: PageLayout | null;
  /** The header and the footer as documents (doc/meta.ts `zoneView`), drawn on every sheet; null when there is none. */
  headerView?: JSONContent | null;
  footerView?: JSONContent | null;
  /** The header or footer being edited, and on which sheet; null when none is. */
  editing?: { kind: Zone; sheet: number } | null;
  /** A double-click in the top or bottom margin of a sheet: edit (or add) its header or footer. Without it, they cannot be. */
  onEdit?(kind: Zone, sheet: number): void;
  onPartChange?(kind: Zone, view: JSONContent): void;
  onEditEnd?(): void;
  /** The header or footer editor while there is one, so that the menus and the dock act on it; null after. */
  onEditor?(editor: Editor | null): void;
  /** Overlays positioned against the paper: selection bubble, slash menu (Task 8). */
  children?: ReactNode;
  paperRef?: Ref<HTMLDivElement>;
}

const NAMES = { header: "header", footer: "footer" } as const;

/** Mock 133–182: the 780px page. It is `position: relative`, so overlays can sit on it. */
export function Paper(props: Props) {
  const { editor, large, layout, headerView, footerView, editing, onEdit, onPartChange, onEditEnd, onEditor, children, paperRef } = props;
  // How tall the header and footer are drawn: the margins of a sheet grow to hold them (styles.css reads these).
  const [headerHeight, setHeaderHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);

  // The text is one flow; the sheets are drawn behind it, and the paper is tall enough for all of them.
  const style = {
    ...(layout && { minHeight: layout.pages * layout.pageHeight + (layout.pages - 1) * layout.gap, "--page-h": `${layout.pageHeight}px` }),
    ...(headerView && { "--hf-h": `${Math.ceil(headerHeight)}px` }),
    ...(footerView && { "--hf-fh": `${Math.ceil(footerHeight)}px` }),
  } as CSSProperties;
  const pages = layout?.pages ?? 1;
  const sheetTop = (i: number) => (layout ? i * (layout.pageHeight + layout.gap) : 0);
  const isEditing = (kind: Zone, sheet: number) => editing?.kind === kind && editing.sheet === sheet;
  const hit = (kind: Zone, view: JSONContent | null | undefined, i: number) => (
    <div
      className={`hf-hit hf-hit-${kind === "header" ? "top" : "bottom"}`}
      style={{ top: sheetTop(i) + (kind === "footer" && layout ? layout.pageHeight : 0) }}
      title={`Double-click to ${view ? "edit the" : "add a"} ${NAMES[kind]}`}
      onDoubleClick={() => onEdit?.(kind, i)}
    />
  );

  return (
    <div className={`paper${layout ? " paged" : ""}`} ref={paperRef} style={style}>
      {layout && (
        <div className="sheets" aria-hidden="true">
          {Array.from({ length: pages }, (_, i) => (
            <div key={i} className="sheet" style={{ top: sheetTop(i), height: layout.pageHeight }}>
              {headerView && <PartView view={headerView} page={i + 1} pages={pages} className={`hf-rich hf-sheet-top${isEditing("header", i) ? " editing" : ""}`} />}
              {footerView && <PartView view={footerView} page={i + 1} pages={pages} className={`hf-rich hf-sheet-bottom${isEditing("footer", i) ? " editing" : ""}`} />}
            </div>
          ))}
        </div>
      )}
      {/* Above the text, where its margins are: what a double-click there opens. */}
      {layout && onEdit && !editing && (
        <div className="hf-hits">
          {Array.from({ length: pages }, (_, i) => (
            <div key={i}>
              {hit("header", headerView, i)}
              {hit("footer", footerView, i)}
            </div>
          ))}
        </div>
      )}
      {layout && editing && (
        <PartEditor
          key={`${editing.kind}-${editing.sheet}`}
          kind={editing.kind}
          view={editing.kind === "header" ? headerView ?? null : footerView ?? null}
          page={editing.sheet + 1}
          pages={pages}
          style={editing.kind === "header"
            ? { top: `calc(${sheetTop(editing.sheet)}px + var(--hf-offset))` }
            : { top: `calc(${sheetTop(editing.sheet) + layout.pageHeight}px - var(--hf-offset))` }}
          onChange={(view) => onPartChange?.(editing.kind, view)}
          onClose={() => onEditEnd?.()}
          onEditor={onEditor}
        />
      )}
      {/* In the flow: how the page shows it before it is laid out, what is measured, and what is printed. */}
      {headerView && <PartView view={headerView} page={1} pages={pages} className="hf-rich hf-flow hf-flow-top" onSize={setHeaderHeight} />}
      <EditorContent editor={editor} className={`doc${large ? " large" : ""}`} />
      {footerView && <PartView view={footerView} page={pages} pages={pages} className="hf-rich hf-flow hf-flow-bottom" onSize={setFooterHeight} />}
      {children}
    </div>
  );
}
