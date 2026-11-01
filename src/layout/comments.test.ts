import type { Editor, JSONContent } from "@tiptap/core";
import type { Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, test } from "vitest";
import { emptyMeta, type CommentData } from "../doc/meta";
import { DocSession, type SessionIO } from "../doc/session";
import { liveComments } from "../editor/comment";
import { createHeadlessEditor } from "../editor/headless";
import { exportDocx } from "../formats/docx/export";
import { importDocx } from "../formats/docx/import";
import { buildDocx, findMark, plainText } from "../formats/docx/testing";
import { docToMarkdown } from "../formats/markdown";
import { runTool } from "../mcp/tools";
import { addComment, layoutCards, relativeTime, resolveComment } from "./comments";

class MemoryIO implements SessionIO {
  files = new Map<string, Uint8Array>();
  async read(path: string) {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error("Not found");
    return bytes;
  }
  async write(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  meta() {}
}

let editor: Editor;
let io: MemoryIO;
let session: DocSession;

beforeEach(() => {
  editor = createHeadlessEditor();
  editor.mount(document.createElement("div"));
  io = new MemoryIO();
  session = new DocSession(editor, io);
});

afterEach(() => {
  session.destroy();
  editor.destroy();
});

const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const t = (text: string, ...ids: string[]): JSONContent =>
  ids.length ? { type: "text", text, marks: ids.map((id) => ({ type: "comment", attrs: { id } })) } : { type: "text", text };
const docWithCommentMark = (id: string): JSONContent => ({
  type: "doc",
  content: [p(t("Keyword "), t("cluster volume", id), t(" matters.")), p(t("Next paragraph."))],
});
const c1: CommentData = { id: "c1", author: "Rina", date: "2026-10-01T09:00:00.000Z", text: "Add the combined volume." };

/** Puts `doc` in the editor as content the undo history does not hold, as if a file had just been opened. */
function set(doc: JSONContent) {
  const node = editor.schema.nodeFromJSON(doc);
  const { tr } = editor.state;
  editor.view.dispatch(tr.replaceWith(0, tr.doc.content.size, node.content).setMeta("addToHistory", false));
}
const select = (from: number, to: number) =>
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
const shown = () => liveComments(session.meta.comments, editor.state.doc).map((c) => c.id);

// ------------------------------------------------------------------ the brief's tests

test("cards_stack_below_each_other_but_follow_their_anchor_when_there_is_room", () => {
  expect(layoutCards([{ id: "a", top: 100, editing: false }, { id: "b", top: 140, editing: false }]))
    .toEqual({ a: 90, b: 220 }); // 90 + 118 + 12
  expect(layoutCards([{ id: "a", top: 100, editing: true }, { id: "b", top: 900, editing: false }]))
    .toEqual({ a: 90, b: 890 });
  // an editing card is 170 tall; a measured height wins over the estimate
  expect(layoutCards([{ id: "a", top: 100, editing: true }, { id: "b", top: 110, editing: false }])).toEqual({ a: 90, b: 272 });
  expect(layoutCards([{ id: "a", top: 100, editing: false, height: 200 }, { id: "b", top: 110, editing: false }])).toEqual({ a: 90, b: 302 });
});

test("adding_a_comment_needs_a_selection_and_resolving_is_one_undo_step", () => {
  set({ type: "doc", content: [p(t("Hello world"))] });
  select(3, 3);
  expect(addComment(editor, session, "Gilang")).toBeNull();
  expect(session.meta.comments).toEqual([]);

  select(1, 6); // "Hello"
  const id = addComment(editor, session, "Gilang")!;
  expect(id).toMatch(/^c\d+$/);
  expect(session.meta.comments).toEqual([{ id, author: "Gilang", date: expect.any(String), text: "", editing: true }]);
  expect(findMark(editor.getJSON(), "comment")!.attrs!.id).toBe(id);
  expect(shown()).toEqual([id]);

  session.setMeta({ comments: session.meta.comments.map((c) => ({ ...c, text: "Say hi", editing: false })) });
  resolveComment(editor, session, id);
  expect(findMark(editor.getJSON(), "comment")).toBeUndefined();
  expect(shown()).toEqual([]);
  expect(plainText(editor.getJSON())).toBe("Hello world");

  // one undo brings the mark back, and with it the card and its text
  editor.commands.undo();
  expect(findMark(editor.getJSON(), "comment")!.attrs!.id).toBe(id);
  expect(liveComments(session.meta.comments, editor.state.doc)).toEqual([expect.objectContaining({ id, text: "Say hi" })]);
  // and one more takes the comment away again
  editor.commands.undo();
  expect(shown()).toEqual([]);
});

test("comments_round_trip_through_docx_with_author_date_and_range", async () => {
  const meta = { ...emptyMeta(), comments: [c1] };
  const back = await importDocx(await exportDocx(docWithCommentMark("c1"), meta));
  expect(back.meta.comments).toEqual([expect.objectContaining({ author: "Rina", text: "Add the combined volume." })]);
  expect(back.meta.comments[0].date).toBe(c1.date);
  expect(findMark(back.doc, "comment")!.attrs!.id).toBe(back.meta.comments[0].id);
  expect(back.dropped).not.toContain("comments");
  // the range is the marked text, no more
  const marked = back.doc.content![0].content!.filter((n) => n.marks?.some((m) => m.type === "comment"));
  expect(marked.map((n) => n.text)).toEqual(["cluster volume"]);
});

test("a_word_comment_thread_is_flattened_into_separate_comments", async () => {
  const comment = (id: number, author: string, text: string, paraId: string) =>
    `<w:comment w:id="${id}" w:author="${author}" w:date="2026-10-0${id + 1}T09:00:00Z" w:initials="${author[0]}">` +
    `<w:p w14:paraId="${paraId}"><w:r><w:annotationRef/></w:r><w:r><w:t>${text}</w:t></w:r></w:p></w:comment>`;
  const bytes = await buildDocx({
    document:
      '<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/>' +
      "<w:r><w:t>the range</w:t></w:r><w:commentRangeEnd w:id=\"0\"/><w:r><w:commentReference w:id=\"0\"/></w:r>" +
      '<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>' +
      // a reply Word wrote with no range of its own goes over its parent's
      '<w:r><w:commentReference w:id="2"/></w:r><w:r><w:t xml:space="preserve"> after.</w:t></w:r></w:p>',
    comments: comment(0, "Rina", "Should we list it?", "0A000001") + comment(1, "Budi", "Agree.", "0A000002") +
      comment(2, "Sari", "Done.", "0A000003"),
    commentsExtended:
      '<w15:commentEx w15:paraId="0A000001" w15:done="0"/><w15:commentEx w15:paraId="0A000002" w15:paraIdParent="0A000001" w15:done="0"/>' +
      '<w15:commentEx w15:paraId="0A000003" w15:paraIdParent="0A000001" w15:done="0"/>',
  });
  const { doc, meta, dropped } = await importDocx(bytes);
  expect(meta.comments.map((c) => [c.author, c.text])).toEqual([["Rina", "Should we list it?"], ["Budi", "Agree."], ["Sari", "Done."]]);
  expect(new Set(meta.comments.map((c) => c.id)).size).toBe(3);
  const marked = doc.content![0].content!.find((n) => n.text === "the range")!;
  expect(marked.marks!.map((m) => m.attrs!.id).sort()).toEqual(meta.comments.map((c) => c.id).sort());
  expect(plainText(doc)).toBe("Before the range after.");
  expect(dropped).not.toContain("comments");
});

test("list_comments_and_add_comment_tools", async () => {
  set({ type: "doc", content: [p(t("Keyword cluster volume matters.")), p(t("Second block here."))] });
  expect(JSON.parse((await runTool({ editor, session }, "list_comments", {})).text)).toEqual([]);

  const added = await runTool({ editor, session }, "add_comment", { block: 1, text: "cluster volume", comment: "Add <b>numbers</b>." });
  expect(added).toMatchObject({ ok: true, text: expect.stringMatching(/^Added comment c\d+\.$/) });
  const whole = await runTool({ editor, session }, "add_comment", { block: 2, comment: "Rewrite this." });
  expect(whole.ok).toBe(true);

  const list = JSON.parse((await runTool({ editor, session }, "list_comments", {})).text);
  expect(list).toEqual([
    { id: expect.any(String), author: "AI", date: expect.any(String), text: "Add <b>numbers</b>.", quote: "cluster volume" },
    { id: expect.any(String), author: "AI", date: expect.any(String), text: "Rewrite this.", quote: "Second block here." },
  ]);
  expect(added.text).toBe(`Added comment ${list[0].id}.`);
  expect(JSON.parse((await runTool({ editor, session }, "document_info", {})).text).comments).toBe(2);

  // each is one undo step, and an undone comment is no longer listed
  editor.commands.undo();
  expect(JSON.parse((await runTool({ editor, session }, "list_comments", {})).text)).toHaveLength(1);

  expect(await runTool({ editor, session }, "add_comment", { block: 1, text: "missing", comment: "x" })).toEqual({
    ok: false, text: '"missing" was not found in block 1.',
  });
  expect((await runTool({ editor, session }, "add_comment", { block: 1, comment: " " })).text).toBe("comment must not be empty.");
  expect((await runTool({ editor, session }, "add_comment", { block: 9, comment: "x" })).ok).toBe(false);
});

test("a_comment_survives_typing_inside_and_at_its_end", () => {
  set({ type: "doc", content: [p(t("Hello world"))] });
  select(1, 6);
  const id = addComment(editor, session, "Gilang")!;
  editor.commands.insertContentAt(3, "XX"); // inside: "HeXXllo"
  editor.chain().setTextSelection(8).insertContent("!").run(); // at its end: not part of it
  const marked = (editor.getJSON() as JSONContent).content![0].content!.filter((n) => n.marks?.some((m) => m.type === "comment"));
  expect(marked.map((n) => n.text)).toEqual(["HeXXllo"]);
  expect(plainText(editor.getJSON())).toBe("HeXXllo! world");
  expect(shown()).toEqual([id]);
});

// ------------------------------------------------------------------ more

test("a_resolved_word_comment_is_reported_as_a_part_docbro_cannot_keep", async () => {
  const bytes = await buildDocx({
    document:
      '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Open</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>' +
      '<w:commentRangeStart w:id="1"/><w:r><w:t>Done</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>',
    comments:
      '<w:comment w:id="0" w:author="Rina"><w:p w14:paraId="0B000001"><w:r><w:t>Still open</w:t></w:r></w:p></w:comment>' +
      '<w:comment w:id="1" w:author="Rina"><w:p w14:paraId="0B000002"><w:r><w:t>Resolved</w:t></w:r></w:p></w:comment>',
    commentsExtended: '<w15:commentEx w15:paraId="0B000001" w15:done="0"/><w15:commentEx w15:paraId="0B000002" w15:done="1"/>',
  });
  const { doc, meta, dropped } = await importDocx(bytes);
  expect(meta.comments.map((c) => c.text)).toEqual(["Still open"]);
  expect(liveComments(meta.comments, editor.schema.nodeFromJSON(doc)).map((c) => c.text)).toEqual(["Still open"]);
  expect(dropped).toEqual(["resolved_comments"]);
});

test("a_comment_range_can_cross_paragraphs_and_its_text_keeps_its_lines", async () => {
  const doc: JSONContent = { type: "doc", content: [p(t("One "), t("two", "c1")), p(t("three", "c1"), t(" four"))] };
  const zipped = await exportDocx(doc, { ...emptyMeta(), comments: [{ ...c1, text: "Line one\nLine two" }] });
  const back = await importDocx(zipped);
  expect(back.meta.comments[0].text).toBe("Line one\nLine two");
  const marked = back.doc.content!.flatMap((block): JSONContent[] => block.content ?? []).filter((n) => n.marks?.length).map((n) => n.text);
  expect(marked).toEqual(["two", "three"]);
});

test("only_comments_with_a_mark_are_written_and_a_mark_without_an_entry_is_not_a_comment", async () => {
  const doc: JSONContent = { type: "doc", content: [p(t("A", "c1"), t(" B", "gone"))] };
  const orphan: CommentData = { id: "unmarked", author: "Budi", date: "2026-10-01T09:00:00Z", text: "Resolved earlier" };
  const back = await importDocx(await exportDocx(doc, { ...emptyMeta(), comments: [c1, orphan] }));
  expect(back.meta.comments.map((c) => c.text)).toEqual(["Add the combined volume."]);
  expect(back.doc.content![0].content!.filter((n) => n.marks?.length).map((n) => n.text)).toEqual(["A"]);
});

test("markdown_leaves_the_comment_marks_out", () => {
  expect(docToMarkdown(docWithCommentMark("c1")).trim()).toBe("Keyword cluster volume matters.\n\nNext paragraph.");
});

test("undo_back_to_the_saved_document_is_clean_and_a_comment_resolved_before_a_save_comes_back_whole", async () => {
  set({ type: "doc", content: [p(t("Hello world"))] });
  await session.save("/d/a.docx");
  select(1, 6);
  addComment(editor, session, "Gilang");
  expect(session.dirty).toBe(true);
  editor.commands.undo(); // the mark is gone: the entry is no content any more
  expect(session.dirty).toBe(false);

  select(7, 12);
  const id = addComment(editor, session, "Gilang")!;
  session.setMeta({ comments: session.meta.comments.map((c) => (c.id === id ? { ...c, text: "Say more", editing: false } : c)) });
  resolveComment(editor, session, id);
  await session.save();
  editor.commands.undo(); // the resolve
  expect(liveComments(session.meta.comments, editor.state.doc)).toEqual([expect.objectContaining({ id, text: "Say more" })]);
  await session.save();
  const back = await importDocx(io.files.get("/d/a.docx")!);
  expect(back.meta.comments.map((c) => c.text)).toEqual(["Say more"]);
});

test("pasting_keeps_a_comment_only_when_its_text_was_cut_or_dragged_away", () => {
  set({ type: "doc", content: [p(t("Keep "), t("this", "c1"), t(" and that."))] });
  session.setMeta({ comments: [c1] });
  const paste = (slice: Slice) => {
    let out = slice;
    editor.view.someProp("transformPasted", (f) => void (out = f(out, editor.view, false)));
    return out;
  };
  const commented = () => editor.state.doc.slice(6, 10); // "this", with c1
  const ids = (slice: Slice) => {
    const found: string[] = [];
    slice.content.descendants((node) => void node.marks.forEach((m) => m.type.name === "comment" && found.push(m.attrs.id)));
    return found;
  };
  // a copy: the comment is still on the original, so the pasted text is a text of its own
  expect(ids(paste(commented()))).toEqual([]);
  // a move by dragging: the original goes once the copy lands
  const slice = commented();
  (editor.view as unknown as { dragging: unknown }).dragging = { slice, move: true };
  expect(ids(paste(slice))).toEqual(["c1"]);
  (editor.view as unknown as { dragging: unknown }).dragging = null;
  // a cut: the comment's text is gone from the document, so it goes where the text goes
  const cut = commented();
  editor.commands.deleteRange({ from: 6, to: 10 });
  expect(ids(paste(cut))).toEqual(["c1"]);
});

test("a_comment_never_posted_is_not_written_to_word", async () => {
  const draft: CommentData = { id: "c2", author: "Gilang", date: c1.date, text: "", editing: true };
  const doc: JSONContent = { type: "doc", content: [p(t("A", "c1"), t(" B", "c2"))] };
  const zip = await JSZip.loadAsync(await exportDocx(doc, { ...emptyMeta(), comments: [c1, draft] }));
  expect((await zip.file("word/comments.xml")!.async("string")).match(/<w:comment /g)).toHaveLength(1);
  expect((await zip.file("word/document.xml")!.async("string")).match(/<w:commentRangeStart /g)).toHaveLength(1);
  const alone = await JSZip.loadAsync(await exportDocx({ type: "doc", content: [p(t("B", "c2"))] }, { ...emptyMeta(), comments: [draft] }));
  expect(alone.file("word/comments.xml")).toBeNull();
});

test("comments_docbro_cannot_show_are_named_for_what_they_are", async () => {
  const bytes = await buildDocx({
    document:
      '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Done</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>' +
      '<w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:commentReference w:id="1"/></w:r></w:p>',
    comments:
      '<w:comment w:id="0" w:author="Rina"><w:p w14:paraId="0C000001"><w:r><w:t>Resolved</w:t></w:r></w:p></w:comment>' +
      '<w:comment w:id="1" w:author="Rina"><w:p w14:paraId="0C000002"><w:r><w:t>On a point</w:t></w:r></w:p></w:comment>',
    commentsExtended: '<w15:commentEx w15:paraId="0C000001" w15:done="1"/>',
  });
  io.files.set("/d/w.docx", bytes);
  await session.open("/d/w.docx");
  expect(session.dropped).toEqual(["resolved_comments", "comments_on_no_text"]);
  await expect(session.save()).rejects.toThrow(
    "Saving will remove parts DocBro can't keep: resolved comments, comments on no text. Save under a new name, or confirm.",
  );
});

test("relative_times_read_like_the_mock", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  expect(relativeTime("2026-10-01T11:59:40Z", now)).toBe("now");
  expect(relativeTime("2026-10-01T11:20:00Z", now)).toBe("40m");
  expect(relativeTime("2026-10-01T10:00:00Z", now)).toBe("2h");
  expect(relativeTime("2026-09-28T12:00:00Z", now)).toBe("3d");
  expect(relativeTime("2026-08-14T12:00:00Z", now)).toBe("Aug 14");
  expect(relativeTime("2025-08-14T12:00:00Z", now)).toBe("Aug 14, 2025");
  expect(relativeTime("", now)).toBe("");
});
