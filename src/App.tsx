import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Editor } from "@tiptap/core";
import { useEditor, useEditorState } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { buildActions, openPaths, receiveFile, recentlyRan, tauriShell } from "./actions";
import { api } from "./api";
import { buildCommands, IS_MAC, type Command } from "./commands";
import { PAPER, TWIPS_PER_PX, editWarning, zonePatch, zoneView, type Zone } from "./doc/meta";
import { DocSession, type SessionIO } from "./doc/session";
import { liveComments } from "./editor/comment";
import { createExtensions } from "./editor/extensions";
import { seedQuery } from "./editor/find";
import { paginationKey, paginationPlugin, paperGeometry, repaginate } from "./editor/pagination";
import { FindBar, type FindRequest } from "./editor/FindBar";
import { AssistantPanel } from "./layout/AssistantPanel";
import { CommandPalette } from "./layout/CommandPalette";
import { CommentsRail } from "./layout/CommentsRail";
import { Dock } from "./layout/Dock";
import { MenuBar } from "./layout/MenuBar";
import { Outline, OutlineRail } from "./layout/OutlinePanel";
import { crumbs } from "./layout/outline";
import { sheetAt, type PageLayout } from "./layout/pages";
import { McpSettings } from "./layout/McpSettings";
import { Paper } from "./layout/Paper";
import { ColorPopover, FontPopover, LinkPopover } from "./layout/Popovers";
import { SelectionBubble } from "./layout/SelectionBubble";
import { SlashMenu } from "./layout/SlashMenu";
import { TopBar } from "./layout/TopBar";
import { useReadingAnchor } from "./layout/useReadingAnchor";
import { viewportLayout, type UiState } from "./layout/viewport";
import { startBridge } from "./mcp/bridge";
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
// The Assistant starts open in a window this wide (mock default), closed in a narrower one.
const ASSISTANT_OPEN_FROM = 1240;

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
    assistantOpen: window.innerWidth >= ASSISTANT_OPEN_FROM,
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  // MCP settings opened from "+ Add MCP server" start on the form that adds one
  const [addServer, setAddServer] = useState(false);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [paper, setPaper] = useState<HTMLDivElement | null>(null);
  // Where the pages break, reported by the page layout (editor/pagination.ts) once the text is laid out.
  const [pageLayout, setPageLayout] = useState<PageLayout | null>(null);
  // The header or footer being edited, and on which sheet; its editor, which the menus, the dock and the bubble act on meanwhile.
  const [editingPart, setEditingPart] = useState<{ kind: Zone; sheet: number } | null>(null);
  const [zoneEditor, setZoneEditor] = useState<Editor | null>(null);
  const target = zoneEditor ?? editor;
  const pageConfig = useRef({ ratio: PAPER.letter.height / PAPER.letter.width, zoom: 1 });
  const [popover, setPopover] = useState<"link" | "color" | "font" | null>(null);
  const [findRequest, setFindRequest] = useState<FindRequest | null>(null);
  const findCount = useRef(0);
  // who this window's comments are by
  const [userName, setUserName] = useState("Author");
  useEffect(() => void api.userName().then(setUserName, () => {}), []);

  const setUi = useCallback((patch: Partial<UiState>) => setUiState((u) => ({ ...u, ...patch })), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openLink = useCallback(() => setPopover("link"), []);
  const openColor = useCallback(() => setPopover("color"), []);
  const openFont = useCallback(() => setPopover("font"), []);
  const closePopover = useCallback(() => setPopover(null), []);
  // A double-click in a sheet's margin: edit its header or footer (adding one if there is none), once the person
  // agrees to what that loses of one kept from the file.
  const editPart = useCallback(
    async (kind: Zone, sheet: number) => {
      if (!session) return;
      const part = session.meta[`${kind}Part`];
      const warning = part && editWarning(part, kind);
      if (warning && !(await ask(warning, { title: `Edit ${kind}`, kind: "warning", okLabel: "Edit", cancelLabel: "Cancel" }))) return;
      if (!zoneView(session.meta, kind)) session.setMeta({ [kind]: "" });
      setEditingPart({ kind, sheet });
    },
    [session],
  );
  // A header or footer left with nothing in it is taken away again.
  const endPartEdit = useCallback(() => {
    setEditingPart((editing) => {
      const meta = session?.meta;
      if (editing && meta && meta[editing.kind] === "" && !(editing.kind === "footer" && meta.pageNumbers))
        session.setMeta({ [editing.kind]: null });
      return null;
    });
  }, [session]);
  // Insert ▸ Header or Footer: on the sheet in the middle of the window, where the person is looking.
  const openZone = useCallback(
    (kind: Zone) => {
      const view = scroller?.getBoundingClientRect();
      const top = paper?.getBoundingClientRect().top;
      const sheet = view && top !== undefined && pageLayout ? sheetAt(view.top + view.height / 2 - top, pageLayout) : 0;
      setEditingPart({ kind, sheet });
    },
    [scroller, paper, pageLayout],
  );
  // another document in the window has a header and footer of its own
  useEffect(() => setEditingPart(null), [session, doc.path]);
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
  const openSettings = useCallback((add = false) => {
    setAddServer(add);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    editor.commands.focus();
  }, [editor]);

  useEffect(() => {
    const created = new DocSession(editor, io);
    setSession(created);
    return () => created.destroy();
  }, [editor]);

  // AI tool calls that Rust forwards to this window run against its editor; Rust sends none
  // until the window reports ready, which it does once it listens.
  useEffect(() => {
    if (!session) return;
    let stop: (() => void) | undefined;
    let gone = false;
    startBridge(() => ({ editor, session })).then((unlisten) => {
      if (gone) return unlisten();
      stop = unlisten;
      api.editorReady().catch(() => {});
    }, tauriShell.showError);
    return () => {
      gone = true;
      stop?.();
    };
  }, [editor, session]);

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

  // The text is laid out on sheets: a spacer where a page ends, and the sheets drawn behind (Paper).
  useEffect(() => {
    if (!paper) return;
    editor.registerPlugin(
      paginationPlugin({
        geometry: (el) => paperGeometry(el, pageConfig.current.ratio),
        onLayout: setPageLayout,
        zoom: () => pageConfig.current.zoom,
      }),
    );
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(paginationKey);
    };
  }, [editor, paper]);

  // A different paper (Letter, A4), Larger text or the other body font changes how tall the sheets are or how the text breaks.
  const paperSize = PAPER[session?.meta.pageSize ?? "letter"];
  const pageRatio = paperSize.height / paperSize.width;
  const pageZoom = ui.largerText ? 1.2 : 1;
  useEffect(() => {
    pageConfig.current = { ratio: pageRatio, zoom: pageZoom };
    if (paper) repaginate(editor.view);
  }, [editor, paper, pageRatio, pageZoom, ui.sansFont]);

  const actions = useMemo(
    () =>
      session
        ? buildActions({ editor: target, session, ui, setUi, openPalette, openLink, openColor, openFont, openFind, openZone, commentAuthor: userName })
        : {},
    [target, session, ui, setUi, openPalette, openLink, openColor, openFont, openFind, openZone, userName],
  );
  const commands: Command[] = session ? buildCommands({ editor: target, zoneEditing: !!zoneEditor, session, ui, setUi, actions }) : [];
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
  // the comments whose mark is in the document; the text moves under them as it is edited
  const comments = useEditorState({
    editor,
    selector: ({ editor }) => (session ? liveComments(session.meta.comments, editor.state.doc) : []),
  });
  // the rail takes room from the page, so it is only there when the document has comments to put in it
  const showComments = layout.showComments && comments.length > 0;
  const comment = commands.find((c) => c.id === "comment");
  const leftMode = layout.showOutline ? "outline" : layout.outlineRail ? "rail" : "none";
  // the page narrows beside an open comments rail, so a panel that opens or closes can rewrap the text: hold the reading position
  useReadingAnchor(editor, scroller, [leftMode, layout.assistantOpen, showComments, layout.showMenuBar].join(), resizing);

  return (
    <div className={`app${resizing ? " snap" : ""}`} data-font={ui.sansFont ? "sans" : undefined}>
      <TopBar path={doc.path} dirty={doc.dirty} focus={ui.focus} assistantOpen={ui.assistantOpen && !ui.focus} run={run} />
      <MenuBar commands={commands} visible={layout.showMenuBar} editor={target} look={session?.meta.look} />
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
        {/* the page is wider while the assistant is closed */}
        <main className={`main${layout.assistantOpen ? "" : " wide"}`}>
          <div className="scroll" ref={setScroller}>
            <div className="canvas">
              <Paper
                editor={editor}
                large={ui.largerText}
                layout={pageLayout}
                headerView={session && zoneView(session.meta, "header")}
                footerView={session && zoneView(session.meta, "footer")}
                editing={editingPart && session && zoneView(session.meta, editingPart.kind) ? editingPart : null}
                onEdit={session ? editPart : undefined}
                onPartChange={(kind, view) => session?.setMeta(zonePatch(kind, view))}
                onEditEnd={endPartEdit}
                onEditor={setZoneEditor}
                look={session?.meta.look}
                paperWidth={paperSize.width / TWIPS_PER_PX}
                paperRef={setPaper}
              >
                <SelectionBubble
                  editor={target}
                  paper={paper}
                  scroller={scroller}
                  suspended={paletteOpen || settingsOpen}
                  run={run}
                  onComment={comment?.enabled ? comment.run : undefined}
                />
                <SlashMenu editor={editor} paper={paper} suspended={paletteOpen || settingsOpen} />
                {popover === "link" && <LinkPopover editor={target} paper={paper} onClose={closePopover} />}
                {popover === "color" && <ColorPopover editor={target} paper={paper} onClose={closePopover} />}
                {popover === "font" && <FontPopover editor={target} paper={paper} onClose={closePopover} />}
              </Paper>
              {/* the comment cards go in .comments-inner, which keeps its width while the rail opens */}
              <div
                className={`comments-rail${showComments ? " open" : ""}`}
                inert={!showComments}
                aria-hidden={showComments ? undefined : true}
              >
                <div className="comments-inner">
                  {session && <CommentsRail editor={editor} session={session} comments={comments} userName={userName} open={showComments} />}
                </div>
              </div>
            </div>
          </div>
          <Dock editor={target} run={run} commentsOpen={showComments} />
        </main>
        {/* mock 231–329: the panel's content goes in .assistant-inner, which keeps its width while the panel opens */}
        <aside
          className={`side assistant-panel${layout.assistantOpen ? " open" : ""}`}
          style={{ "--assistant-w": layout.assistantWidth } as CSSProperties}
          inert={!layout.assistantOpen}
          aria-hidden={layout.assistantOpen ? undefined : true}
        >
          <div className="assistant-inner">
            <AssistantPanel editor={editor} settingsOpen={settingsOpen} onClose={() => run("assistant")} onSettings={openSettings} />
          </div>
        </aside>
      </div>
      {paletteOpen && <CommandPalette commands={commands} onClose={closePalette} />}
      {settingsOpen && <McpSettings onClose={closeSettings} addServer={addServer} />}
    </div>
  );
}
