import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHeadlessEditor } from "../editor/headless";
import { exportDocx } from "../formats/docx/export";
import { fixtureDoc } from "../formats/docx/fixture";
import { importDocx } from "../formats/docx/import";
import { BODY_WITH_INS_DEL_AND_TEXTBOX, buildDocx, normalize, plainText } from "../formats/docx/testing";
import { emptyMeta } from "./meta";
import { DocSession, LossyWriteError, type SessionIO } from "./session";

class MemoryIO implements SessionIO {
  files = new Map<string, Uint8Array>();
  metas: { path: string | null; dirty: boolean; blank: boolean }[] = [];
  writes: { path: string; bytes: Uint8Array }[] = []; // in the order the writes began
  // Each read or write takes the next promise from its list (if any) and waits for it,
  // so a test can make the first call slow and the later ones fast.
  readHolds: Promise<void>[] = [];
  writeHolds: Promise<void>[] = [];

  async read(path: string) {
    await this.readHolds.shift();
    const bytes = this.files.get(path);
    if (!bytes) throw new Error("Not found");
    return bytes;
  }
  async write(path: string, bytes: Uint8Array) {
    this.writes.push({ path, bytes });
    await this.writeHolds.shift();
    this.files.set(path, bytes);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  meta(m: { path: string | null; dirty: boolean; blank: boolean }) {
    this.metas.push(m);
  }
}

/** A promise that stays pending until `release` is called. */
function latch() {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  return { hold, release };
}

const BODY = "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>";
// Text with comment c1 on it: a comment is part of the document only while its mark is.
const COMMENTED = { type: "text", text: "Hello", marks: [{ type: "comment", attrs: { id: "c1" } }] };
const text = (editor: Editor) => plainText(editor.getJSON());

let editor: Editor;
let io: MemoryIO;
let s: DocSession;

beforeEach(() => {
  // A headless editor has no plugins, so no undo history, until it is mounted.
  editor = createHeadlessEditor();
  editor.mount(document.createElement("div"));
  io = new MemoryIO();
  s = new DocSession(editor, io);
});

afterEach(() => {
  s.destroy();
  editor.destroy();
});

test("open_then_save_round_trips_and_clears_dirty", async () => {
  io.files.set("/d/a.docx", await exportDocx(fixtureDoc()));
  await s.open("/d/a.docx");
  expect(s.path).toBe("/d/a.docx");
  expect(s.name).toBe("a.docx");
  expect(s.dirty).toBe(false);
  expect(s.dropped).toEqual([]);
  expect(normalize(editor.getJSON())).toEqual(normalize(fixtureDoc()));

  editor.commands.insertContent("Tambahan ");
  expect(s.dirty).toBe(true);

  expect(await s.save()).toBe("/d/a.docx");
  expect(s.dirty).toBe(false);
  const saved = await importDocx(io.files.get("/d/a.docx")!);
  expect(plainText(saved.doc)).toContain("Tambahan Judul Dokumen");
  expect(normalize(saved.doc)).toEqual(normalize(editor.getJSON()));
});

test("refuses_to_discard_unsaved_changes_unless_asked", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  io.files.set("/d/b.docx", await buildDocx({ document: "<w:p><w:r><w:t>Other</w:t></w:r></w:p>" }));
  await s.open("/d/a.docx");
  editor.commands.insertContent("edited ");
  expect(s.dirty).toBe(true);

  await expect(s.open("/d/b.docx")).rejects.toThrow(
    "The document has unsaved changes. Save it first, or pass discard: true.",
  );
  expect(s.path).toBe("/d/a.docx");
  expect(text(editor)).toBe("edited Hello");

  await s.open("/d/b.docx", { discard: true });
  expect(s.path).toBe("/d/b.docx");
  expect(text(editor)).toBe("Other");
  expect(s.dirty).toBe(false);
});

test("save_as_refuses_to_overwrite_another_file_unless_asked", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  io.files.set("/d/other.docx", new Uint8Array([1, 2, 3]));
  await s.open("/d/a.docx");

  await expect(s.save("/d/other.docx")).rejects.toThrow(
    "/d/other.docx already exists. Pass overwrite: true to replace it.",
  );
  expect(Array.from(io.files.get("/d/other.docx")!)).toEqual([1, 2, 3]);
  expect(s.path).toBe("/d/a.docx");

  expect(await s.save("/d/other.docx", { overwrite: true })).toBe("/d/other.docx");
  expect(s.path).toBe("/d/other.docx");
  expect(plainText((await importDocx(io.files.get("/d/other.docx")!)).doc)).toBe("Hello");

  // The file the document is already saved to is not "another file".
  await s.save("/d/other.docx");
  await s.save();
});

