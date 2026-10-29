import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { chooseSlashItem, filterSlash, popoverPosition, slashLine } from "./blocks";

const WIDTH = 280;
const KEY = new PluginKey("docbroSlashMenu");

interface Props {
  editor: Editor;
  paper: HTMLElement | null;
  /** The command palette is open. */
  suspended: boolean;
}

/** Mock 171–181 and 570–604: `/` on an empty line lists blocks to insert; ↑/↓ move, Enter picks, Esc closes. */
export function SlashMenu({ editor, paper, suspended }: Props) {
  const s = useEditorState({
    editor,
    selector: ({ editor }) => ({ line: slashLine(editor.state), focused: editor.isFocused }),
  });
  const [picked, setPicked] = useState({ query: "", index: 0 });
  // Esc closes the menu for this text; typing another character opens it again
  const [dismissed, setDismissed] = useState<{ pos: number; query: string } | null>(null);
  const [box, setBox] = useState<{ x: number; y: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  const { line } = s;
  const items = line ? filterSlash(line.query) : [];
  const open = !!line && s.focused && !suspended && items.length > 0 && !(dismissed?.pos === line.pos && dismissed.query === line.query);
  const index = line && picked.query === line.query ? Math.min(picked.index, items.length - 1) : 0;

  // the key handler is registered once and reads what the menu is showing now
  const latest = useRef({ open, items, index, query: line?.query ?? "", pos: line?.pos ?? 0 });
  useEffect(() => {
    latest.current = { open, items, index, query: line?.query ?? "", pos: line?.pos ?? 0 };
  });

  // Enter, ↑ and ↓ have to reach the menu before the editor's own keymap splits the line
  useEffect(() => {
    const plugin = new Plugin({
      key: KEY,
      props: {
        handleKeyDown: (_view, event) => {
          const now = latest.current;
          if (!now.open || event.isComposing) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const step = event.key === "ArrowDown" ? 1 : -1;
            setPicked({ query: now.query, index: (now.index + step + now.items.length) % now.items.length });
          } else if (event.key === "Enter") {
            chooseSlashItem(editor, now.items[now.index].k);
          } else if (event.key === "Escape") {
            setDismissed({ pos: now.pos, query: now.query });
          } else return false;
          event.preventDefault();
          return true;
        },
      },
    });
    editor.registerPlugin(plugin, (added, plugins) => [added, ...plugins]);
    return () => {
      editor.unregisterPlugin(KEY);
    };
  }, [editor]);

  // under the line, as the mock places it
  useLayoutEffect(() => {
    if (!open || !paper || !line) {
      setBox(null);
      return;
    }
    const place = () => {
      const block = editor.view.nodeDOM(line.pos);
      if (!(block instanceof HTMLElement)) return;
      const next = popoverPosition(block.getBoundingClientRect(), paper.getBoundingClientRect(), WIDTH, 6);
      setBox((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [editor, paper, open, line?.pos, line?.query]);

  // a menu opened near the bottom of the window is scrolled into view, and so is the highlighted row
  useEffect(() => {
    if (box) menu.current?.scrollIntoView?.({ block: "nearest" });
  }, [box]);
  useEffect(() => {
    menu.current?.querySelector(".sel")?.scrollIntoView?.({ block: "nearest" });
  }, [index, box]);

  if (!open || !box) return null;
  return (
    <div
      ref={menu}
      className="slash no-print"
      role="listbox"
      aria-label="Insert block"
      style={{ left: box.x, top: box.y, width: WIDTH }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="caption">{line!.query ? `Blocks matching “${line!.query}”` : "Insert block"}</div>
      {items.map((o, i) => (
        <button
          key={o.k}
          role="option"
          aria-selected={i === index}
          className={`slash-item${i === index ? " sel" : ""}`}
          onClick={() => chooseSlashItem(editor, o.k)}
          onMouseEnter={() => setPicked({ query: line!.query, index: i })}
        >
          <span className="tile">{o.icon}</span>
          <span className="text">
            <span className="label">{o.label}</span>
            <span className="hint">{o.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
