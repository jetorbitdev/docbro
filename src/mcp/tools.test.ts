import type { Editor, JSONContent } from "@tiptap/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DocSession, type SessionIO } from "../doc/session";
import { blockCount, blockRange } from "../editor/blockAddress";
import { createHeadlessEditor } from "../editor/headless";
import { exportDocx } from "../formats/docx/export";
import { fixtureDoc } from "../formats/docx/fixture";
import { BODY_WITH_INS_DEL_AND_TEXTBOX, buildDocx, findMark, plainText } from "../formats/docx/testing";
import { docToMarkdown, markdownToDoc } from "../formats/markdown";
import { MAX_READ_CHARS, runTool, TOOL_DESCRIPTIONS, TOOL_NAMES, type ToolContext } from "./tools";

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
let ctx: ToolContext;

beforeEach(() => {
  // A headless editor has no plugins, so no undo history, until it is mounted.
  editor = createHeadlessEditor();
  editor.mount(document.createElement("div"));
  io = new MemoryIO();
  session = new DocSession(editor, io);
  ctx = { editor, session };
});

afterEach(() => {
  session.destroy();
  editor.destroy();
});

/** Puts `md` (or a doc) in the editor as content the undo history does not hold, as if a file had just been opened. */
function set(md: string | JSONContent) {
  const node = editor.schema.nodeFromJSON(typeof md === "string" ? markdownToDoc(md) : md);
  const { tr } = editor.state;
  editor.view.dispatch(tr.replaceWith(0, tr.doc.content.size, node.content).setMeta("addToHistory", false));
}
const text = () => plainText(editor.getJSON());
const md = () => docToMarkdown(editor.getJSON()).trim();
const call = (name: string, args: Record<string, unknown> = {}) => runTool(ctx, name, args);
async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await call(name, args);
  expect(r, r.text).toMatchObject({ ok: true });
  return r.text;
}
async function err(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await call(name, args);
  expect(r, r.text).toMatchObject({ ok: false });
  return r.text;
}
const top = () => (editor.getJSON().content ?? []) as JSONContent[];
const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i} ${"x".repeat(80)}`);
/**
 * The same document built directly. Every editor made in this process adds its Markdown tokenizers to the one
 * global `marked`, so parsing 5000 paragraphs gets slower with each test that ran before.
 */
// A test on 5000 blocks takes a few seconds alone, and more beside the other test files.
const HUGE_MS = 20_000;
const hugeDoc = (n: number): JSONContent => ({
  type: "doc",
  content: paragraphs(n).map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
});

// ------------------------------------------------------------------ the brief's tests

test("every_tool_name_is_handled", async () => {
  for (const n of TOOL_NAMES) expect((await runTool(ctx, n, {})).text).not.toMatch(/Unknown tool/);
  expect((await runTool(ctx, "nope", {})).ok).toBe(false);
});

test("read_document_numbers_blocks_as_markdown", async () => {
  set("# T\n\nHello **you**");
  expect((await runTool(ctx, "read_document", {})).text).toBe("[1] # T\n\n[2] Hello **you**");
});

test("read_document_pages_long_documents", async () => {
  set(paragraphs(5000).join("\n\n"));
  const r = await runTool(ctx, "read_document", {});
  expect(r.text.length).toBeLessThanOrEqual(MAX_READ_CHARS + 200);
  expect(r.text).toMatch(/Call read_document with from=\d+\.$/);
}, HUGE_MS);

test("each_tool_call_is_one_undo_step_and_never_merges_with_typing", async () => {
  set("Hello");
  editor.commands.insertContentAt(6, " world"); // user typing
  await runTool(ctx, "insert_content", { markdown: "## Added\n\nTwo paras" });
  editor.commands.undo();
  expect(text()).toBe("Hello world"); // AI edit gone, typing kept
  editor.commands.undo();
  expect(text()).toBe("Hello");
});

test("insert_content_with_a_picture_from_the_web_keeps_the_link_but_the_window_never_fetches_it", async () => {
  set("Intro");
  const url = "https://tracker.example/p.png?d=the%20secret";
  await ok("insert_content", { markdown: `![chart](${url})` });
  const dom = editor.view.dom;
  // no <img> and nothing else in the window carries the address as a source
  expect([...dom.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([]);
  expect(dom.querySelectorAll("[src]")).toHaveLength(0);
  expect(dom.querySelector(".remote-image-alt")!.textContent).toBe("chart");
  expect(dom.querySelector(".remote-image-src")!.textContent).toBe(url);
  // the document has it, so the tools and a Markdown save still see the link
  expect((await ok("read_document")).includes(`![chart](${url})`)).toBe(true);
  expect(md()).toContain(`![chart](${url})`);
});

test("insert_replace_delete_address_blocks_and_report_bad_numbers", async () => {
  set("A\n\nB\n\nC");
  expect(await ok("insert_content", { markdown: "X\n\nY", before: 2 })).toBe("Inserted 2 blocks at 2–3.");
  expect(md()).toBe("A\n\nX\n\nY\n\nB\n\nC");
  expect(await ok("insert_content", { markdown: "Z", after: 5 })).toBe("Inserted 1 block at 6–6.");
  expect(await ok("insert_content", { markdown: "End" })).toBe("Inserted 1 block at 7–7.");
  expect(md()).toBe("A\n\nX\n\nY\n\nB\n\nC\n\nZ\n\nEnd");

  expect(await err("insert_content", { markdown: "Q", before: 1, after: 1 })).toBe("Give before or after, not both.");
  expect(await err("insert_content", { markdown: "Q", before: 9 })).toBe("Block 9 does not exist. The document has 7 blocks.");
  expect(await err("replace_blocks", { from: 8, markdown: "Q" })).toBe("Block 8 does not exist. The document has 7 blocks.");
  expect(await err("delete_blocks", { from: 2, to: 8 })).toBe("Block 8 does not exist. The document has 7 blocks.");

  expect(await ok("replace_blocks", { from: 2, to: 3, markdown: "## R" })).toBe("Replaced blocks 2–3 with 1 block.");
  expect(await ok("replace_blocks", { from: 1, markdown: "A1\n\nA2" })).toBe("Replaced blocks 1–1 with 2 blocks.");
  expect(md()).toBe("A1\n\nA2\n\n## R\n\nB\n\nC\n\nZ\n\nEnd");
  expect(await ok("delete_blocks", { from: 1 })).toBe("Deleted blocks 1–1.");
  expect(await ok("delete_blocks", { from: 4, to: 6 })).toBe("Deleted blocks 4–6.");
  expect(md()).toBe("A2\n\n## R\n\nB");
  expect(await err("delete_blocks", { from: 3, to: 2 })).toBe("to must not be before from.");
  // nothing was changed by the refused calls
  expect(md()).toBe("A2\n\n## R\n\nB");
});

test("find_replace_counts_and_respects_block_bounds", async () => {
  set("cat Cat\n\ncat cat\n\ncat");
  expect(await ok("find_replace", { find: "cat", replace: "dog", from: 2, to: 2 })).toBe("Replaced 2 occurrences.");
  expect(text()).toBe("cat Cat\ndog dog\ncat");
  // case sensitive by default
  expect(await ok("find_replace", { find: "Cat", replace: "Cow", to: 1 })).toBe("Replaced 1 occurrence.");
  expect(text()).toBe("cat Cow\ndog dog\ncat");
  expect(await ok("find_replace", { find: "COW", replace: "ox", case_sensitive: false })).toBe("Replaced 1 occurrence.");
  // from alone runs to the end
  expect(await ok("find_replace", { find: "cat", replace: "pig", from: 2 })).toBe("Replaced 1 occurrence.");
  expect(text()).toBe("cat ox\ndog dog\npig");
  // nothing found is an answer, not an error
  expect(await ok("find_replace", { find: "zebra", replace: "x" })).toBe("Replaced 0 occurrences.");
  expect(await err("find_replace", { find: "cat", replace: "x", from: 4 })).toBe("Block 4 does not exist. The document has 3 blocks.");
});

test("format_text_applies_marks_to_occurrences_only", async () => {
  set("one two one\n\none");
  expect(await ok("format_text", { from: 1, text: "one", bold: true })).toBe("Formatted blocks 1–1.");
  expect(md()).toBe("**one** two **one**\n\none");
  expect(await err("format_text", { from: 1, to: 2, text: "three", italic: true })).toBe('"three" was not found in blocks 1–2.');

  await ok("format_text", { from: 1, text: "two", italic: true, underline: true, strike: true });
  const two = top()[0].content!.find((n) => n.text === "two")!;
  expect(two.marks!.map((m) => m.type).sort()).toEqual(["italic", "strike", "underline"]);

  await ok("format_text", { from: 2, color: "#1A2B3C", highlight: "#f3dc6b" });
  const block2 = top()[1];
  expect(findMark(block2, "textStyle")!.attrs).toMatchObject({ color: "#1a2b3c" });
  expect(findMark(block2, "highlight")!.attrs).toMatchObject({ color: "#f3dc6b" });
  await ok("format_text", { from: 2, color: null, highlight: null });
  expect(findMark(top()[1], "textStyle")).toBeUndefined();
  expect(findMark(top()[1], "highlight")).toBeUndefined();

  // bold: false takes bold off
  await ok("format_text", { from: 1, bold: false });
  expect(findMark(top()[0], "bold")).toBeUndefined();
});

test("format_text_links_only_safe_addresses", async () => {
  set("see here\n\nother");
  await ok("format_text", { from: 1, text: "here", link: "example.com/x" });
  expect(findMark(top()[0], "link")!.attrs).toMatchObject({ href: "https://example.com/x" });
  await ok("format_text", { from: 2, link: "mailto:a@b.id" });
  expect(findMark(top()[1], "link")!.attrs).toMatchObject({ href: "mailto:a@b.id" });
  for (const link of ["javascript:alert(1)", "x@y.id", "paypal.com@evil.com", "//evil.com", "", 42, true]) {
    expect(await err("format_text", { from: 1, link })).toBe("link must be an http, https or mailto URL");
  }
  await ok("format_text", { from: 1, to: 2, link: null });
  expect(findMark(editor.getJSON(), "link")).toBeUndefined();
});

test("format_text_refuses_bad_colors_and_empty_requests", async () => {
  set("abc");
  for (const color of ["red", "#abc", "#12345g", "1a2b3c", "#1a2b3c ", 5]) {
    expect(await err("format_text", { from: 1, color })).toBe("color must look like #1a2b3c");
    expect(await err("format_text", { from: 1, highlight: color })).toBe("color must look like #1a2b3c");
  }
  expect(await err("format_text", { from: 1 })).toBe(
    "Give at least one of bold, italic, underline, strike, color, highlight, link, style, align or list.");
  expect(await err("format_text", { from: 1, bold: "yes" })).toBe("bold must be true or false.");
  expect(await err("format_text", { from: 1, style: "title" })).toBe(
    'style must be one of "body", "heading1", "heading2", "heading3", "quote".');
  expect(await err("format_text", { from: 1, align: "middle" })).toBe(
    'align must be one of "left", "center", "right", "justify", or null.');
  expect(await err("format_text", { from: 1, list: "dots" })).toBe('list must be one of "bullet", "numbered", "none".');
  expect(await err("format_text", { from: 1, text: "", bold: true })).toBe("text must not be empty.");
  expect(md()).toBe("abc");
});

test("format_text_sets_style_alignment_and_lists", async () => {
  set("A\n\nB\n\nC\n\n- d\n- e\n\nF");
  expect(await ok("format_text", { from: 1, style: "heading2" })).toBe("Formatted blocks 1–1.");
  expect(md()).toBe("## A\n\nB\n\nC\n\n- d\n- e\n\nF");
  // consecutive paragraphs and the list after them become one list
  await ok("format_text", { from: 2, to: 4, list: "bullet" });
  expect(md()).toBe("## A\n\n- B\n- C\n- d\n- e\n\nF");
  await ok("format_text", { from: 2, list: "numbered" });
  expect(md()).toBe("## A\n\n1. B\n2. C\n3. d\n4. e\n\nF");
  await ok("format_text", { from: 2, list: "none" });
  expect(md()).toBe("## A\n\nB\n\nC\n\nd\n\ne\n\nF");

  // a heading in range goes into a list as a paragraph
  await ok("format_text", { from: 1, to: 2, list: "bullet" });
  expect(md()).toBe("- A\n- B\n\nC\n\nd\n\ne\n\nF");
  // a heading style on a list takes the list apart first, as the editor's own Heading command does
  await ok("format_text", { from: 1, style: "heading3" });
  expect(md()).toBe("### A\n\n### B\n\nC\n\nd\n\ne\n\nF");
  expect(await err("format_text", { from: 1, style: "heading1", list: "bullet" })).toBe(
    "A list item can't be a heading. Give style or list, not both.");

  await ok("format_text", { from: 1, to: 3, style: "quote" });
  expect(md()).toBe("> ### A\n>\n> ### B\n>\n> C\n\nd\n\ne\n\nF");
  // body takes the quote away and makes headings paragraphs
  await ok("format_text", { from: 1, style: "body" });
  expect(md()).toBe("A\n\nB\n\nC\n\nd\n\ne\n\nF");

  await ok("format_text", { from: 2, to: 3, align: "center" });
  expect(top().map((n) => n.attrs?.textAlign ?? null)).toEqual([null, "center", "center", null, null, null]);
  await ok("format_text", { from: 2, align: null });
  expect(top()[1].attrs!.textAlign).toBeNull();
});

test("style_on_a_list_item_changes_the_items_paragraph", async () => {
  set("- one\n\n  ## sub\n- two");
  await ok("format_text", { from: 1, style: "body" });
  expect(md()).toBe("- one\n\n  sub\n- two");
  await ok("format_text", { from: 1, align: "right" });
  const items = top()[0].content!;
  expect(items.map((item) => item.content![0].attrs!.textAlign)).toEqual(["right", "right"]);
});

test("format_text_does_everything_in_one_undo_step", async () => {
  set("alpha beta\n\ngamma");
  const before = md();
  await ok("format_text", { from: 1, to: 2, text: "a", bold: true, list: "numbered", align: "right", color: "#123456" });
  expect(md()).not.toBe(before);
  editor.commands.undo();
  expect(md()).toBe(before);
});

test("open_and_save_pass_session_errors_through_as_tool_errors", async () => {
  editor.commands.insertContent("x");
  const r = await runTool(ctx, "open_document", { path: "/d/b.docx" });
  expect(r).toEqual({ ok: false, text: "The document has unsaved changes. Save it first, or pass discard: true." });
});

// ------------------------------------------------------------------ more

test("every_edit_tool_is_one_undo_step", async () => {
  const calls: [string, Record<string, unknown>][] = [
    ["insert_content", { markdown: "# New\n\n- a\n- b", after: 1 }],
    ["replace_blocks", { from: 1, to: 2, markdown: "Only" }],
    ["delete_blocks", { from: 2 }],
    ["delete_blocks", { from: 1, to: 3 }],
    ["find_replace", { find: "a", replace: "A" }],
    ["format_text", { from: 1, to: 3, bold: true, style: "quote" }],
  ];
  for (const [name, args] of calls) {
    set("alpha\n\nbeta\n\ngamma");
    editor.commands.insertContentAt(1, "typed "); // typing just before the call
    const before = md();
    await ok(name, args);
    expect(md(), name).not.toBe(before);
    editor.commands.undo();
    expect(md(), name).toBe(before);
  }
});

test("typing_right_after_a_tool_call_is_its_own_undo_step", async () => {
  set("Hello");
  await ok("insert_content", { markdown: "Added" });
  editor.commands.insertContentAt(editor.state.doc.content.size - 1, "!"); // typed right after, next to the new text
  expect(text()).toBe("Hello\nAdded!");
  editor.commands.undo();
  expect(text()).toBe("Hello\nAdded");
  editor.commands.undo();
  expect(text()).toBe("Hello");
});

test("undo_and_redo_tools", async () => {
  set("Hello");
  expect(await ok("undo")).toBe("Nothing to undo.");
  expect(await ok("redo")).toBe("Nothing to redo.");
  await ok("insert_content", { markdown: "More" });
  expect(await ok("undo")).toBe("Undid the last change.");
  expect(text()).toBe("Hello");
  expect(await ok("redo")).toBe("Redid the last undone change.");
  expect(text()).toBe("Hello\nMore");
});

test("insert_content_fills_an_empty_document_and_keeps_the_trailing_line_last", async () => {
  expect(await ok("insert_content", { markdown: "# New" })).toBe("Inserted 1 block at 1–1.");
  // the editor keeps an empty line after a last heading
  expect(await ok("read_document")).toBe("[1] # New\n\n[2]");
  expect(await ok("insert_content", { markdown: "Body" })).toBe("Inserted 1 block at 2–2.");
  expect(await ok("read_document")).toBe("[1] # New\n\n[2] Body\n\n[3]");
});

test("markdown_is_conformed_like_the_importer_does", async () => {
  set("A");
  expect(await ok("insert_content", { markdown: "#### deep\n\n```\ncode\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |" })).toBe(
    "Inserted 3 blocks at 2–4.");
  expect(top().map((n) => n.type)).toEqual(["paragraph", "paragraph", "paragraph", "table", "paragraph"]);
  expect(() => editor.state.doc.check()).not.toThrow();
});

