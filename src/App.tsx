import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { api } from "./api";
import { DocSession, LossyWriteError, type SessionIO } from "./doc/session";
import { createExtensions } from "./editor/extensions";
import { formatOf, UNKNOWN_FORMAT } from "./formats";

// The session talks to the Rust core through the typed wrappers.
const io: SessionIO = {
  read: api.readFile,
  write: api.writeFile,
  exists: api.fileExists,
  meta: ({ path, dirty, blank }) => void api.setDocMeta(path, dirty, blank).catch(() => {}),
};

const showError = (e: unknown) => void message(e instanceof Error ? e.message : String(e), { title: "DocBro", kind: "error" });

/** Shows `path` in this window, after asking whether to throw away unsaved changes. */
async function openHere(session: DocSession, path: string) {
  if (
    session.dirty &&
    !(await ask("This document has unsaved changes. Discard them?", {
      title: "Unsaved changes",
      kind: "warning",
      okLabel: "Discard",
      cancelLabel: "Cancel",
    }))
  )
    return;
  try {
    await session.open(path, { discard: true });
  } catch (e) {
    showError(e);
  }
}

/** The first file replaces an untouched blank document; the others get windows of their own. */
async function openPaths(session: DocSession, paths: string[]) {
  for (const [i, path] of paths.entries()) {
    try {
      if (!formatOf(path)) throw new Error(UNKNOWN_FORMAT);
      if (await api.openInWindow(path, i === 0 && session.blank)) await openHere(session, path);
    } catch (e) {
      showError(e);
    }
  }
}

async function pickAndOpen(session: DocSession) {
  const picked = await openDialog({
    multiple: true,
    filters: [{ name: "Documents", extensions: ["docx", "md", "markdown"] }],
  });
  if (picked) await openPaths(session, picked);
}

/** Saves, and when that would lose something asks whether to go on. */
async function saveTo(session: DocSession, path: string | null, overwrite = false) {
  try {
    await session.save(path, { overwrite });
  } catch (e) {
    if (!(e instanceof LossyWriteError)) throw e;
    const choice = await message(e.message, {
      title: "Some content will be lost",
      kind: "warning",
      buttons: { yes: "Save anyway", no: "Save As…", cancel: "Cancel" },
    });
    if (choice === "Save anyway") await session.save(path, { overwrite, acceptLoss: true });
    else if (choice === "Save As…") await saveAs(session);
  }
}

async function saveAs(session: DocSession) {
  const word = { name: "Word document", extensions: ["docx"] };
  const markdown = { name: "Markdown", extensions: ["md", "markdown"] };
  let target = await saveDialog({
    defaultPath: session.path ?? "Untitled.docx",
    filters: session.path && formatOf(session.path) === "md" ? [markdown, word] : [word, markdown],
  });
  if (!target) return;
  if (!formatOf(target)) target += ".docx";
  // the save dialog already asked about replacing a file
  await saveTo(session, target, true);
}

const saveDocument = (session: DocSession) => (session.path ? saveTo(session, null) : saveAs(session));

// One file command at a time, so a shortcut that reaches the window twice opens one dialog, not two.
// Only about dialogs: the session itself runs open and save one after the other.
let busy = false;
async function runExclusive(task: () => Promise<void>) {
  if (busy) return;
  busy = true;
  try {
    await task();
  } catch (e) {
    showError(e);
  } finally {
    busy = false;
  }
}

// The bare window: an editor and the plumbing every window keeps. The layout replaces the rest.
export default function App() {
  const editor = useEditor({
    extensions: createExtensions(),
    autofocus: true,
    editorProps: { attributes: { style: "outline: none; min-height: 70vh" } },
  });
  const [session, setSession] = useState<DocSession | null>(null);
  const [title, setTitle] = useState("Untitled");

  useEffect(() => {
    const created = new DocSession(editor, io);
    setSession(created);
    return () => created.destroy();
  }, [editor]);

  useEffect(() => {
    if (!session) return;
    const update = () => setTitle(`${session.name}${session.dirty ? " — Edited" : ""}`);
    update();
    return session.onChange(update);
  }, [session]);

  useEffect(() => {
    getCurrentWindow().setTitle(title).catch(() => {});
  }, [title]);

  useEffect(() => {
    if (!session) return;
    const command = (id: string) => {
      switch (id) {
        case "open": return runExclusive(() => pickAndOpen(session));
        case "save": return runExclusive(() => saveDocument(session));
        case "save_as": return runExclusive(() => saveAs(session));
        default: console.log("menu", id); // the layout runs the rest
      }
    };
    // Temporary: the menu's own shortcut normally arrives as a `menu` event.
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void command(e.shiftKey ? "save_as" : "save");
      }
    };
    window.addEventListener("keydown", onKeyDown);

    // only events sent to this window: every window has its own document
    const win = getCurrentWindow();
    const unlisten: Promise<() => void>[] = [
      win.listen<string>("menu", (e) => void command(e.payload)),
      win.listen<string>("open-file", (e) => void openHere(session, e.payload)),
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "drop") void openPaths(session, e.payload.paths);
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
      if (paths[0]) void openHere(session, paths[0]);
    }, showError);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unlisten.forEach((u) => void u.then((f) => f()));
    };
  }, [session]);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "72px 48px", fontFamily: "'IBM Plex Serif', Georgia, serif" }}>
      <EditorContent editor={editor} className="doc" />
    </main>
  );
}