test("first_save_over_a_lossy_import_needs_confirmation", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY, header: "first-page-only" }));
  await s.open("/d/a.docx");
  expect(s.dropped).toEqual(["headers"]);
  const original = io.files.get("/d/a.docx")!;

  const refusal = s.save();
  await expect(refusal).rejects.toThrow("Saving will remove parts DocBro can't keep: headers");
  await expect(refusal).rejects.toThrow(
    "Saving will remove parts DocBro can't keep: headers. Save under a new name, or confirm.",
  );
  await expect(refusal).rejects.toBeInstanceOf(LossyWriteError);
  expect(io.files.get("/d/a.docx")).toBe(original);

  await s.save(null, { acceptLoss: true });
  expect(s.dropped).toEqual([]); // the file no longer has them
  await s.save(); // so a later save needs no confirmation
});

test("saving_under_a_new_name_keeps_the_original_and_needs_no_confirmation", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY, header: true }));
  await s.open("/d/a.docx");
  const original = io.files.get("/d/a.docx")!;

  await s.save("/d/copy.docx");
  expect(io.files.get("/d/a.docx")).toBe(original);
  expect(s.path).toBe("/d/copy.docx");
  expect(s.dropped).toEqual([]);
});

test("the_lossy_message_lists_every_dropped_part_in_plain_words", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY_WITH_INS_DEL_AND_TEXTBOX, header: "first-page-only", comments: true }));
  await s.open("/d/a.docx");
  // the comment is not anchored anywhere in the text, so Word does not show it either: nothing to keep
  expect(s.dropped).toEqual(["headers", "tracked_changes", "other_content"]);
  await expect(s.save()).rejects.toThrow(
    "Saving will remove parts DocBro can't keep: headers, tracked changes, other content. Save under a new name, or confirm.",
  );
});

test("saving_markdown_with_a_footer_needs_confirmation", async () => {
  s.setMeta({ footer: "Draft" });
  await expect(s.save("/d/a.md")).rejects.toThrow("Markdown can't keep footers. Save as .docx, or confirm.");
  expect(io.files.has("/d/a.md")).toBe(false);

  await s.save("/d/a.md", { acceptLoss: true });
  expect(io.files.has("/d/a.md")).toBe(true);
});

test("saving_markdown_names_comments_headers_and_footers_in_that_order", async () => {
  editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [COMMENTED] }] });
  s.setMeta({
    footer: "Draft",
    header: "Top",
    comments: [{ id: "c1", author: "Rina", date: "2026-10-01T09:00:00Z", text: "Cek" }],
  });
  await expect(s.save("/d/a.md")).rejects.toThrow(
    "Markdown can't keep comments, headers, footers. Save as .docx, or confirm.",
  );
  s.setMeta({ comments: [], header: null, footer: null, pageNumbers: true });
  await s.save("/d/a.md"); // page numbers alone do not block it
});

test("save_as_md_writes_markdown_and_switches_path", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  await s.open("/d/a.docx");
  editor.commands.insertContent("Halo ");

  expect(await s.save("/d/b.md")).toBe("/d/b.md");
  expect(s.path).toBe("/d/b.md");
  expect(s.name).toBe("b.md");
  expect(s.dirty).toBe(false);
  expect(new TextDecoder().decode(io.files.get("/d/b.md")!).trim()).toBe("Halo Hello");
  expect(plainText((await importDocx(io.files.get("/d/a.docx")!)).doc)).toBe("Hello");
});

test("undo_back_to_the_saved_point_is_clean_again", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  await s.open("/d/a.docx");

  // two edits far enough apart to be two undo steps
  editor.commands.insertContentAt(1, "a");
  editor.commands.insertContentAt(editor.state.doc.content.size - 1, "b");
  expect(s.dirty).toBe(true);
  editor.commands.undo();
  expect(s.dirty).toBe(true);
  editor.commands.undo();
  expect(s.dirty).toBe(false);
  editor.commands.redo();
  expect(s.dirty).toBe(true);

  await s.save();
  expect(s.dirty).toBe(false);
  editor.commands.undo(); // past the saved point
  expect(s.dirty).toBe(true);
  editor.commands.redo();
  expect(s.dirty).toBe(false);
});

test("undo_does_not_make_a_changed_meta_clean", async () => {
  editor.commands.insertContent("a");
  s.setMeta({ header: "Top" });
  editor.commands.undo();
  expect(s.dirty).toBe(true);
  s.setMeta({ header: null });
  expect(s.dirty).toBe(false);
});

