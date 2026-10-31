import { IS_MAC, platformKeys } from "../commands";
import { crumbs } from "./outline";

interface Props {
  path: string | null;
  dirty: boolean;
  focus: boolean;
  assistantOpen: boolean;
  run(id: string): void;
}

/** Mock 41–65. The bar is the window's drag region: every part that is not a button carries the attribute, because a drag starts only on the element itself. */
export function TopBar({ path, dirty, focus, assistantOpen, run }: Props) {
  const { folder, name } = crumbs(path);
  const status = dirty ? "Edited" : path ? "Saved" : "";
  return (
    <header className={`topbar${IS_MAC ? " mac" : ""}`} data-tauri-drag-region>
      <div className="logo" title="DocBro" data-tauri-drag-region>
        D
      </div>
      <div className="crumbs" title={path ?? undefined} data-tauri-drag-region>
        {folder && (
          <>
            <span className="folder" data-tauri-drag-region>{folder}</span>
            <span className="slash" data-tauri-drag-region>/</span>
          </>
        )}
        <span className="name" data-tauri-drag-region>{name}</span>
        {status && <span className="status" data-tauri-drag-region>{status}</span>}
      </div>
      <div className="spacer" data-tauri-drag-region />
      <div className="bar-actions">
        <button className={`bar-btn${focus ? " on" : ""}`} title="Focus mode" onClick={() => run("focus")}>
          Focus
        </button>
        <button className={`bar-btn assistant${assistantOpen ? " on" : ""}`} title="Assistant" onClick={() => run("assistant")}>
          <span className="dot" />
          Assistant
        </button>
        <button className="bar-btn icon" title="Toggle dark mode" aria-label="Toggle dark mode" onClick={() => run("dark_mode")}>
          ◐
        </button>
        <button className="primary-btn" title={`Save (${platformKeys("⌘S")})`} onClick={() => run("save")}>
          Save
        </button>
      </div>
    </header>
  );
}