test("deleting_every_block_leaves_one_empty_paragraph", async () => {
  set("A\n\nB");
  expect(await ok("delete_blocks", { from: 1, to: 2 })).toBe("Deleted blocks 1–2.");
  expect(top()).toEqual([{ type: "paragraph", attrs: { textAlign: null, spacing: null, firstLine: null } }]);
  expect(blockCount(editor.state.doc)).toBe(1);
});

test("arguments_are_checked", async () => {
  set("A\n\nB\n\nC");
  for (const from of [0, -1, 1.5, "2", true, Number.NaN, Infinity]) {
    expect(await err("read_document", { from })).toBe("from must be a whole number of 1 or more.");
  }
  expect(await err("read_document", { to: 0 })).toBe("to must be a whole number of 1 or more.");
  expect(await err("read_document", { from: 3, to: 2 })).toBe("to must not be before from.");
  expect(await err("read_document", { to: 9 })).toBe("Block 9 does not exist. The document has 3 blocks.");
  expect(await err("insert_content", {})).toBe("markdown is required.");
  expect(await err("insert_content", { markdown: 5 })).toBe("markdown must be a string.");
  expect(await err("insert_content", { markdown: " \n " })).toBe("markdown is empty.");
  expect(await err("insert_content", { markdown: "x", after: -2 })).toBe("after must be a whole number of 1 or more.");
  expect(await err("replace_blocks", { markdown: "x" })).toBe("from is required.");
  expect(await err("replace_blocks", { from: 1 })).toBe("markdown is required.");
  expect(await err("delete_blocks", {})).toBe("from is required.");
  expect(await err("find_replace", { find: "a" })).toBe("replace is required.");
  expect(await err("find_replace", { find: "", replace: "x" })).toBe("find must not be empty.");
  expect(await err("find_replace", { find: "a", replace: "b", case_sensitive: "no" })).toBe("case_sensitive must be true or false.");
  expect(await err("open_document", {})).toBe("path is required.");
  expect(await err("open_document", { path: "/d/a.md", discard: 1 })).toBe("discard must be true or false.");
  expect(await err("save_document", { path: 3 })).toBe("path must be a string.");
  expect(await err("insert_content", { markdown: "x", position: 2 })).toBe(
    "Unknown argument position. insert_content takes markdown, before, after.");
  expect(await err("document_info", { verbose: true })).toBe("Unknown argument verbose. document_info takes no arguments.");
  // null stands for a missing optional argument
  expect(await ok("read_document", { from: null, to: null })).toBe("[1] A\n\n[2] B\n\n[3] C");
  expect(await ok("read_document", { from: 2, to: 3 })).toBe("[2] B\n\n[3] C");
  expect(await err("read_document", [] as unknown as Record<string, unknown>)).toBe("Arguments must be an object.");
  expect(await ok("read_document", null as unknown as Record<string, unknown>)).toBe("[1] A\n\n[2] B\n\n[3] C");
  expect(await call("nope")).toEqual({ ok: false, text: "Unknown tool: nope" });
  expect(await call("toString")).toEqual({ ok: false, text: "Unknown tool: toString" });
  expect(md()).toBe("A\n\nB\n\nC");
});

