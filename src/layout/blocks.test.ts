import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Editor, JSONContent } from "@tiptap/core";
import { afterEach, expect, test, vi } from "vitest";
import { createHeadlessEditor } from "../editor/headless";
import {
  applyBlock,
  applyColor,
  applyLink,
  blockOf,
  bubblePosition,
  chooseSlashItem,
  filterSlash,
  normalizeUrl,
  pickImage,
  popoverPosition,
  slashQuery,
  SLASH_ITEMS,
  TEXT_COLORS,
  type BlockKey,
  type ImagePicker,
} from "./blocks";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null), message: vi.fn(async () => undefined) }));

let editor: Editor;
afterEach(() => editor?.destroy());

const t = (text: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text, marks });
const p = (text?: string): JSONContent => (text ? { type: "paragraph", content: [t(text)] } : { type: "paragraph" });
const li = (text: string): JSONContent => ({ type: "listItem", content: [p(text)] });
const ul = (...items: string[]): JSONContent => ({ type: "bulletList", content: items.map(li) });

/** A mounted editor whose caret sits at the end of the first text it finds (or at `at`). */
function open(content: JSONContent[], at?: number): Editor {
  editor = createHeadlessEditor({ type: "doc", content });
  editor.mount(document.createElement("div"));
  if (at !== undefined) editor.commands.setTextSelection(at);
  else editor.commands.setTextSelection(editor.state.doc.firstChild!.content.size + 1);
  return editor;
}

const json = (e: Editor) => e.getJSON() as JSONContent;
/**
 * The top-level nodes. The editor keeps an empty paragraph after a last heading, list or table (StarterKit's
 * trailing node), so tests that do not look at it leave one out.
 */
const top = (e: Editor): JSONContent[] => {
  const nodes = json(e).content ?? [];
  const last = nodes[nodes.length - 1];
  return nodes.length > 1 && last.type === "paragraph" && !last.content ? nodes.slice(0, -1) : nodes;
};
const kinds = (e: Editor) => top(e).map((n) => n.type);
const rawKinds = (e: Editor) => (json(e).content ?? []).map((n) => n.type);
const firstText = (e: Editor) => e.state.doc.firstChild!.textContent;

// ------------------------------------------------------------------ slash menu

test.each([["/", ""], ["/head", "head"], ["/h2 ", "h2"], ["/Text", "text"], ["/a_b", "a_b"], ["/  ", ""]])(
  "slash %s opens with query %s",
  (text, q) => {
    expect(slashQuery(text)).toBe(q);
  },
);

test.each(["see /t", "a/b", "/this is far too long to be a command", "", "/a-b", "/h2\nmore", "//"])(
  "slash ignores %j",
  (text) => {
    expect(slashQuery(text)).toBeNull();
  },
);

test("slash_with_no_match_offers_nothing_so_enter_stays_a_newline", () => {
  expect(filterSlash("zzzz")).toEqual([]);
});

test("the_slash_list_has_table_and_image_after_quote_and_matches_label_or_key", () => {
  expect(SLASH_ITEMS.map((s) => s.k)).toEqual(["p", "h1", "h2", "h3", "ul", "ol", "blockquote", "table", "image", "hr"]);
  expect(SLASH_ITEMS.find((s) => s.k === "table")).toEqual({ k: "table", label: "Table", hint: "Rows and columns", icon: "▦" });
  expect(SLASH_ITEMS.find((s) => s.k === "image")).toEqual({ k: "image", label: "Image", hint: "From a file", icon: "▣" });
  expect(filterSlash("")).toEqual(SLASH_ITEMS);
  expect(filterSlash("tab").map((s) => s.k)).toEqual(["table"]);
  expect(filterSlash("H2").map((s) => s.k)).toEqual(["h2"]);
  expect(filterSlash("heading").map((s) => s.k)).toEqual(["h1", "h2", "h3"]);
  expect(filterSlash("hr").map((s) => s.k)).toEqual(["hr"]);
});

// ------------------------------------------------------------------ bubble and popovers

test("bubble_stays_inside_the_paper", () => {
  const paper = { left: 100, top: 50, width: 780, height: 900 };
  expect(bubblePosition({ left: 100, top: 200, width: 10, height: 18 }, paper).x).toBe(170);
  expect(bubblePosition({ left: 870, top: 200, width: 10, height: 18 }, paper).x).toBe(610);
  expect(bubblePosition({ left: 400, top: 200, width: 100, height: 18 }, paper)).toEqual({ x: 350, y: 102 });
});