test("set_meta_marks_dirty_and_matching_the_saved_meta_is_clean_again", async () => {
  expect(s.meta).toEqual(emptyMeta());
  s.setMeta({ pageNumbers: true });
  expect(s.dirty).toBe(true);
  expect(s.meta.pageNumbers).toBe(true);

  await s.save("/d/a.docx");
  expect(s.dirty).toBe(false);
  s.setMeta({ pageNumbers: false });
  expect(s.dirty).toBe(true);
  s.setMeta({ pageNumbers: true });
  expect(s.dirty).toBe(false);
});

test("a_comment_card_opening_for_edit_is_not_an_edit_of_the_document", async () => {
  editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [COMMENTED] }] });
  const comment = { id: "c1", author: "Rina", date: "2026-10-01T09:00:00Z", text: "Cek" };
  s.setMeta({ comments: [comment] });
  s.markSaved();
  s.setMeta({ comments: [{ ...comment, editing: true }] });
  expect(s.dirty).toBe(false);
  s.setMeta({ comments: [{ ...comment, text: "Cek lagi", editing: true }] });
  expect(s.dirty).toBe(true);
});

test("open_leaves_nothing_to_undo", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  editor.commands.insertContent("scratch");
  expect(editor.can().undo()).toBe(true);

  await s.open("/d/a.docx", { discard: true });
  expect(editor.can().undo()).toBe(false);
  editor.commands.undo();
  expect(text(editor)).toBe("Hello");
  expect(s.dirty).toBe(false);
});

test("open_does_not_emit_an_update_event", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  let updates = 0;
  editor.on("update", () => updates++);
  await s.open("/d/a.docx");
  expect(updates).toBe(0);
  editor.commands.insertContent("x");
  expect(updates).toBe(1);
});

test("opening_markdown_reads_it_with_empty_meta", async () => {
  io.files.set("/d/a.md", new TextEncoder().encode("# Judul\n\nIsi **tebal**.\n"));
  io.files.set("/d/empty.md", new Uint8Array());
  await s.open("/d/a.md");
  expect(text(editor)).toBe("Judul\nIsi tebal.");
  expect(s.meta).toEqual(emptyMeta());
  expect(s.dropped).toEqual([]);
  expect(s.dirty).toBe(false);

  await s.open("/d/empty.md");
  expect(text(editor)).toBe("");
});

test("a_failed_open_leaves_the_current_document_alone", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  io.files.set("/d/bad.docx", new Uint8Array([1, 2, 3]));
  await s.open("/d/a.docx");
  editor.commands.insertContent("kept ");

  await expect(s.open("/d/missing.docx", { discard: true })).rejects.toThrow("Not found");
  await expect(s.open("/d/bad.docx", { discard: true })).rejects.toThrow();
  expect(s.path).toBe("/d/a.docx");
  expect(text(editor)).toBe("kept Hello");
  expect(s.dirty).toBe(true);
});

test("refuses_a_path_it_cannot_use", async () => {
  await expect(s.save()).rejects.toThrow("The document has no file yet. Give a path.");
  await expect(s.save("docs/a.docx")).rejects.toThrow("Use an absolute path.");
  await expect(s.open("a.docx")).rejects.toThrow("Use an absolute path.");
  await expect(s.save("/d/a.txt")).rejects.toThrow("DocBro opens .docx and .md files.");
  await expect(s.open("/d/a.txt")).rejects.toThrow("DocBro opens .docx and .md files.");
  await expect(s.save("C:\\Docs\\a.DOCX")).resolves.toBe("C:\\Docs\\a.DOCX");
  await expect(s.save("/d/a.MARKDOWN")).resolves.toBe("/d/a.MARKDOWN");
  expect(s.name).toBe("a.MARKDOWN");
});

test("a_bad_extension_is_reported_before_unsaved_changes", async () => {
  editor.commands.insertContent("x");
  await expect(s.open("/d/a.txt")).rejects.toThrow("DocBro opens .docx and .md files.");
});

test("edits_made_while_a_save_is_writing_stay_unsaved", async () => {
  editor.commands.insertContent("one ");
  const { hold, release } = latch();
  io.writeHolds = [hold];
  const saving = s.save("/d/a.docx");
  await vi.waitFor(() => expect(io.writes).toHaveLength(1));
  editor.commands.insertContent("two ");
  release();
  await saving;
  expect(s.dirty).toBe(true);
  expect(plainText((await importDocx(io.files.get("/d/a.docx")!)).doc)).toBe("one ");
});

