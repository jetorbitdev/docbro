import type { Editor, EditorEvents } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, Selection } from "@tiptap/pm/state";
import { formatOf, readDocument, UNKNOWN_FORMAT, writeDocument } from "../formats";
import type { DroppedPart } from "../formats/docx/import";
import { emptyMeta, type DocMeta } from "./meta";

/** What a session needs from the outside world: files, and a way to tell the shell what the window shows. */
export interface SessionIO {
  read(path: string): Promise<Uint8Array>;
  write(path: string, b: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  meta(m: { path: string | null; dirty: boolean; blank: boolean }): void;
}

/**
 * Saving would drop something the file has (or the format cannot hold) and nobody agreed to
 * that yet. The message says what, for a person or a model; callers ask, then retry with `acceptLoss`.
 */
export class LossyWriteError extends Error {}

const UNSAVED = "The document has unsaved changes. Save it first, or pass discard: true.";

const isAbsolute = (path: string) => /^([\\/]|[A-Za-z]:[\\/])/.test(path);

// Key order and a comment's `editing` flag (which card has its text box open) are not content.
const metaKey = (meta: DocMeta) =>
  JSON.stringify(meta, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "editing")
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : value,
  );

/**
 * The one owner of a window's file state: which file the editor shows, whether it has unsaved
 * changes, and the parts of the file the editor could not keep. The document itself stays in the
 * editor; `meta` holds what a Word file has beyond it (comments, header, footer, page numbers).
 */
export class DocSession {
  private _path: string | null = null;
  private _meta: DocMeta = emptyMeta();
  private _dropped: DroppedPart[] = [];
  // The document and meta as of the last open or save. Dirty means "differs from these", so
  // undoing back to them is clean again. ProseMirror shares unchanged nodes between versions,
  // so comparing is fast however long the document is.
  private savedDoc: ProseMirrorNode;
  private savedMeta: string;
  private told: { path: string | null; dirty: boolean; blank: boolean };
  private loading = false;
  private listeners = new Set<() => void>();

  private onTransaction = ({ transaction }: EditorEvents["transaction"]) => {
    if (transaction.docChanged && !this.loading) this.sync();
  };

  constructor(
    private editor: Editor,
    private io: SessionIO,
  ) {
    this.savedDoc = editor.state.doc;
    this.savedMeta = metaKey(this._meta);
    this.told = this.snapshot();
    editor.on("transaction", this.onTransaction);
  }

  /** Stops watching the editor, for when the editor outlives the session. */
  destroy() {
    this.editor.off("transaction", this.onTransaction);
    this.listeners.clear();
  }

  get path(): string | null {
    return this._path;
  }

  /** The file's name, with its extension. */
  get name(): string {
    return this._path ? this._path.split(/[\\/]/).pop()! : "Untitled";
  }

  get dirty(): boolean {
    return !this.editor.state.doc.eq(this.savedDoc) || metaKey(this._meta) !== this.savedMeta;
  }

  /** The empty document a window starts with: no file, nothing typed. */
  get blank(): boolean {
    return this.snapshot().blank;
  }

  /** Parts of the file this session was opened from that the editor could not keep. */
  get dropped(): DroppedPart[] {
    return this._dropped;
  }

  get meta(): DocMeta {
    return this._meta;
  }

  setMeta(patch: Partial<DocMeta>): void {
    this._meta = { ...this._meta, ...patch };
    this.sync(true);
  }

  /** Runs `fn` whenever the path, the dirty or blank state, the meta, or the opened file changes. Returns the way to stop. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async open(path: string, opts: { discard?: boolean } = {}): Promise<void> {
    if (!isAbsolute(path)) throw new Error("Use an absolute path.");
    if (!formatOf(path)) throw new Error(UNKNOWN_FORMAT);
    if (this.dirty && !opts.discard) throw new Error(UNSAVED);

    const { doc, meta, dropped } = await readDocument(path, await this.io.read(path));
    const node = this.editor.schema.nodeFromJSON(doc);
    node.check();
    // The read took a while, and the person may have typed in the meantime.
    if (this.dirty && !opts.discard) throw new Error(UNSAVED);

    this.load(node);
    this._path = path;
    this._meta = meta;
    this._dropped = dropped;
    this.capture(this.editor.state.doc, meta);
    this.sync(true);
  }

  /**
   * Writes the document to `path`, or to the file it already has. Resolves with the path written.
   * Refuses to replace another file (`overwrite`) or to lose something (`acceptLoss`) unless told.
   */
  async save(path?: string | null, opts: { overwrite?: boolean; acceptLoss?: boolean } = {}): Promise<string> {
    const target = path ?? this._path;
    if (!target) throw new Error("The document has no file yet. Give a path.");
    if (!isAbsolute(target)) throw new Error("Use an absolute path.");
    const format = formatOf(target);
    if (!format) throw new Error(UNKNOWN_FORMAT);

    // What is written is what the document is now, even if the person types while the file is written.
    const doc = this.editor.getJSON();
    const node = this.editor.state.doc;
    const meta = structuredClone(this._meta);

    const sameFile = target === this._path;
    if (!sameFile && !opts.overwrite && (await this.io.exists(target)))
      throw new Error(`${target} already exists. Pass overwrite: true to replace it.`);

    if (!opts.acceptLoss) {
      if (format === "docx" && sameFile && this._dropped.length) {
        const parts = this._dropped.map((part) => part.replace(/_/g, " ")).join(", ");
        throw new LossyWriteError(`Saving will remove parts DocBro can't keep: ${parts}. Save under a new name, or confirm.`);
      }
      if (format === "md") {
        const parts = [meta.comments.length && "comments", meta.header && "headers", meta.footer && "footers"].filter(Boolean);
        if (parts.length) throw new LossyWriteError(`Markdown can't keep ${parts.join(", ")}. Save as .docx, or confirm.`);
      }
    }

    await this.io.write(target, await writeDocument(target, doc, meta));
    this._path = target;
    this._dropped = []; // the file written has none of them
    this.capture(node, meta);
    this.sync(true);
    return target;
  }

  /** Takes the document as it is now for the saved one, when something else wrote it out. */
  markSaved(): void {
    this.capture(this.editor.state.doc, this._meta);
    this.sync(true);
  }

  private capture(doc: ProseMirrorNode, meta: DocMeta) {
    this.savedDoc = doc;
    this.savedMeta = metaKey(meta);
  }

  /** Swaps the editor's content for `node`. The result has nothing to undo and no `update` event. */
  private load(node: ProseMirrorNode) {
    const { editor } = this;
    this.loading = true;
    try {
      // A new state re-creates the plugins' state, which empties the undo history.
      editor.view.updateState(EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins }));
      const { tr } = editor.state;
      tr.replaceWith(0, tr.doc.content.size, node.content)
        .setSelection(Selection.atStart(tr.doc))
        .scrollIntoView()
        .setMeta("addToHistory", false)
        .setMeta("preventUpdate", true);
      editor.view.dispatch(tr);
    } finally {
      this.loading = false;
    }
  }

  private snapshot() {
    const dirty = this.dirty;
    return { path: this._path, dirty, blank: this._path === null && !dirty && this.editor.isEmpty };
  }

  // Tells the shell when what it tracks changed, and the listeners when anything did (`force`).
  private sync(force = false) {
    const now = this.snapshot();
    const changed = now.path !== this.told.path || now.dirty !== this.told.dirty || now.blank !== this.told.blank;
    if (changed) {
      this.told = now;
      this.io.meta(now);
    }
    if (changed || force) for (const fn of [...this.listeners]) fn();
  }
}