test("a_popover_opens_below_its_anchor_and_stays_inside_the_paper", () => {
  const paper = { left: 100, top: 50, width: 500, height: 900 };
  expect(popoverPosition({ left: 300, bottom: 220 }, paper, 280)).toEqual({ x: 200, y: 178 });
  expect(popoverPosition({ left: 100, bottom: 220 }, paper, 280).x).toBe(8);
  expect(popoverPosition({ left: 590, bottom: 220 }, paper, 280).x).toBe(212);
});

// ------------------------------------------------------------------ blocks

test("applying_the_current_block_again_returns_to_a_paragraph", () => {
  open([p("Hello world")], 3);
  applyBlock(editor, "h2");
  expect(blockOf(editor)).toBe("h2");
  expect(editor.isActive("heading", { level: 2 })).toBe(true);
  applyBlock(editor, "h2");
  expect(blockOf(editor)).toBe("p");
  expect(editor.isActive("paragraph")).toBe(true);
  // a menu forces: choosing Heading 2 on a Heading 2 keeps it
  applyBlock(editor, "h2", true);
  applyBlock(editor, "h2", true);
  expect(editor.isActive("heading", { level: 2 })).toBe(true);
  // one heading level replaces another
  applyBlock(editor, "h3");
  expect(editor.isActive("heading", { level: 3 })).toBe(true);
  // applying text to a paragraph changes nothing
  applyBlock(editor, "p");
  applyBlock(editor, "p");
  expect(editor.isActive("paragraph")).toBe(true);
  expect(firstText(editor)).toBe("Hello world");
});

test("the_quote_toggles_off_and_a_menu_forces_it", () => {
  open([p("Said")], 3);
  applyBlock(editor, "blockquote");
  expect(blockOf(editor)).toBe("blockquote");
  applyBlock(editor, "blockquote", true);
  expect(kinds(editor)).toEqual(["blockquote"]);
  expect(json(editor).content![0].content).toHaveLength(1);
  applyBlock(editor, "blockquote");
  expect(kinds(editor)).toEqual(["paragraph"]);
});

test("a_list_toggles_off_and_numbered_list_replaces_bullets", () => {
  open([p("One"), p("Two")], 3);
  applyBlock(editor, "ul");
  expect(blockOf(editor)).toBe("ul");
  expect(kinds(editor)).toEqual(["bulletList", "paragraph"]);
  // a menu forces: the list stays
  applyBlock(editor, "ul", true);
  expect(kinds(editor)).toEqual(["bulletList", "paragraph"]);
  // numbered replaces bullets, in place
  applyBlock(editor, "ol");
  expect(blockOf(editor)).toBe("ol");
  expect(kinds(editor)).toEqual(["orderedList", "paragraph"]);
  applyBlock(editor, "ol");
  expect(kinds(editor)).toEqual(["paragraph", "paragraph"]);
  expect(editor.getText({ blockSeparator: "|" })).toBe("One|Two");
});

test("normal_text_and_headings_leave_a_list_or_a_quote", () => {
  open([ul("One", "Two")], 5); // in "One"
  applyBlock(editor, "h1", true);
  expect(kinds(editor)).toEqual(["heading", "bulletList"]);
  expect(json(editor).content![0].attrs).toMatchObject({ level: 1 });
  expect(json(editor).content![1].content).toHaveLength(1);
  // one undo takes the whole change back
  editor.commands.undo();
  expect(kinds(editor)).toEqual(["bulletList"]);

  editor.commands.setTextSelection(5);
  applyBlock(editor, "p", true);
  expect(kinds(editor)).toEqual(["paragraph", "bulletList"]);

  open([{ type: "blockquote", content: [p("Said")] }], 3);
  applyBlock(editor, "p", true);
  expect(kinds(editor)).toEqual(["paragraph"]);
});

test("a_heading_becomes_a_list_item_and_a_list_item_becomes_a_quote", () => {
  open([{ type: "heading", attrs: { level: 2 }, content: [t("Title")] }], 3);
  applyBlock(editor, "ul", true);
  expect(kinds(editor)).toEqual(["bulletList"]);
  expect(firstText(editor)).toBe("Title");
  applyBlock(editor, "blockquote", true);
  expect(kinds(editor)).toEqual(["blockquote"]);
  expect(firstText(editor)).toBe("Title");
});

/** The position of the first node of this type. */
function posOf(typeName: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === typeName) found = pos;
    return found < 0;
  });
  return found;
}