test("a_failed_write_keeps_the_document_dirty_and_the_path", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  await s.open("/d/a.docx");
  editor.commands.insertContent("x");
  io.write = async () => {
    throw new Error("Cannot write /d/b.docx");
  };
  await expect(s.save("/d/b.docx")).rejects.toThrow("Cannot write /d/b.docx");
  expect(s.path).toBe("/d/a.docx");
  expect(s.dirty).toBe(true);
});

test("tells_the_shell_what_the_window_shows", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  expect(s.blank).toBe(true);
  editor.commands.insertContent("x");
  expect(s.blank).toBe(false);
  editor.commands.undo();
  expect(s.blank).toBe(true);
  editor.commands.insertContent("x");
  editor.commands.insertContent("y");
  expect(io.metas).toEqual([
    { path: null, dirty: true, blank: false },
    { path: null, dirty: false, blank: true },
    { path: null, dirty: true, blank: false },
  ]); // typing more changes nothing the shell cares about

  io.metas.length = 0;
  await s.open("/d/a.docx", { discard: true });
  expect(io.metas).toEqual([{ path: "/d/a.docx", dirty: false, blank: false }]);

  io.metas.length = 0;
  editor.commands.insertContent("z");
  await s.save();
  expect(io.metas).toEqual([
    { path: "/d/a.docx", dirty: true, blank: false },
    { path: "/d/a.docx", dirty: false, blank: false },
  ]);
});

test("on_change_runs_for_every_change_of_state_until_unsubscribed", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  let calls = 0;
  const off = s.onChange(() => calls++);

  await s.open("/d/a.docx");
  expect(calls).toBe(1);
  editor.commands.insertContent("x");
  expect(calls).toBe(2);
  editor.commands.insertContent("y"); // still dirty: nothing to report
  expect(calls).toBe(2);
  s.setMeta({ footer: "Draft" });
  expect(calls).toBe(3);
  await s.save();
  expect(calls).toBe(4);
  s.markSaved();
  expect(calls).toBe(5);

  off();
  editor.commands.insertContent("z");
  expect(calls).toBe(5);
});

test("mark_saved_takes_the_current_document_as_the_saved_one", async () => {
  editor.commands.insertContent("x");
  expect(s.dirty).toBe(true);
  s.markSaved();
  expect(s.dirty).toBe(false);
  editor.commands.undo();
  expect(s.dirty).toBe(true);
});

test("works_on_an_editor_that_is_not_mounted", async () => {
  const bare = createHeadlessEditor();
  const bareSession = new DocSession(bare, io);
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  await bareSession.open("/d/a.docx");
  expect(plainText(bare.getJSON())).toBe("Hello");
  expect(bareSession.dirty).toBe(false);
  bare.commands.insertContent("x");
  expect(bareSession.dirty).toBe(true);
  await bareSession.save();
  expect(bareSession.dirty).toBe(false);
  bareSession.destroy();
  bare.destroy();
});

// ---------------------------------------------------------------------------
// open and save run one at a time, in the order they were asked for

test("a_save_in_flight_finishes_before_a_later_open_starts", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  io.files.set("/d/b.docx", await buildDocx({ document: "<w:p><w:r><w:t>Other</w:t></w:r></w:p>", header: "first-page-only" }));
  await s.open("/d/a.docx");

  const { hold, release } = latch();
  io.writeHolds = [hold];
  const saving = s.save("/d/copy.docx"); // Save As of an unedited document
  const opening = s.open("/d/b.docx");
  await vi.waitFor(() => expect(io.writes).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(text(editor)).toBe("Hello"); // the open has not started: the save is still writing
  expect(s.path).toBe("/d/a.docx");

  release();
  await Promise.all([saving, opening]);

  expect(io.writes.map((w) => w.path)).toEqual(["/d/copy.docx"]);
  expect(plainText((await importDocx(io.files.get("/d/copy.docx")!)).doc)).toBe("Hello");
  // everything the window reports describes the file that was opened last
  expect(s.path).toBe("/d/b.docx");
  expect(s.dropped).toEqual(["headers"]);
  expect(text(editor)).toBe("Other");
  expect(s.dirty).toBe(false);
  expect(io.metas.at(-1)).toEqual({ path: "/d/b.docx", dirty: false, blank: false });
});

