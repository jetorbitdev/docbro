import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { applyBlock, blockOf, type BlockKey } from "./blocks";

const BLOCKS: [BlockKey, string, string][] = [
  ["p", "Aa", "Text"],
  ["h1", "H1", "Heading 1"],
  ["h2", "H2", "Heading 2"],
  ["blockquote", "“", "Quote"],
  ["ul", "•", "Bulleted list"],
];

/**
 * Mock 209–228: the block type, B/I/U/text color/highlight, Table, undo and redo, lit from the caret. It floats at the middle
 * of the page: `commentsOpen` says whether the comments rail is taking room beside the page.
 */
export function Dock({ editor, run, commentsOpen }: { editor: Editor; run(commandId: string): void; commentsOpen: boolean }) {
  const s = useEditorState({
    editor,
    selector: ({ editor }) => ({
      block: blockOf(editor),
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      underline: editor.isActive("underline"),
      color: editor.getAttributes("textStyle").color as string | undefined,
    }),
  });

  return (
    <div className="dock-layer no-print">
      <div className="dock-col">
        {/* a mouse-down here would take the caret from the editor */}
        <div className="dock" role="toolbar" aria-label="Format" onMouseDown={(e) => e.preventDefault()}>
          <div className="seg">
            {BLOCKS.map(([key, label, title]) => (
              <button key={key} className={s.block === key ? "on" : ""} title={title} aria-pressed={s.block === key} onClick={() => applyBlock(editor, key)}>
                {label}
              </button>
            ))}
          </div>
          <span className="vsep" />
          <div className="tools">
            <button className={`tool bold${s.bold ? " on" : ""}`} title="Bold" aria-pressed={s.bold} onClick={() => run("bold")}>
              B
            </button>
            <button className={`tool italic${s.italic ? " on" : ""}`} title="Italic" aria-pressed={s.italic} onClick={() => run("italic")}>
              I
            </button>
            <button className={`tool underline${s.underline ? " on" : ""}`} title="Underline" aria-pressed={s.underline} onClick={() => run("underline")}>
              U
            </button>
            <button className="tool" title="Text color" aria-label="Text color" onClick={() => run("color")}>
              <span className="swatch-tc" style={{ borderBottomColor: s.color }}>
                A
              </span>
            </button>
            <button className="tool" title="Highlight" aria-label="Highlight" onClick={() => run("highlight")}>
              <span className="swatch-hl ringed" />
            </button>
          </div>
          <span className="vsep" />
          <button className="table-btn" title="Insert a table" onClick={() => applyBlock(editor, "table")}>
            <span className="glyph">▦</span>Table
          </button>
          <button className="tool quiet" title="Undo" aria-label="Undo" onClick={() => run("undo")}>
            ↶
          </button>
          <button className="tool quiet" title="Redo" aria-label="Redo" onClick={() => run("redo")}>
            ↷
          </button>
          <span className="vsep" />
          <span className="hint">Type / to insert</span>
        </div>
      </div>
      {/* as wide as the rail beside the page, so the page and the dock move over together */}
      <div className={`comments-rail${commentsOpen ? " open" : ""}`} aria-hidden />
    </div>
  );
}