test("block_of_reads_headings_quotes_lists_tables_and_dividers", () => {
  const cases: [JSONContent[], number, BlockKey][] = [
    [[p("Plain")], 3, "p"],
    [[{ type: "heading", attrs: { level: 3 }, content: [t("H")] }], 1, "h3"],
    [[{ type: "blockquote", content: [p("Q")] }], 2, "blockquote"],
    [[ul("A")], 3, "ul"],
    [[{ type: "orderedList", content: [li("A")] }], 3, "ol"],
  ];
  for (const [content, at, key] of cases) {
    open(content, at);
    expect(blockOf(editor)).toBe(key);
    editor.destroy();
  }
  open([p("Before")], 3);
  applyBlock(editor, "table", true);
  editor.commands.setTextSelection(posOf("tableCell") + 2);
  expect(blockOf(editor)).toBe("table");
  editor.commands.setNodeSelection(posOf("table"));
  expect(blockOf(editor)).toBe("table");
  applyBlock(editor, "hr", true);
  editor.commands.setNodeSelection(posOf("horizontalRule"));
  expect(blockOf(editor)).toBe("hr");
});

test("divider_and_table_leave_an_empty_paragraph_to_type_in", () => {
  open([p("Before"), p(), p("After")], 9); // the empty line
  applyBlock(editor, "hr", true);
  expect(kinds(editor)).toEqual(["paragraph", "horizontalRule", "paragraph", "paragraph"]);
  expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  expect(editor.state.selection.$from.parent.content.size).toBe(0);
  expect(editor.state.selection.$from.parent).toBe(editor.state.doc.child(2));
  editor.commands.insertContent("typed");
  expect(json(editor).content![2].content![0].text).toBe("typed");

  open([p("Before"), p()], 9);
  applyBlock(editor, "table", true);
  const doc = json(editor).content!;
  expect(doc.map((n) => n.type)).toEqual(["paragraph", "table", "paragraph"]);
  const rows = doc[1].content!;
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.content!.length)).toEqual([3, 3, 3]);
  expect(rows[0].content!.every((c) => c.type === "tableHeader")).toBe(true);
  expect(rows[1].content!.every((c) => c.type === "tableCell")).toBe(true);
  expect(editor.state.selection.$from.parent).toBe(editor.state.doc.lastChild);
  expect(editor.state.selection.$from.parent.content.size).toBe(0);
});

test("a_divider_in_the_middle_of_a_line_splits_it_and_ends_in_an_empty_paragraph", () => {
  open([p("Hello world")], 7);
  applyBlock(editor, "hr", true);
  expect(kinds(editor)).toEqual(["paragraph", "horizontalRule", "paragraph", "paragraph"]);
  expect(editor.getText({ blockSeparator: "|" })).toBe("Hello |||world");
  expect(editor.state.selection.$from.parent.content.size).toBe(0);
});

test("a_divider_or_table_at_the_end_of_a_line_or_before_the_rest_of_it_puts_the_caret_in_the_empty_paragraph", () => {
  open([p("Hello"), p("After")], 6); // end of "Hello"
  applyBlock(editor, "hr", true);
  expect(rawKinds(editor)).toEqual(["paragraph", "horizontalRule", "paragraph", "paragraph"]);
  expect(editor.state.selection.$from.parent).toBe(editor.state.doc.child(2));
  expect(editor.state.selection.$from.parent.content.size).toBe(0);

  open([p("Hello world")], 7);
  applyBlock(editor, "table", true);
  expect(rawKinds(editor)).toEqual(["paragraph", "table", "paragraph", "paragraph"]);
  expect(editor.state.selection.$from.parent).toBe(editor.state.doc.child(2));
  expect(editor.state.selection.$from.parent.content.size).toBe(0);
  expect(editor.state.doc.child(3).textContent).toBe("world");
});

test("choosing_a_slash_item_removes_the_slash_text", () => {
  open([p("/h2")]);
  chooseSlashItem(editor, "h2");
  expect(top(editor)).toHaveLength(1);
  expect(top(editor)[0]).toMatchObject({ type: "heading", attrs: { level: 2 } });
  expect(top(editor)[0].content).toBeUndefined();

  open([p("/tab")]);
  chooseSlashItem(editor, "table");
  expect(rawKinds(editor)).toEqual(["table", "paragraph"]);
  expect(editor.getText()).not.toContain("/tab");

  open([p("Keep"), p("/")], 8);
  chooseSlashItem(editor, "ul");
  expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, "|")).toBe("Keep||");
  expect(kinds(editor)).toEqual(["paragraph", "bulletList"]);
});

