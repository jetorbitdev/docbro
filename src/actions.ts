import { message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { Editor } from "@tiptap/core";
import { api } from "./api";
import type { CommandHost } from "./commands";
import { LossyWriteError, type DocSession } from "./doc/session";
import { formatOf, UNKNOWN_FORMAT } from "./formats";
import { pickImage } from "./layout/blocks";
import type { UiState } from "./layout/viewport";

type Filter = { name: string; extensions: string[] };

/** The dialogs and window calls the file commands need, so tests can answer them. */
export interface Shell {
  /** Shows `text` with three buttons and resolves with the label of the one pressed. */
  choose(text: string, opts: { title: string; buttons: { yes: string; no: string; cancel: string } }): Promise<string>;
  showError(e: unknown): void;
  pickOpen(): Promise<string[] | null>;
  pickSave(defaultPath: string, filters: Filter[]): Promise<string | null>;
  openInWindow(path: string | null, here?: boolean): Promise<boolean>;
}

export const tauriShell: Shell = {
  choose: (text, { title, buttons }) => message(text, { title, kind: "warning", buttons }),
  showError: (e) => void message(e instanceof Error ? e.message : String(e), { title: "DocBro", kind: "error" }),
  pickOpen: () => openDialog({ multiple: true, filters: [{ name: "Documents", extensions: ["docx", "md", "markdown"] }] }),
  pickSave: (defaultPath, filters) => saveDialog({ defaultPath, filters }),
  openInWindow: api.openInWindow,
};

// ------------------------------------------------------------------ files from outside

/**
 * Shows a file the shell routed to this window (Finder, a drop, a pending open) without losing
 * an edit: a window with unsaved changes, even ones typed while the file was read, hands the
 * file to a new window instead.
 */
export async function receiveFile(shell: Shell, session: DocSession, path: string): Promise<void> {
  try {
    if (!session.dirty) {
      try {
        // no `discard`: the session refuses if the person types while the file is read
        await session.open(path);
        return;
      } catch (e) {
        if (!session.dirty) throw e;
      }
    }
    await shell.openInWindow(path, false);
  } catch (e) {
    shell.showError(e);
  }
}

/** The first file replaces an untouched blank document; the others get windows of their own. */
export async function openPaths(shell: Shell, session: DocSession, paths: string[]): Promise<void> {
  for (const [i, path] of paths.entries()) {
    try {
      if (!formatOf(path)) throw new Error(UNKNOWN_FORMAT);
      if (await shell.openInWindow(path, i === 0 && session.blank)) await receiveFile(shell, session, path);
    } catch (e) {
      shell.showError(e);
    }
  }
}

export async function pickAndOpen(shell: Shell, session: DocSession): Promise<void> {
  const picked = await shell.pickOpen();
  if (picked) await openPaths(shell, session, picked);
}

// ------------------------------------------------------------------ save

/** Saves, and when that would lose something asks whether to go on. */
export async function saveTo(shell: Shell, session: DocSession, path: string | null, overwrite = false): Promise<void> {
  try {
    await session.save(path, { overwrite });
  } catch (e) {
    if (!(e instanceof LossyWriteError)) throw e;
    const choice = await shell.choose(e.message, {
      title: "Some content will be lost",
      buttons: { yes: "Save anyway", no: "Save As…", cancel: "Cancel" },
    });
    if (choice === "Save anyway") await session.save(path, { overwrite, acceptLoss: true });
    else if (choice === "Save As…") await saveAs(shell, session);
  }
}

export async function saveAs(shell: Shell, session: DocSession): Promise<void> {
  const word = { name: "Word document", extensions: ["docx"] };
  const markdown = { name: "Markdown", extensions: ["md", "markdown"] };
  let target = await shell.pickSave(
    session.path ?? "Untitled.docx",
    session.path && formatOf(session.path) === "md" ? [markdown, word] : [word, markdown],
  );
  if (!target) return;
  if (!formatOf(target)) target += ".docx";
  // the save dialog already asked about replacing a file
  await saveTo(shell, session, target, true);
}

export const saveDocument = (shell: Shell, session: DocSession) =>
  session.path ? saveTo(shell, session, null) : saveAs(shell, session);

// ------------------------------------------------------------------ one at a time

// One file command at a time, so a shortcut that reaches the window twice opens one dialog, not two.
// Only about dialogs: the session itself runs open and save one after the other.
let busy = false;
export async function runExclusive(shell: Shell, task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await task();
  } catch (e) {
    shell.showError(e);
  } finally {
    busy = false;
  }
}

/**
 * For a command that can arrive twice for one key press (the native menu's accelerator and the
 * window's own key handler): true when `id` already ran within the last `ms`.
 */
export function recentlyRan(ms: number, now: () => number = Date.now): (id: string) => boolean {
  const last = new Map<string, number>();
  return (id) => {
    const t = now();
    const prev = last.get(id);
    if (prev !== undefined && t - prev <= ms) return true;
    last.set(id, t);
    return false;
  };
}

// ------------------------------------------------------------------ the registry's actions

export interface ActionDeps {
  editor: Editor;
  session: DocSession;
  ui: UiState;
  setUi(patch: Partial<UiState>): void;
  openPalette(): void;
  /** Open the link field / the text color swatches; a command without its opener stays disabled. */
  openLink?(): void;
  openColor?(): void;
  /** Open the Find bar, with its replace field when `replace`; without it Find and Replace stay disabled. */
  openFind?(replace: boolean): void;
  shell?: Shell;
}

/** The actions behind the commands that need more than the editor. Tasks 13 and 14 add theirs here. */
export function buildActions(deps: ActionDeps): CommandHost["actions"] {
  const { editor, session, openPalette, openLink, openColor, openFind, shell = tauriShell } = deps;
  return {
    newWindow: () => void shell.openInWindow(null).catch(shell.showError),
    open: () => void runExclusive(shell, () => pickAndOpen(shell, session)),
    save: () => void runExclusive(shell, () => saveDocument(shell, session)),
    saveAs: () => void runExclusive(shell, () => saveAs(shell, session)),
    print: () => window.print(),
    palette: openPalette,
    insertImage: () => void pickImage(editor),
    toggleHeader: () => session.setMeta({ header: session.meta.header === null ? "" : null }),
    toggleFooter: () =>
      session.setMeta(session.meta.footer === null ? { footer: "" } : { footer: null, pageNumbers: false }),
    togglePageNumbers: () => {
      const { footer, pageNumbers } = session.meta;
      session.setMeta(footer === null ? { footer: "", pageNumbers: true } : { pageNumbers: !pageNumbers });
    },
    ...(openLink && { insertLink: openLink }),
    ...(openColor && { pickColor: openColor }),
    ...(openFind && { find: () => openFind(false), replace: () => openFind(true) }),
  };
}
