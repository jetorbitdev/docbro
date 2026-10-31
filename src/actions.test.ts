import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  buildActions,
  openPaths,
  receiveFile,
  recentlyRan,
  runExclusive,
  saveAs,
  saveDocument,
  type Shell,
} from "./actions";
import { buildCommands } from "./commands";
import { DocSession, type SessionIO } from "./doc/session";
import { createHeadlessEditor } from "./editor/headless";
import { UNKNOWN_FORMAT } from "./formats";
import { pickImage } from "./layout/blocks";
import type { UiState } from "./layout/viewport";

vi.mock("./layout/blocks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./layout/blocks")>()),
  pickImage: vi.fn(async () => {}),
}));

class MemoryIO implements SessionIO {
  files = new Map<string, Uint8Array>();
  readHolds: Promise<void>[] = [];
  async read(path: string) {
    await this.readHolds.shift();
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

function latch() {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  return { hold, release };
}

/** A shell that answers every dialog from the test's script and records what it was asked. */
function fakeShell(patch: Partial<Shell> = {}) {
  return {
    choose: vi.fn(async () => "Cancel"),
    showError: vi.fn(),
    pickOpen: vi.fn(async () => null),
    pickSave: vi.fn(async () => null),
    openInWindow: vi.fn(async () => false),
    ...patch,
  } satisfies Shell;
}

const md = (text: string) => new TextEncoder().encode(text);
const read = (io: MemoryIO, path: string) => new TextDecoder().decode(io.files.get(path));

let editor: Editor;
let io: MemoryIO;
let session: DocSession;

beforeEach(() => {
  editor = createHeadlessEditor();
  editor.mount(document.createElement("div"));
  io = new MemoryIO();
  io.files.set("/d/a.md", md("# Alpha\n"));
  io.files.set("/d/b.md", md("Beta\n"));
  session = new DocSession(editor, io);
});

afterEach(() => {
  session.destroy();
  editor.destroy();
});

// ------------------------------------------------------------------ save

test("saving_a_document_that_has_a_file_writes_it_in_place", async () => {
  const shell = fakeShell();
  await session.open("/d/a.md");
  editor.commands.insertContent("More ");
  await saveDocument(shell, session);
  expect(read(io, "/d/a.md")).toContain("More");
  expect(session.dirty).toBe(false);
  expect(shell.pickSave).not.toHaveBeenCalled();
});

test("saving_an_untitled_document_asks_for_a_name_and_adds_docx", async () => {
  const shell = fakeShell({ pickSave: vi.fn(async () => "/d/report") });
  editor.commands.insertContent("Hello");
  await saveDocument(shell, session);
  expect(shell.pickSave).toHaveBeenCalledWith("Untitled.docx", [
    { name: "Word document", extensions: ["docx"] },
    { name: "Markdown", extensions: ["md", "markdown"] },
  ]);
  expect(io.files.has("/d/report.docx")).toBe(true);
  expect(session.path).toBe("/d/report.docx");
});

test("save_as_offers_markdown_first_for_a_markdown_file_and_cancel_writes_nothing", async () => {
  const shell = fakeShell();
  await session.open("/d/a.md");
  editor.commands.insertContent("x");
  await saveAs(shell, session);
  expect(shell.pickSave).toHaveBeenCalledWith("/d/a.md", [
    { name: "Markdown", extensions: ["md", "markdown"] },
    { name: "Word document", extensions: ["docx"] },
  ]);
  expect(read(io, "/d/a.md")).toBe("# Alpha\n");
  expect(session.dirty).toBe(true);
});

test("save_as_replaces_a_file_the_dialog_already_asked_about", async () => {
  const shell = fakeShell({ pickSave: vi.fn(async () => "/d/b.md") });
  editor.commands.insertContent("Gamma");
  await saveAs(shell, session);
  expect(read(io, "/d/b.md")).toContain("Gamma");
});

test.each([
  ["Save anyway", true],
  ["Cancel", false],
])("a_lossy_save_asks_first: %s", async (choice, written) => {
  const shell = fakeShell({ choose: vi.fn(async () => choice) });
  await session.open("/d/a.md");
  session.setMeta({ footer: "Internal" });
  await saveDocument(shell, session);
  expect(shell.choose).toHaveBeenCalledWith(expect.stringContaining("Markdown can't keep footers"), {
    title: "Some content will be lost",
    buttons: { yes: "Save anyway", no: "Save As…", cancel: "Cancel" },
  });
  expect(session.dirty).toBe(!written);
});

test("a_lossy_save_can_go_to_save_as_instead", async () => {
  const shell = fakeShell({ choose: vi.fn(async () => "Save As…"), pickSave: vi.fn(async () => "/d/a.docx") });
  await session.open("/d/a.md");
  session.setMeta({ footer: "Internal" });
  await saveDocument(shell, session);
  expect(read(io, "/d/a.md")).toBe("# Alpha\n");
  expect(io.files.has("/d/a.docx")).toBe(true);
  expect(session.path).toBe("/d/a.docx");
});

// ------------------------------------------------------------------ one command at a time

test("a_second_file_command_while_one_is_running_is_ignored", async () => {
  const gate = latch();
  const shell = fakeShell();
  const first = vi.fn(() => gate.hold);
  const second = vi.fn(async () => {});
  const running = runExclusive(shell, first);
  await runExclusive(shell, second);
  expect(second).not.toHaveBeenCalled();
  gate.release();
  await running;
  await runExclusive(shell, second);
  expect(second).toHaveBeenCalledOnce();
});

test("a_failing_file_command_shows_its_error", async () => {
  const shell = fakeShell();
  await runExclusive(shell, async () => {
    throw new Error("Disk full");
  });
  expect(shell.showError).toHaveBeenCalledWith(new Error("Disk full"));
});

test("the_same_command_from_two_sources_runs_once", () => {
  let now = 1000;
  const repeat = recentlyRan(500, () => now);
  expect(repeat("save")).toBe(false);
  expect(repeat("save")).toBe(true);
  expect(repeat("save_as")).toBe(false);
  now += 501;
  expect(repeat("save")).toBe(false);
});

// ------------------------------------------------------------------ files from outside

test("a_file_sent_to_a_clean_window_opens_there", async () => {
  const shell = fakeShell();
  await receiveFile(shell, session, "/d/a.md");
  expect(session.path).toBe("/d/a.md");
  expect(shell.openInWindow).not.toHaveBeenCalled();
});

test("a_file_sent_to_a_window_with_unsaved_changes_goes_to_a_new_window", async () => {
  const shell = fakeShell();
  editor.commands.insertContent("Draft");
  await receiveFile(shell, session, "/d/a.md");
  expect(shell.openInWindow).toHaveBeenCalledWith("/d/a.md", false);
  expect(session.path).toBeNull();
  expect(editor.getText()).toBe("Draft");
});

test("typing_during_a_slow_open_is_kept_and_the_file_goes_to_a_new_window", async () => {
  const shell = fakeShell();
  const slow = latch();
  io.readHolds.push(slow.hold);
  const receiving = receiveFile(shell, session, "/d/a.md");
  editor.commands.insertContent("Typed meanwhile");
  slow.release();
  await receiving;
  expect(editor.getText()).toBe("Typed meanwhile");
  expect(session.path).toBeNull();
  expect(shell.openInWindow).toHaveBeenCalledWith("/d/a.md", false);
  expect(shell.showError).not.toHaveBeenCalled();
});

test("a_file_that_fails_to_open_shows_the_error", async () => {
  const shell = fakeShell();
  await receiveFile(shell, session, "/d/missing.md");
  expect(shell.showError).toHaveBeenCalledWith(new Error("Not found"));
  expect(shell.openInWindow).not.toHaveBeenCalled();
});

test("opening_several_files_puts_the_first_in_a_blank_window_and_the_rest_in_new_ones", async () => {
  const openInWindow = vi.fn(async (_path: string | null, here?: boolean) => !!here);
  const shell = fakeShell({ openInWindow });
  await openPaths(shell, session, ["/d/a.md", "/d/notes.txt", "/d/b.md"]);
  expect(openInWindow.mock.calls).toEqual([
    ["/d/a.md", true],
    ["/d/b.md", false],
  ]);
  expect(shell.showError).toHaveBeenCalledWith(new Error(UNKNOWN_FORMAT));
  expect(session.path).toBe("/d/a.md");
});

test("a_window_with_a_document_sends_every_opened_file_elsewhere", async () => {
  const shell = fakeShell();
  await session.open("/d/b.md");
  await openPaths(shell, session, ["/d/a.md"]);
  expect(shell.openInWindow).toHaveBeenCalledWith("/d/a.md", false);
  expect(session.path).toBe("/d/b.md");
});

test("open_picks_files_and_opens_them", async () => {
  const shell = fakeShell({
    pickOpen: vi.fn(async () => ["/d/a.md"]),
    openInWindow: vi.fn(async (_path: string | null, here?: boolean) => !!here),
  });
  const ui: UiState = {
    focus: false, hideOutline: false, forceOutline: false, hideComments: false,
    assistantOpen: false, menuBar: true, largerText: false, sansFont: false,
  };
  const actions = buildActions({ editor, session, ui, setUi: () => {}, openPalette: () => {}, shell });
  actions.open!();
  await vi.waitFor(() => expect(session.path).toBe("/d/a.md"));
});

// ------------------------------------------------------------------ the window's actions

test("the_window_supplies_its_file_and_view_actions", () => {
  const shell = fakeShell();
  const openPalette = vi.fn();
  const print = vi.spyOn(window, "print").mockImplementation(() => {});
  const ui = {} as UiState;
  const actions = buildActions({ editor, session, ui, setUi: () => {}, openPalette, shell });
  expect(Object.keys(actions).sort()).toEqual(
    ["insertImage", "newWindow", "open", "palette", "print", "save", "saveAs", "toggleFooter", "toggleHeader", "togglePageNumbers"],
  );
  actions.palette!();
  expect(openPalette).toHaveBeenCalledOnce();
  actions.print!();
  expect(print).toHaveBeenCalledOnce();
  actions.newWindow!();
  expect(shell.openInWindow).toHaveBeenCalledWith(null);
  print.mockRestore();
});

test("image_runs_the_picker_and_link_and_color_open_their_popovers", () => {
  const ui = {} as UiState;
  const openLink = vi.fn();
  const openColor = vi.fn();
  const actions = buildActions({ editor, session, ui, setUi: () => {}, openPalette: () => {}, openLink, openColor, shell: fakeShell() });
  expect(Object.keys(actions).sort()).toEqual(
    [
      "insertImage", "insertLink", "newWindow", "open", "palette", "pickColor", "print", "save", "saveAs",
      "toggleFooter", "toggleHeader", "togglePageNumbers",
    ],
  );
  actions.insertImage!();
  expect(pickImage).toHaveBeenCalledWith(editor);
  actions.insertLink!();
  expect(openLink).toHaveBeenCalledOnce();
  actions.pickColor!();
  expect(openColor).toHaveBeenCalledOnce();
});

test("header_footer_and_page_numbers_edit_the_documents_meta", () => {
  const ui = {} as UiState;
  const actions = buildActions({ editor, session, ui, setUi: () => {}, openPalette: () => {}, shell: fakeShell() });

  actions.toggleHeader!();
  expect(session.meta.header).toBe("");
  actions.toggleHeader!();
  expect(session.meta.header).toBeNull();

  actions.togglePageNumbers!(); // page numbers alone bring the footer on
  expect(session.meta).toMatchObject({ footer: "", pageNumbers: true });
  actions.togglePageNumbers!();
  expect(session.meta.pageNumbers).toBe(false);

  actions.toggleFooter!();
  expect(session.meta.footer).toBeNull();
  expect(session.meta.pageNumbers).toBe(false);

  actions.toggleFooter!();
  expect(session.meta.footer).toBe("");
});

test("every_command_is_enabled_in_the_real_app", () => {
  const ui: UiState = {
    focus: false, hideOutline: false, forceOutline: false, hideComments: false,
    assistantOpen: false, menuBar: true, largerText: false, sansFont: false,
  };
  const setUi = () => {};
  const actions = buildActions({
    editor,
    session,
    ui,
    setUi,
    openPalette: () => {},
    openLink: () => {},
    openColor: () => {},
    openFind: () => {},
    shell: fakeShell(),
  });
  const commands = buildCommands({ editor, session, ui, setUi, actions });
  // Task 13 adds the comment action; every other command has its action.
  expect(commands.filter((c) => !c.enabled).map((c) => c.id)).toEqual(["comment"]);
});

test("find_and_replace_open_the_find_bar_in_their_two_modes", () => {
  const ui = {} as UiState;
  const openFind = vi.fn();
  const actions = buildActions({ editor, session, ui, setUi: () => {}, openPalette: () => {}, openFind, shell: fakeShell() });
  expect(Object.keys(actions)).toEqual(expect.arrayContaining(["find", "replace"]));
  actions.find!();
  expect(openFind).toHaveBeenLastCalledWith(false);
  actions.replace!();
  expect(openFind).toHaveBeenLastCalledWith(true);
  // without the opener the commands stay disabled
  const without = buildActions({ editor, session, ui, setUi: () => {}, openPalette: () => {}, shell: fakeShell() });
  expect(without.find).toBeUndefined();
  expect(without.replace).toBeUndefined();
});