test("read_document_cuts_a_block_longer_than_the_limit_and_moves_on", async () => {
  set(`${"y".repeat(MAX_READ_CHARS + 5000)}\n\nshort`);
  const first = await ok("read_document");
  expect(first.length).toBeLessThanOrEqual(MAX_READ_CHARS + 200);
  expect(first.startsWith("[1] yyy")).toBe(true);
  expect(first).toMatch(/… block 1 is cut here: it has 65000 characters of Markdown\.\n\n… 1 more block\. Call read_document with from=2\.$/);
  expect(await ok("read_document", { from: 2 })).toBe("[2] short");
  // the last block, cut, needs no hint
  const last = await ok("read_document", { from: 1, to: 1 });
  expect(last).toMatch(/cut here: it has \d+ characters of Markdown\.$/);
});

test("reading_a_huge_document_page_by_page_sees_every_block_once", async () => {
  set(hugeDoc(5000));
  const seen: string[] = [];
  const sizes: number[] = [];
  let from = 1;
  for (let pages = 0; pages < 100; pages++) {
    const page = await ok("read_document", { from });
    sizes.push(page.length);
    // each block's number, and the number its text carries (one less)
    for (const m of page.matchAll(/^\[(\d+)\] Paragraph (\d+) /gm)) seen.push(`${m[1]}:${m[2]}`);
    const next = /from=(\d+)\.$/.exec(page);
    if (!next) break;
    from = Number(next[1]);
  }
  expect(seen).toEqual(Array.from({ length: 5000 }, (_, i) => `${i + 1}:${i}`));
  expect(sizes.length).toBeGreaterThan(5);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_READ_CHARS + 200);
}, HUGE_MS);

