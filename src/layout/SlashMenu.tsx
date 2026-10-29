import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  chooseSlashItem,
  filterSlash,
  popoverPosition,
  slashLine,
  slashNext,
  type SlashAction,
  type SlashMenuState,
} from "./blocks";

const WIDTH = 280;
const KEY = new PluginKey<SlashMenuState | null>("docbroSlashMenu");

const send = (editor: Editor, action: SlashAction) =>
  editor.view.dispatch(editor.state.tr.setMeta(KEY, action).setMeta("addToHistory", false));

/**
 * The menu's state lives in the editor state, so it follows every transaction and cannot miss one:
 * Esc, the highlighted row and the command text it belongs to (`slashNext`). The key handler comes
 * first among the editor's plugins, so Enter, ↑ and ↓ reach the menu before the keymap splits the line.
 */
function slashPlugin(editor: Editor): Plugin {
  return new Plugin<SlashMenuState | null>({
    key: KEY,
    state: {
      init: (_config, state) => slashNext(null, slashLine(state)),
      apply: (tr, prev, _old, state) => slashNext(prev, slashLine(state), tr.getMeta(KEY)),
    },
    props: {
      handleKeyDown: (view, event) => {
        const menu = KEY.getState(view.state);
        if (!menu || menu.dismissed || event.isComposing) return false;
        const items = filterSlash(menu.query);
        if (!items.length) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") send(editor, { type: "move", step: event.key === "ArrowDown" ? 1 : -1 });
        else if (event.key === "Enter") chooseSlashItem(editor, items[menu.index].k);
        else if (event.key === "Escape") send(editor, { type: "dismiss" });
        else return false;
        event.preventDefault();
        return true;
      },
    },
  });
}

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
    selector: ({ editor }) => ({ menu: KEY.getState(editor.state) ?? null, focused: editor.isFocused }),
  });
  const [box, setBox] = useState<{ x: number; y: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const { menu } = s;
  const items = menu ? filterSlash(menu.query) : [];
  const open = !!menu && !menu.dismissed && s.focused && !suspended && items.length > 0;

  useEffect(() => {
    editor.registerPlugin(slashPlugin(editor), (added, plugins) => [added, ...plugins]);
    return () => {
      editor.unregisterPlugin(KEY);
    };
  }, [editor]);

  // under the line, as the mock places it
  useLayoutEffect(() => {
    if (!open || !paper || !menu) {
      setBox(null);
      return;
    }
    const place = () => {
      const block = editor.view.nodeDOM(menu.pos);
      if (!(block instanceof HTMLElement)) return;
      const next = popoverPosition(block.getBoundingClientRect(), paper.getBoundingClientRect(), WIDTH, 6);
      setBox((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [editor, paper, open, menu?.pos, menu?.query]);

  // a menu opened near the bottom of the window is scrolled into view, and so is the highlighted row
  useEffect(() => {
    if (box) root.current?.scrollIntoView?.({ block: "nearest" });
  }, [box]);
  useEffect(() => {
    root.current?.querySelector(".sel")?.scrollIntoView?.({ block: "nearest" });
  }, [menu?.index, box]);

  if (!open || !box || !menu) return null;
  return (
    <div
      ref={root}
      className="slash no-print"
      role="listbox"
      aria-label="Insert block"
      style={{ left: box.x, top: box.y, width: WIDTH }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="caption">{menu.query ? `Blocks matching “${menu.query}”` : "Insert block"}</div>
      {items.map((o, i) => (
        <button
          key={o.k}
          role="option"
          aria-selected={i === menu.index}
          className={`slash-item${i === menu.index ? " sel" : ""}`}
          onClick={() => chooseSlashItem(editor, o.k)}
          onMouseEnter={() => send(editor, { type: "hover", index: i })}
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