test("a_slash_item_never_deletes_a_line_that_is_not_a_slash_command", () => {
  open([p("see /t")]);
  chooseSlashItem(editor, "h2");
  expect(firstText(editor)).toBe("see /t");
  expect(editor.isActive("heading", { level: 2 })).toBe(true);

  // a command inside a list or a quote is not the top-level line the menu opens on
  open([ul("/h2")], 6);
  chooseSlashItem(editor, "h3");
  expect(firstText(editor)).toBe("/h2");

  // applying a block from the dock leaves slash-looking text alone
  open([p("/tmp")]);
  applyBlock(editor, "h1");
  expect(firstText(editor)).toBe("/tmp");
});

// ------------------------------------------------------------------ links and colors

test("a_link_applies_to_the_selection_and_an_empty_field_removes_it", () => {
  open([p("Visit our site today")], 7);
  editor.commands.setTextSelection({ from: 7, to: 10 }); // "our"
  expect(applyLink(editor, "example.com/x")).toBe(true);
  expect(json(editor).content![0].content).toEqual([
    t("Visit "),
    t("our", [{ type: "link", attrs: expect.objectContaining({ href: "https://example.com/x" }) }]),
    t(" site today"),
  ]);
  // a caret inside the link edits the whole link
  editor.commands.setTextSelection(8);
  expect(applyLink(editor, "https://a.b")).toBe(true);
  expect(editor.getAttributes("link").href).toBe("https://a.b");
  expect(json(editor).content![0].content).toHaveLength(3);
  // an empty field removes it from the whole link
  expect(applyLink(editor, "  ")).toBe(true);
  expect(json(editor).content![0].content).toEqual([t("Visit our site today")]);
});

test("a_link_with_an_unsafe_address_is_refused_and_changes_nothing", () => {
  open([p("Visit our site")], 7);
  editor.commands.setTextSelection({ from: 7, to: 10 });
  const before = JSON.stringify(json(editor));
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "file:///etc/passwd", "not a url"]) {
    expect(applyLink(editor, bad)).toBe(false);
  }
  expect(JSON.stringify(json(editor))).toBe(before);
});

test("a_link_at_a_caret_inserts_its_address_as_the_text", () => {
  open([p("See ")]);
  expect(applyLink(editor, "mailto:a@b.id")).toBe(true);
  expect(json(editor).content![0].content).toEqual([
    t("See "),
    t("mailto:a@b.id", [{ type: "link", attrs: expect.objectContaining({ href: "mailto:a@b.id" }) }]),
  ]);
});

