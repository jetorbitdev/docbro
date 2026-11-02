import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { Editor } from "@tiptap/core";
import { api } from "./api";
import type { CommandHost } from "./commands";
import { LossyWriteError, type DocSession } from "./doc/session";
import { formatOf, UNKNOWN_FORMAT } from "./formats";
import { pickImage } from "./layout/blocks";
import { addComment } from "./layout/comments";
import { roomForComments, type UiState } from "./layout/viewport";

type Filter = { name: string; extensions: string[] };

/** The dialogs and window calls the file commands need, so tests can answer them. */
export interface Shell {
  /** Shows `text` with three buttons and resolves with the label of the one pressed. */
  choose(text: string, opts: { title: string; buttons: { yes: string; no: string; cancel: string } }): Promise<string>;
  /** Shows `text` with two buttons and resolves with true when `ok` was pressed. */
  confirm(text: string, opts: { title: string; ok: string; cancel: string }): Promise<boolean>;
  showError(e: unknown): void;
  pickOpen(): Promise<string[] | null>;
  pickSave(defaultPath: string, filters: Filter[]): Promise<string | null>;
  openInWindow(path: string | null, here?: boolean): Promise<boolean>;
}

export const tauriShell: Shell = {
  choose: (text, { title, buttons }) => message(text, { title, kind: "warning", buttons }),
  confirm: (text, { title, ok, cancel }) => ask(text, { title, kind: "info", okLabel: ok, cancelLabel: cancel }),
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

// ------------------------------------------------------------------ Google Docs

/** What the upload needs from Rust, so tests can answer for Google. */
export type GoogleApi = Pick<typeof api, "googleStatus" | "googleUpload" | "googleOpen">;

/**
 * Puts the document as it is now, saved or not, in Google Docs, then offers to show it. Without a
 * connected account it opens the Google Docs settings instead, or says where they are.
 */
export async function uploadToGoogleDocs(
  shell: Shell,
  session: DocSession,
  google: GoogleApi,
  opts: { openSettings?: () => void; onBusy?: (busy: boolean) => void } = {},
): Promise<void> {
  if (!(await google.googleStatus()).connected) {
    if (opts.openSettings) return opts.openSettings();
    throw new Error("Connect your Google account under Google Docs in MCP settings first.");
  }
  const title = session.name.replace(/\.(docx|md|markdown)$/i, "");
  opts.onBusy?.(true);
  let done;
  try {
    done = await google.googleUpload(await session.docx(), session.path, title);
  } finally {
    opts.onBusy?.(false);
  }
  const text = !done.created
    ? `The Google Doc "${title}" now has this document's content.`
    : session.path
      ? `"${title}" is now a Google Doc in your Drive. Uploading this file again updates the same Google Doc.`
      : `"${title}" is now a Google Doc in your Drive. Save this document to a file to update the same Google Doc next time.`;
  const open = await shell.confirm(text, { title: "Uploaded to Google Docs", ok: "Open in browser", cancel: "Done" });
  if (open) await google.googleOpen(done.file_id);
}

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

/** Opens the print dialog. On macOS window.print() goes through Tauri and can be refused,
 *  so a refusal is shown rather than leaving ⌘P doing nothing. */
export async function printPage(shell: Shell): Promise<void> {
  try {
    await (window.print() as unknown);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    shell.showError(new Error(`DocBro could not open the print dialog (${why}). Try ⌘P again. If it still fails, save the document and print it from Word or Pages.`));
  }
}

// ------------------------------------------------------------------ the registry's actions

export interface ActionDeps {
  editor: Editor;
  session: DocSession;
  ui: UiState;
  setUi(patch: Partial<UiState>): void;
  openPalette(): void;
  /** Open the link field / the text color swatches / the font list; a command without its opener stays disabled. */
  openLink?(): void;
  openColor?(): void;
  openFont?(): void;
  /** Open the Find bar, with its replace field when `replace`; without it Find and Replace stay disabled. */
  openFind?(replace: boolean): void;
  /** Opens the header or footer just switched on for typing. */
  openZone?(kind: "header" | "footer"): void;
  /** Who a new comment is by; without it there is no Comment action. */
  commentAuthor?: string;
  /** Opens the Google Docs settings, for an upload with no account connected. */
  openGoogleSettings?(): void;
  /** Told when an upload to Google Docs starts and ends. */
  onUploading?(busy: boolean): void;
  shell?: Shell;
  google?: GoogleApi;
}

/** The actions behind the commands that need more than the editor. */
export function buildActions(deps: ActionDeps): CommandHost["actions"] {
  const { editor, session, ui, setUi, openPalette, openLink, openColor, openFont, openFind, openZone, commentAuthor, shell = tauriShell, google = api } = deps;
  return {
    newWindow: () => void shell.openInWindow(null).catch(shell.showError),
    open: () => void runExclusive(shell, () => pickAndOpen(shell, session)),
    save: () => void runExclusive(shell, () => saveDocument(shell, session)),
    saveAs: () => void runExclusive(shell, () => saveAs(shell, session)),
    print: () => void printPage(shell),
    uploadGoogle: () =>
      void runExclusive(shell, () =>
        uploadToGoogleDocs(shell, session, google, { openSettings: deps.openGoogleSettings, onBusy: deps.onUploading }),
      ),
    palette: openPalette,
    insertImage: () => void pickImage(editor),
    // a header or footer kept from the file counts as on, and the item takes it away
    toggleHeader: () => {
      const { header, headerPart } = session.meta;
      if (header !== null || headerPart) return session.setMeta({ header: null, headerPart: null });
      session.setMeta({ header: "" });
      openZone?.("header");
    },
    toggleFooter: () => {
      const { footer, footerPart } = session.meta;
      if (footer !== null || footerPart) return session.setMeta({ footer: null, footerPart: null, pageNumbers: false });
      session.setMeta({ footer: "" });
      openZone?.("footer");
    },
    togglePageNumbers: () => {
      const { footer, pageNumbers } = session.meta;
      session.setMeta(footer === null ? { footer: "", pageNumbers: true } : { pageNumbers: !pageNumbers });
    },
    ...(openLink && { insertLink: openLink }),
    ...(openColor && { pickColor: openColor }),
    ...(openFont && { pickFont: openFont }),
    ...(openFind && { find: () => openFind(false), replace: () => openFind(true) }),
    // the new comment's card opens in the rail, which may first need the room
    ...(commentAuthor !== undefined && {
      addComment: () => {
        if (addComment(editor, session, commentAuthor) === null) return;
        const room = roomForComments(window.innerWidth, ui);
        if (room && Object.keys(room).length) setUi(room);
      },
    }),
  };
}