test("a_huge_find_replace_is_one_undo_step", async () => {
  set(hugeDoc(5000));
  expect(await ok("find_replace", { find: "Paragraph", replace: "Para" })).toBe("Replaced 5000 occurrences.");
  expect(top()[4999].content![0].text).toMatch(/^Para 4999 /);
  editor.commands.undo();
  expect(top()[4999].content![0].text).toMatch(/^Paragraph 4999 /);
  const info = JSON.parse(await ok("document_info"));
  expect(info).toMatchObject({ blocks: 5000, words: 15000 });
}, HUGE_MS);

test("document_info_describes_the_document", async () => {
  set("# Title\n\nSome words here\n\n> ## Quoted\n\n- item\n\n## Sub");
  expect(JSON.parse(await ok("document_info"))).toEqual({
    name: "Untitled",
    path: null,
    dirty: true,
    format: null,
    blocks: 6, // the editor keeps an empty line after a last heading
    words: 7,
    characters: 33,
    header: null,
    footer: null,
    page_numbers: false,
    comments: 0,
    dropped: [],
    outline: [
      { block: 1, level: 1, text: "Title" },
      { block: 3, level: 2, text: "Quoted" },
      { block: 5, level: 2, text: "Sub" },
    ],
  });

  io.files.set("/d/lossy.docx", await buildDocx({ document: BODY_WITH_INS_DEL_AND_TEXTBOX, header: "first-page-only" }));
  await ok("open_document", { path: "/d/lossy.docx", discard: true });
  expect(JSON.parse(await ok("document_info"))).toMatchObject({
    name: "lossy.docx",
    path: "/d/lossy.docx",
    dirty: false,
    format: "docx",
    dropped: ["headers", "tracked_changes", "other_content"],
    outline: [],
  });
});