test("there_are_eight_text_colors_and_default_removes_the_color", () => {
  expect(TEXT_COLORS).toHaveLength(8);
  expect(new Set(TEXT_COLORS.map((c) => c.value)).size).toBe(8);
  for (const c of TEXT_COLORS) expect(c.value).toMatch(/^#[0-9a-f]{6}$/);
  open([p("Colorful")]);
  editor.commands.selectAll();
  applyColor(editor, TEXT_COLORS[2].value);
  expect(editor.getAttributes("textStyle").color).toBe(TEXT_COLORS[2].value);
  applyColor(editor, null);
  expect(editor.getAttributes("textStyle").color ?? null).toBeNull();
});

// ------------------------------------------------------------------ urls

test.each([
  ["example.com/x", "https://example.com/x"],
  ["https://a.b", "https://a.b"],
  ["mailto:a@b.id", "mailto:a@b.id"],
  ["javascript:alert(1)", null],
  ["file:///etc/passwd", null],
  ["  ", null],
  ["", null],
])("normalizeUrl(%j)", (input, output) => {
  expect(normalizeUrl(input)).toBe(output);
});

test.each([
  ["  https://a.b/path  ", "https://a.b/path"],
  ["HTTPS://A.B", "HTTPS://A.B"],
  ["http://localhost:3000/x", "http://localhost:3000/x"],
  ["www.example.com", "https://www.example.com"],
  ["localhost", "https://localhost"],
  ["mailto:a@b.id?subject=Hi", "mailto:a@b.id?subject=Hi"],
])("normalizeUrl keeps a good address: %j", (input, output) => {
  expect(normalizeUrl(input)).toBe(output);
});

test.each([
  "JaVaScRiPt:alert(1)",
  "JAVASCRIPT:alert(1)",
  "  javascript:alert(1)",
  "\tjavascript:alert(1)",
  "\n\rjavascript:alert(1)",
  "\u0001javascript:alert(1)",
  "\u0000javascript:alert(1)",
  "\u001fjavascript:alert(1)",
  "\u007fjavascript:alert(1)",
  "\u0085javascript:alert(1)",
  "\u00a0javascript:alert(1)",
  "\u2028javascript:alert(1)",
  "\u200bjavascript:alert(1)",
  "\ufeffjavascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "jav\u0000ascript:alert(1)",
  "java script:alert(1)",
  "javascript\t:alert(1)",
  "javascript&colon;alert(1)",
  "jav&#x09;ascript:alert(1)",
  "%6Aavascript:alert(1)",
  "javascript://%0Aalert(1)",
  "javascript://example.com/%0Aalert(1)",
  "vbscript:msgbox(1)",
  "VBScript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
  "DATA:text/html;base64,PHNjcmlwdD4=",
  "data:image/svg+xml,<svg/>",
  "blob:https://a.b/uuid",
  "file:///etc/passwd",
  "FILE://host/share",
  "ftp://a.b/file",
  "tel:+6212345",
  "sms:+6212345",
  "about:blank",
  "chrome://settings",
  "tauri://localhost",
  "ｊavascript:alert(1)",
  "http://",
  "https:",
  "mailto:",
  "hello",
  "two words.com",
  "https://a.b/has space",
])("normalizeUrl(%j) is refused", (input) => {
  expect(normalizeUrl(input)).toBeNull();
});

// ------------------------------------------------------------------ images

const MB = 1024 * 1024;

function picker(over: Partial<ImagePicker> = {}): ImagePicker & { alert: ReturnType<typeof vi.fn> } {
  return {
    pick: vi.fn(async () => "/home/me/Pictures/cat.png"),
    read: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    alert: vi.fn(),
    ...over,
  } as ImagePicker & { alert: ReturnType<typeof vi.fn> };
}
const images = () => (json(editor).content ?? []).filter((n) => n.type === "image");

test("a_picked_image_is_inserted_as_a_data_url", async () => {
  open([p("")]);
  const io = picker();
  await pickImage(editor, io);
  expect(images()).toHaveLength(1);
  expect(images()[0].attrs).toMatchObject({ src: "data:image/png;base64,iVBORw==" });
  // typing goes on in an empty paragraph after the image, not over it
  expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  expect(editor.state.selection.$from.parent.content.size).toBe(0);
  editor.commands.insertContent("after");
  expect(rawKinds(editor)).toEqual(["image", "paragraph"]);
  expect(editor.state.doc.lastChild!.textContent).toBe("after");
  expect(io.alert).not.toHaveBeenCalled();
});

test.each([
  ["a.jpg", "image/jpeg"],
  ["a.JPEG", "image/jpeg"],
  ["C:\\pics\\a.Gif", "image/gif"],
])("image %s is sent as %s", async (path, mime) => {
  open([p("")]);
  await pickImage(editor, picker({ pick: vi.fn(async () => path) }));
  expect((images()[0].attrs!.src as string).startsWith(`data:${mime};base64,`)).toBe(true);
});

test("an_image_over_5_mb_is_refused_with_a_message", async () => {
  open([p("")]);
  const io = picker({ read: vi.fn(async () => new Uint8Array(5 * MB + 1)) });
  await pickImage(editor, io);
  expect(io.alert).toHaveBeenCalledWith("Images over 5 MB make the document too heavy. Choose a smaller one.");
  expect(images()).toEqual([]);

  // exactly 5 MB is allowed
  const exact = picker({ read: vi.fn(async () => new Uint8Array(5 * MB)) });
  await pickImage(editor, exact);
  expect(exact.alert).not.toHaveBeenCalled();
  expect(images()).toHaveLength(1);
});

test("cancelling_the_dialog_or_a_failed_read_inserts_nothing", async () => {
  open([p("")]);
  const cancelled = picker({ pick: vi.fn(async () => null) });
  await pickImage(editor, cancelled);
  expect(cancelled.read).not.toHaveBeenCalled();
  expect(cancelled.alert).not.toHaveBeenCalled();

  const failing = picker({ read: vi.fn(async () => Promise.reject(new Error("Not found"))) });
  await expect(pickImage(editor, failing)).resolves.toBeUndefined();
  expect(failing.alert).toHaveBeenCalledWith("Not found");
  expect(images()).toEqual([]);
});

test("a_type_the_exporter_cannot_write_is_refused", async () => {
  open([p("")]);
  const io = picker({ pick: vi.fn(async () => "/x/logo.svg") });
  await pickImage(editor, io);
  expect(io.read).not.toHaveBeenCalled();
  expect(io.alert).toHaveBeenCalledWith("Choose a PNG, JPG or GIF image.");
  expect(images()).toEqual([]);
});

test("the_image_dialog_offers_png_jpg_jpeg_and_gif_only", async () => {
  open([p("")]);
  applyBlock(editor, "image");
  await vi.waitFor(() =>
    expect(openDialog).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif"] }],
    }),
  );
  expect(images()).toEqual([]);
});