test("an_open_asked_for_during_a_save_sees_the_document_the_save_made_clean", async () => {
  io.files.set("/d/b.docx", await buildDocx({ document: "<w:p><w:r><w:t>Other</w:t></w:r></w:p>" }));
  editor.commands.insertContent("draft");
  const { hold, release } = latch();
  io.writeHolds = [hold];
  const saving = s.save("/d/a.docx");
  const opening = s.open("/d/b.docx"); // no discard: fine once the save has finished
  await vi.waitFor(() => expect(io.writes).toHaveLength(1));
  release();
  await Promise.all([saving, opening]);
  expect(s.path).toBe("/d/b.docx");
  expect(text(editor)).toBe("Other");
  expect(plainText((await importDocx(io.files.get("/d/a.docx")!)).doc)).toBe("draft");
});

test("overlapping_saves_run_in_order_and_the_last_snapshot_wins", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  await s.open("/d/a.docx");

  const { hold, release } = latch();
  io.writeHolds = [hold]; // only the first write is slow
  editor.commands.insertContent("one ");
  const first = s.save();
  await vi.waitFor(() => expect(io.writes).toHaveLength(1));
  editor.commands.insertContent("two ");
  const second = s.save();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(io.writes).toHaveLength(1); // the second save waits for the first

  release();
  await Promise.all([first, second]);

  const texts = await Promise.all(io.writes.map(async (w) => plainText((await importDocx(w.bytes)).doc)));
  expect(texts).toEqual(["one Hello", "one two Hello"]);
  expect(plainText((await importDocx(io.files.get("/d/a.docx")!)).doc)).toBe("one two Hello");
  expect(text(editor)).toBe("one two Hello");
  expect(s.dirty).toBe(false);
});

test("a_rejected_operation_does_not_block_the_next_one", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: BODY }));
  const results = await Promise.allSettled([
    s.open("/d/missing.docx"),
    s.open("a.docx"),
    s.save(),
    s.open("/d/a.docx"),
    s.save("/d/b.md"),
  ]);
  expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected", "fulfilled", "fulfilled"]);
  expect((results[0] as PromiseRejectedResult).reason.message).toBe("Not found");
  expect((results[1] as PromiseRejectedResult).reason.message).toBe("Use an absolute path.");
  expect((results[2] as PromiseRejectedResult).reason.message).toBe("The document has no file yet. Give a path.");
  expect(s.path).toBe("/d/b.md");

  // a write that fails does not block the next save either
  const failing = io.write.bind(io);
  io.write = async () => {
    io.write = failing;
    throw new Error("Cannot write /d/c.docx");
  };
  const [lost, kept] = await Promise.allSettled([s.save("/d/c.docx"), s.save("/d/d.docx")]);
  expect(lost.status).toBe("rejected");
  expect(kept.status).toBe("fulfilled");
  expect(s.path).toBe("/d/d.docx");
});

test("open_while_open_in_flight_loads_the_second_file_last", async () => {
  io.files.set("/d/a.docx", await buildDocx({ document: "<w:p><w:r><w:t>First</w:t></w:r></w:p>", header: true }));
  io.files.set("/d/b.docx", await buildDocx({ document: "<w:p><w:r><w:t>Second</w:t></w:r></w:p>" }));
  const { hold, release } = latch();
  io.readHolds = [hold]; // only the first read is slow

  const first = s.open("/d/a.docx");
  const second = s.open("/d/b.docx"); // no discard: the first open leaves the document clean
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(s.path).toBeNull(); // the second open waits for the first to finish reading
  release();
  await Promise.all([first, second]);

  expect(s.path).toBe("/d/b.docx");
  expect(s.dropped).toEqual([]);
  expect(text(editor)).toBe("Second");
  expect(s.dirty).toBe(false);
});

test("saving_markdown_names_a_kept_header_and_footer_as_it_does_a_text_one", async () => {
  const kept = { xml: "<w:hdr/>", rels: null, media: {}, view: null };
  s.setMeta({ headerPart: kept });
  await expect(s.save("/d/a.md")).rejects.toThrow("Markdown can't keep headers. Save as .docx, or confirm.");
  s.setMeta({ footerPart: kept });
  await expect(s.save("/d/a.md")).rejects.toThrow("Markdown can't keep headers, footers. Save as .docx, or confirm.");
});

test("a_kept_header_is_not_reported_as_lost_and_is_written_back_on_save", async () => {
  const kept = { xml: '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/><w:p/></w:hdr>', rels: null, media: {}, view: null };
  s.setMeta({ headerPart: kept });
  await s.save("/d/a.docx");
  const { meta, dropped } = await importDocx(io.files.get("/d/a.docx")!);
  expect(meta.headerPart!.xml).toBe(kept.xml);
  expect(dropped).toEqual([]);
});