test("open_document_reports_blocks_and_parts_it_could_not_keep", async () => {
  io.files.set("/d/a.md", new TextEncoder().encode("# A\n\nbody"));
  expect(await ok("open_document", { path: "/d/a.md" })).toBe("Opened a.md (2 blocks).");
  io.files.set("/d/lossy.docx", await buildDocx({ document: BODY_WITH_INS_DEL_AND_TEXTBOX, header: "first-page-only" }));
  expect(await ok("open_document", { path: "/d/lossy.docx" })).toBe(
    "Opened lossy.docx (2 blocks). DocBro can't keep these parts of the file: headers, tracked changes, other content. " +
      "Saving over the file will remove them.");
  io.files.set("/d/f.docx", await exportDocx(fixtureDoc()));
  expect(await ok("open_document", { path: "/d/f.docx" })).toMatch(/^Opened f\.docx \(\d+ blocks\)\.$/);

  expect(await err("open_document", { path: "relative.md" })).toBe("Use an absolute path.");
  expect(await err("open_document", { path: "/d/a.txt" })).toBe("DocBro opens .docx and .md files.");
  expect(await err("open_document", { path: "/d/missing.md" })).toBe("Not found");
});

test("save_document_passes_the_sessions_refusals_through", async () => {
  set("Hello");
  expect(await err("save_document")).toBe("The document has no file yet. Give a path.");
  expect(await ok("save_document", { path: "/d/out.md" })).toBe("Saved to /d/out.md.");
  expect(new TextDecoder().decode(io.files.get("/d/out.md"))).toContain("Hello");
  expect(await ok("save_document")).toBe("Saved to /d/out.md.");
  io.files.set("/d/taken.md", new Uint8Array());
  expect(await err("save_document", { path: "/d/taken.md" })).toBe("/d/taken.md already exists. Pass overwrite: true to replace it.");
  expect(await ok("save_document", { path: "/d/taken.md", overwrite: true })).toBe("Saved to /d/taken.md.");

  io.files.set("/d/lossy.docx", await buildDocx({ document: BODY_WITH_INS_DEL_AND_TEXTBOX, header: "first-page-only" }));
  await ok("open_document", { path: "/d/lossy.docx" });
  expect(await err("save_document")).toBe(
    "Saving will remove parts DocBro can't keep: headers, tracked changes, other content. Save under a new name, or confirm.");
  expect(await ok("save_document", { accept_loss: true })).toBe("Saved to /d/lossy.docx.");
});

