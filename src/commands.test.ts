import type { Editor, JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildCommands, COMMAND_IDS, filterCommands, platformKeys, type CommandHost } from "./commands";
import { DocSession } from "./doc/session";
import { createHeadlessEditor } from "./editor/headless";
import type { UiState } from "./layout/viewport";

const BASE_UI: UiState = {
  focus: false,
  hideOutline: false,
  forceOutline: false,
  hideComments: false,
  assistantOpen: false,
  menuBar: true,
  largerText: false,
  sansFont: false,
};

let editor: Editor;
let session: DocSession;

beforeEach(() => {
  editor = createHeadlessEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }] });
  editor.mount(document.createElement("div"));
  session = new DocSession(editor, {
    read: async () => new Uint8Array(),
    write: async () => {},
    exists: async () => false,
    meta: () => {},
  });
});

afterEach(() => {
  session.destroy();
  editor.destroy();
  delete document.documentElement.dataset.theme;
});

const host = (patch: Partial<CommandHost> = {}): CommandHost => ({
  editor,
  session,
  ui: BASE_UI,
  setUi: () => {},
  actions: {},
  ...patch,
});
const byId = (h: CommandHost, id: string) => buildCommands(h).find((c) => c.id === id)!;

test("palette_filter_matches_label_or_group_and_respects_the_tab", () => {
  const cmds = buildCommands(host());
  const labels = (q: string, g: Parameters<typeof filterCommands>[2]) => filterCommands(cmds, q, g).map((c) => c.label);

  expect(labels("bold", "All")).toEqual(["Bold"]);
  expect(labels("  BOLD ", "All")).toEqual(["Bold"]);
  expect(labels("bold", "Edit")).toEqual([]);
  // the group name matches too
  expect(filterCommands(cmds, "view", "All").map((c) => c.group)).toEqual(cmds.filter((c) => c.group === "View").map(() => "View"));
  // an empty query lists the whole tab, in registry order
  expect(filterCommands(cmds, "", "Format")).toEqual(cmds.filter((c) => c.group === "Format"));
  expect(filterCommands(cmds, "", "All")).toEqual(cmds);
  expect(labels("heading", "Format")).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
  expect(labels("zzzz", "All")).toEqual([]);
});

