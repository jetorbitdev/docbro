import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { buildActions, openPaths, receiveFile, recentlyRan, tauriShell } from "./actions";
import { api } from "./api";
import { buildCommands, IS_MAC, type Command } from "./commands";
import { DocSession, type SessionIO } from "./doc/session";
import { createExtensions } from "./editor/extensions";
import { seedQuery } from "./editor/find";
import { FindBar, type FindRequest } from "./editor/FindBar";
import { CommandPalette } from "./layout/CommandPalette";
import { Dock } from "./layout/Dock";
import { MenuBar } from "./layout/MenuBar";
import { Outline, OutlineRail } from "./layout/OutlinePanel";
import { crumbs } from "./layout/outline";
import { Paper } from "./layout/Paper";
import { ColorPopover, LinkPopover } from "./layout/Popovers";
import { SelectionBubble } from "./layout/SelectionBubble";
import { SlashMenu } from "./layout/SlashMenu";
import { TopBar } from "./layout/TopBar";
import { useReadingAnchor } from "./layout/useReadingAnchor";
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
// How long after the last resize event the side panels stay without their open/close animation.
const SNAP_MS = 150;

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
  // True while the window is being resized and a moment after: panels that a breakpoint opens or closes then snap.
  const [resizing, setResizing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [paper, setPaper] = useState<HTMLDivElement | null>(null);
  const [popover, setPopover] = useState<"link" | "color" | null>(null);
  const [findRequest, setFindRequest] = useState<FindRequest | null>(null);
  const findCount = useRef(0);

  const setUi = useCallback((patch: Partial<UiState>) => setUiState((u) => ({ ...u, ...patch })), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openLink = useCallback(() => setPopover("link"), []);
  const openColor = useCallback(() => setPopover("color"), []);
  const closePopover = useCallback(() => setPopover(null), []);
  // Edit ▸ Find… and Find and replace…: opens the bar, or takes the focus back to one already open
  const openFind = useCallback(
    (replace: boolean) => setFindRequest({ id: ++findCount.current, replace, seed: seedQuery(editor.state) }),
    [editor],
  );
  // the page gets its focus back, and with it the match the bar was on as the selection
  const closeFind = useCallback(() => {
    setFindRequest(null);
    editor.commands.focus();
  }, [editor]);
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
    let settle: number | undefined;
    const onResize = () => {
      setWidth(window.innerWidth);
      setResizing(true);
      window.clearTimeout(settle);
      settle = window.setTimeout(() => setResizing(false), SNAP_MS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(settle);
    };
  }, []);

  const actions = useMemo(
    () => (session ? buildActions({ editor, session, ui, setUi, openPalette, openLink, openColor, openFind }) : {}),
    [editor, session, ui, setUi, openPalette, openLink, openColor, openFind],
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
  const comment = commands.find((c) => c.id === "comment");
  const leftMode = layout.showOutline ? "outline" : layout.outlineRail ? "rail" : "none";
  // the page narrows beside an open comments rail, so a panel that opens or closes can rewrap the text: hold the reading position
  useReadingAnchor(editor, scroller, [leftMode, layout.assistantOpen, layout.showComments, layout.showMenuBar].join(), resizing);

  return (
    <div className={`app${resizing ? " snap" : ""}`} data-font={ui.sansFont ? "sans" : undefined}>
      <TopBar path={doc.path} dirty={doc.dirty} focus={ui.focus} assistantOpen={ui.assistantOpen} run={run} />
      <MenuBar commands={commands} visible={layout.showMenuBar} />
      {findRequest && <FindBar editor={editor} request={findRequest} onClose={closeFind} />}
      <div className="workspace">
        {/* the side panels stay mounted and animate their width (styles.css); a closed one is inert */}
        <div className={`side side-left${leftMode === "none" ? "" : " open"}`} data-mode={leftMode}>
          <OutlineRail active={leftMode === "rail"} onShow={() => run("outline")} />
          <Outline
            editor={editor}
            active={leftMode === "outline"}
            scroller={scroller}
            path={doc.path}
            onHide={() => run("outline")}
          />
        </div>
        <main className="main">
          <div className="scroll" ref={setScroller}>
            <div className="canvas">
              <Paper editor={editor} large={ui.largerText} paperRef={setPaper}>
                <SelectionBubble
                  editor={editor}
                  paper={paper}
                  scroller={scroller}
                  suspended={paletteOpen}
                  run={run}
                  onComment={comment?.enabled ? comment.run : undefined}
                />
                <SlashMenu editor={editor} paper={paper} suspended={paletteOpen} />
                {popover === "link" && <LinkPopover editor={editor} paper={paper} onClose={closePopover} />}
                {popover === "color" && <ColorPopover editor={editor} paper={paper} onClose={closePopover} />}
              </Paper>
              {/* the comment cards (Task 13) go in .comments-inner, which keeps its width while the rail opens */}
              <div
                className={`comments-rail${layout.showComments ? " open" : ""}`}
                inert={!layout.showComments}
                aria-hidden={layout.showComments ? undefined : true}
              >
                <div className="comments-inner" />
              </div>
            </div>
          </div>
          <Dock editor={editor} run={run} />
        </main>
        {/* mock 231–239: the panel's header; its body comes with Tasks 12 and 17 */}
        <aside
          className={`side assistant-panel${layout.assistantOpen ? " open" : ""}`}
          style={{ "--assistant-w": layout.assistantWidth } as CSSProperties}
          inert={!layout.assistantOpen}
          aria-hidden={layout.assistantOpen ? undefined : true}
        >
          <div className="assistant-inner">
            <div className="assistant-head">
              <span className="title">Assistant</span>
              <span className="pill">MCP</span>
              <div className="spacer" />
              <button className="close-btn" title="Close" aria-label="Close" onClick={() => run("assistant")}>
                ×
              </button>
            </div>
          </div>
        </aside>
      </div>
      {paletteOpen && <CommandPalette commands={commands} onClose={closePalette} />}
    </div>
  );
}