test("block_addresses_are_one_based_and_inclusive", () => {
  const doc = editor.schema.nodeFromJSON(markdownToDoc("A\n\nBB\n\nCCC"));
  expect(blockCount(doc)).toBe(3);
  expect(blockRange(doc, 1, 1)).toEqual({ from: 0, to: 3 });
  expect(blockRange(doc, 2, 3)).toEqual({ from: 3, to: 12 });
  expect(() => blockRange(doc, 0, 1)).toThrow("Block 0 does not exist. The document has 3 blocks.");
  expect(() => blockRange(doc, 1, 4)).toThrow("Block 4 does not exist. The document has 3 blocks.");
  expect(() => blockRange(doc, 3, 2)).toThrow("to must not be before from.");
});

test("every_tool_has_a_description", () => {
  for (const n of TOOL_NAMES) expect(TOOL_DESCRIPTIONS[n].length).toBeGreaterThan(10);
  expect(TOOL_DESCRIPTIONS.insert_content).toMatch(/top-level/);
});

test("document_info_gives_the_text_of_a_kept_header_and_footer", async () => {
  const view = (...lines: string[]) => ({ type: "doc", content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });
  session.setMeta({
    headerPart: { xml: "<w:hdr/>", rels: null, media: {}, view: view("PT Jetorbit", "Technology For Your Business") },
    footerPart: { xml: "<w:ftr/>", rels: null, media: {}, view: null },
  });
  expect(JSON.parse(await ok("document_info"))).toMatchObject({ header: "PT Jetorbit\nTechnology For Your Business", footer: "" }); // a footer that is there, with no text
});