test("every_native_menu_id_is_a_registered_command", () => {
  const rust = readFileSync("src-tauri/src/lib.rs", "utf8");
  const ids = [...rust.matchAll(/(?:item\(|with_id\()"([a-z0-9_]+)"/g)].map((m) => m[1]);
  expect(ids.length).toBeGreaterThan(30);
  expect(ids.filter((id) => !COMMAND_IDS.includes(id))).toEqual([]);
});

test("the_registry_has_every_shared_command_id_once", () => {
  const ids = buildCommands(host()).map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual([...COMMAND_IDS].sort());
  for (const c of buildCommands(host())) {
    expect(c.label).not.toBe("");
    expect(c.icon).not.toBe("");
  }
});

test("a_command_without_its_action_is_disabled", () => {
  const save = vi.fn();
  const without = byId(host(), "save");
  expect(without.enabled).toBe(false);
  expect(() => without.run()).not.toThrow();

  const withIt = byId(host({ actions: { save } }), "save");
  expect(withIt.enabled).toBe(true);
  withIt.run();
  expect(save).toHaveBeenCalledOnce();

  const disabled = buildCommands(host())
    .filter((c) => !c.enabled)
    .map((c) => c.id);
  // the commands later tasks or the window supply; everything else runs on the editor or the view
  expect(disabled.sort()).toEqual(
    ["new", "open", "save", "save_as", "print", "find", "replace", "palette", "image", "link", "color", "comment", "header", "footer", "page_numbers"].sort(),
  );
});

test("format_commands_act_on_the_editor_selection", () => {
  editor.commands.setTextSelection({ from: 1, to: 6 }); // "Hello"
  byId(host(), "bold").run();
  expect(editor.isActive("bold")).toBe(true);
  byId(host(), "h2").run();
  expect(editor.isActive("heading", { level: 2 })).toBe(true);
  byId(host(), "h2").run(); // a menu sets the block, it does not toggle it
  expect(editor.isActive("heading", { level: 2 })).toBe(true);
  byId(host(), "text").run();
  expect(editor.isActive("paragraph")).toBe(true);
  byId(host(), "align_center").run();
  expect(editor.isActive({ textAlign: "center" })).toBe(true);
  byId(host(), "ul").run();
  expect(editor.isActive("bulletList")).toBe(true);
  editor.view.dispatch(closeHistory(editor.state.tr)); // so undo takes back only the next step
  byId(host(), "clear_format").run();
  expect(editor.isActive("bold")).toBe(false);
  byId(host(), "undo").run();
  expect(editor.isActive("bold")).toBe(true);
});

test("block_commands_pick_the_block_and_only_the_lists_toggle", () => {
  editor.commands.setTextSelection(3);
  byId(host(), "quote").run();
  byId(host(), "quote").run(); // a menu picks the quote, it does not toggle it
  expect(editor.isActive("blockquote")).toBe(true);
  byId(host(), "text").run();
  expect(editor.isActive("blockquote")).toBe(false);

  byId(host(), "ul").run();
  expect(editor.isActive("bulletList")).toBe(true);
  byId(host(), "ul").run(); // the mock's list items toggle off
  expect(editor.isActive("bulletList")).toBe(false);
  byId(host(), "ol").run();
  byId(host(), "ul").run(); // bullets replace numbers in place
  expect(editor.isActive("bulletList")).toBe(true);
  expect(editor.isActive("orderedList")).toBe(false);
  byId(host(), "text").run();

  // each block leaves the caret in an empty paragraph after it, where the next one goes
  editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 1); // the end of the line
  byId(host(), "divider").run();
  expect(editor.getJSON().content!.slice(0, 3).map((n) => n.type)).toEqual(["paragraph", "horizontalRule", "paragraph"]);
  byId(host(), "table").run();
  const doc = (editor.getJSON() as JSONContent).content!;
  expect(doc.slice(0, 4).map((n) => n.type)).toEqual(["paragraph", "horizontalRule", "table", "paragraph"]);
  expect(doc[2].content!.map((row) => row.content!.length)).toEqual([3, 3, 3]);
  expect(doc[2].content![0].content![0].type).toBe("tableHeader");
  expect(editor.state.selection.$from.parent).toBe(editor.state.doc.child(3));
});

/** The table's shape as cells per row, with the caret in its first cell. */
function tableWithCaretInFirstCell() {
  byId(host(), "table").run();
  let cell = -1;
  editor.state.doc.descendants((node, pos) => {
    if (cell < 0 && node.type.name === "tableHeader") cell = pos;
  });
  editor.commands.setTextSelection(cell + 2);
}
const tableShape = () => {
  const table = (editor.getJSON() as JSONContent).content!.find((n) => n.type === "table");
  return table ? table.content!.map((row) => row.content!.length) : null;
};

test("table_commands_add_and_remove_columns_rows_and_the_table", () => {
  tableWithCaretInFirstCell();
  expect(tableShape()).toEqual([3, 3, 3]);

  byId(host(), "column_after").run();
  expect(tableShape()).toEqual([4, 4, 4]);
  byId(host(), "column_before").run();
  expect(tableShape()).toEqual([5, 5, 5]);
  byId(host(), "column_delete").run();
  expect(tableShape()).toEqual([4, 4, 4]);

  byId(host(), "row_after").run();
  expect(tableShape()).toEqual([4, 4, 4, 4]);
  byId(host(), "row_before").run();
  expect(tableShape()).toEqual([4, 4, 4, 4, 4]);
  byId(host(), "row_delete").run();
  expect(tableShape()).toEqual([4, 4, 4, 4]);

  byId(host(), "table_delete").run();
  expect(tableShape()).toBeNull();
});

test("table_commands_leave_the_document_alone_outside_a_table", () => {
  const before = JSON.stringify(editor.getJSON());
  for (const id of ["column_before", "column_after", "column_delete", "row_before", "row_after", "row_delete", "table_delete"]) {
    expect(() => byId(host(), id).run()).not.toThrow();
  }
  expect(JSON.stringify(editor.getJSON())).toBe(before);
});

test("table_cells_have_borders_between_columns", () => {
  const css = readFileSync("src/styles.css", "utf8");
  // a rule for both cell kinds that draws all four sides, so an empty table still reads as rows and columns
  expect(css).toMatch(/\.doc th,\s*\.doc td\s*\{[^}]*\bborder:\s*1px solid/);
});

test("view_toggles_patch_the_ui_and_show_their_state", () => {
  const setUi = vi.fn();
  byId(host({ setUi }), "focus").run();
  expect(setUi).toHaveBeenLastCalledWith({ focus: true });
  byId(host({ setUi, ui: { ...BASE_UI, largerText: true } }), "larger_text").run();
  expect(setUi).toHaveBeenLastCalledWith({ largerText: false });

  expect(byId(host(), "focus").state).toBe("");
  expect(byId(host({ ui: { ...BASE_UI, focus: true } }), "focus").state).toBe("On");
  expect(byId(host({ ui: { ...BASE_UI, sansFont: true } }), "sans_font").state).toBe("On");
  expect(byId(host(), "bold").state).toBe("");
});

test("dark_mode_flips_the_theme_and_asks_for_a_new_render", () => {
  const setUi = vi.fn();
  document.documentElement.dataset.theme = "light";
  expect(byId(host(), "dark_mode").state).toBe("");
  byId(host({ setUi }), "dark_mode").run();
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(setUi).toHaveBeenCalled();
  expect(byId(host(), "dark_mode").state).toBe("On");
});

test("shortcut_labels_use_ctrl_alt_and_shift_off_macos", () => {
  expect(platformKeys("⇧⌘Z", true)).toBe("⇧⌘Z");
  expect(platformKeys("⇧⌘Z", false)).toBe("Ctrl+Shift+Z");
  expect(platformKeys("⌥⌘1", false)).toBe("Ctrl+Alt+1");
  expect(platformKeys("⌘\\", false)).toBe("Ctrl+\\");
  expect(platformKeys("", false)).toBe("");
});

test("page_break_starts_a_new_page_and_leaves_an_empty_paragraph_to_type_in", () => {
  editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 1); // the end of the line
  byId(host(), "page_break").run();
  expect(editor.getJSON().content!.map((n) => n.type)).toEqual(["paragraph", "pageBreak", "paragraph"]);
  expect(editor.state.selection.$from.parent).toBe(editor.state.doc.child(2));
  expect(byId(host(), "page_break")).toMatchObject({ group: "Insert", label: "Page break" });
});

