import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildActions, openPaths, receiveFile, recentlyRan, tauriShell } from "./actions";
import { api } from "./api";
import { buildCommands, IS_MAC, type Command } from "./commands";
import { DocSession, type SessionIO } from "./doc/session";
import { createExtensions } from "./editor/extensions";
import { CommandPalette } from "./layout/CommandPalette";
import { MenuBar } from "./layout/MenuBar";
// with its extension: on a case-insensitive disk "./layout/Outline" would find outline.ts
import { Outline, OutlineRail } from "./layout/Outline.tsx";
import { crumbs } from "./layout/outline";
import { Paper } from "./layout/Paper";
import { TopBar } from "./layout/TopBar";
import { viewportLayout, type UiState } from "./layout/viewport";
import { startTheme } from "./theme";

startTheme();

// The session talks to the Rust core through the typed wrappers.
const io: SessionIO = {
  read: api.readFile,
  write: api.writeFile,
  exists: api.fileExists,
  meta: ({ path, dirty, blank }) => void api.setDocMeta(path, dirty, blank).catch(() => {}),
};

const FONT_KEY = "docbro-font";

function initialUi(): UiState {
  let sansFont = false;
  try {
    sansFont = localStorage.getItem(FONT_KEY) === "sans";
  } catch {
    // no storage: the serif default
  }
  return {
    focus: false,
    hideOutline: false,
    forceOutline: false,
    hideComments: false,
    assistantOpen: false,
    menuBar: true,
    largerText: false,
    sansFont,
  };
}

// Save can arrive twice for one key press off macOS: the native menu's accelerator and the key handler below.
const SAVE_IDS = new Set(["save", "save_as"]);

export default function App() {
  const editor = useEditor({ extensions: createExtensions(), autofocus: true });
  const [session, setSession] = useState<DocSession | null>(null);
  const [doc, setDoc] = useState(() => ({ path: null as string | null, dirty: false }));
  const [ui, setUiState] = useState(initialUi);
  const [width, setWidth] = useState(() => window.innerWidth);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  const setUi = useCallback((patch: Partial<UiState>) => setUiState((u) => ({ ...u, ...patch })), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  // The editor keeps its selection while the palette has focus; focusing it brings the selection back.
  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    editor.commands.focus();
  }, [editor]);

  useEffect(() => {
    const created = new DocSession(editor, io);
    setSession(created);
    return () => created.destroy();
  }, [editor]);

  // Any session change re-renders: the top bar shows the path and dirty state, the menus read the meta (header, footer…).
  useEffect(() => {
    if (!session) return;
    const update = () => setDoc({ path: session.path, dirty: session.dirty });
    update();
    return session.onChange(update);
  }, [session]);

  useEffect(() => {
    const title = `${crumbs(doc.path).name}${doc.dirty ? " — Edited" : ""}`;
    getCurrentWindow().setTitle(title).catch(() => {});
  }, [doc.path, doc.dirty]);

  useEffect(() => {
    try {
      localStorage.setItem(FONT_KEY, ui.sansFont ? "sans" : "serif");
    } catch {
      // not remembered, still applied
    }
  }, [ui.sansFont]);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const actions = useMemo(
    () => (session ? buildActions({ editor, session, ui, setUi, openPalette }) : {}),
    [editor, session, ui, setUi, openPalette],
  );
  const commands: Command[] = session ? buildCommands({ editor, session, ui, setUi, actions }) : [];
  // Listeners registered once run the commands as they are now.
  const latest = useRef(commands);
  useEffect(() => {
    latest.current = commands;
  });
  const run = useCallback((id: string) => latest.current.find((c) => c.id === id)?.run(), []);

  useEffect(() => {
    if (!session) return;
    const repeat = recentlyRan(500);
    const command = (id: string) => {
      if (SAVE_IDS.has(id) && repeat(id)) return;
      run(id);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if ((mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") || (e.altKey && e.code === "Slash")) {
        e.preventDefault();
        openPalette();
      } else if (!IS_MAC && e.ctrlKey && !e.altKey && e.key.toLowerCase() === "s") {
        // on macOS the native menu always takes ⌘S; elsewhere its accelerator may not reach a focused webview
        e.preventDefault();
        command(e.shiftKey ? "save_as" : "save");
      }
    };
    window.addEventListener("keydown", onKeyDown);

    // only events sent to this window: every window has its own document
    const win = getCurrentWindow();
    const unlisten: Promise<() => void>[] = [
      win.listen<string>("menu", (e) => command(e.payload)),
      win.listen<string>("open-file", (e) => void receiveFile(tauriShell, session, e.payload)),
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "drop") void openPaths(tauriShell, session, e.payload.paths);
      }),
      win.onCloseRequested(async (e) => {
        if (!session.dirty) return;
        e.preventDefault();
        const discard = await ask("This document has unsaved changes. Close it without saving?", {
          title: "Unsaved changes",
          kind: "warning",
          okLabel: "Close",
          cancelLabel: "Cancel",
        });
        if (discard) await win.destroy();
      }),
    ];
    // the file this window was opened for, handed over before we were listening
    api.takePendingOpen().then((paths) => {
      if (paths[0]) void receiveFile(tauriShell, session, paths[0]);
    }, tauriShell.showError);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unlisten.forEach((u) => void u.then((f) => f()));
    };
  }, [session, run, openPalette]);

  const layout = viewportLayout(width, ui);

  return (
    <div className="app" data-font={ui.sansFont ? "sans" : undefined}>
      <TopBar path={doc.path} dirty={doc.dirty} focus={ui.focus} assistantOpen={ui.assistantOpen} run={run} />
      {layout.showMenuBar && <MenuBar commands={commands} />}
      <div className="workspace">
        {layout.outlineRail && <OutlineRail onShow={() => run("outline")} />}
        {layout.showOutline && <Outline editor={editor} scroller={scroller} path={doc.path} onHide={() => run("outline")} />}
        <main className="main">
          <div className="scroll" ref={setScroller}>
            <div className="canvas">
              <Paper editor={editor} large={ui.largerText} />
              {/* the comment cards (Task 13) */}
              {layout.showComments && <div className="comments-rail" />}
            </div>
          </div>
        </main>
        {layout.assistantOpen && (
          // mock 231–239: the panel's header; its body comes with Tasks 12 and 17
          <aside className="assistant-panel" style={{ width: layout.assistantWidth }}>
            <div className="assistant-head">
              <span className="title">Assistant</span>
              <span className="pill">MCP</span>
              <div className="spacer" />
              <button className="close-btn" title="Close" aria-label="Close" onClick={() => run("assistant")}>
                ×
              </button>
            </div>
          </aside>
        )}
      </div>
      {paletteOpen && <CommandPalette commands={commands} onClose={closePalette} />}
    </div>
  );
}