test("a_kept_header_or_footer_shows_as_on_and_takes_the_page_number_toggle_out_of_play", () => {
  const kept = { xml: "<w:hdr/>", rels: null, media: {}, view: null };
  const actions = { toggleHeader: () => {}, toggleFooter: () => {}, togglePageNumbers: () => {} };
  expect(byId(host({ actions }), "header").state).toBe("");
  expect(byId(host({ actions }), "page_numbers").enabled).toBe(true);

  session.setMeta({ headerPart: kept, footerPart: kept });
  expect(byId(host({ actions }), "header").state).toBe("On");
  expect(byId(host({ actions }), "footer").state).toBe("On");
  // a footer kept from the file has page numbers of its own, so there is nothing to switch
  expect(byId(host({ actions }), "page_numbers").enabled).toBe(false);
});

test("while_a_header_or_footer_is_edited_page_numbers_puts_a_page_field_at_the_caret", () => {
  const actions = { togglePageNumbers: vi.fn() };
  session.setMeta({ footerPart: { xml: null, rels: null, media: {}, view: null } }); // even with a kept footer
  editor.commands.setTextSelection(6); // "Hello| world"
  const command = byId(host({ actions, zoneEditing: true }), "page_numbers");
  expect(command.enabled).toBe(true);
  command.run();
  expect(actions.togglePageNumbers).not.toHaveBeenCalled();
  expect((editor.getJSON() as JSONContent).content![0].content!.map((n) => n.type === "field" ? `{${n.attrs!.instr}}` : n.text).join("")).toBe("Hello{PAGE} world");
});
