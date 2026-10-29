import { getExtensionField, getSchemaTypeByName, type AnyConfig } from "@tiptap/core";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createHeadlessEditor } from "./headless";

// "Mod-Shift-z" and "CmdOrCtrl+Shift+Z" both become "mod+shift+z". Ctrl and Cmd count as Mod:
// off macOS they are the same key, which is where both handlers can see one press.
function normalize(combo: string, sep: string): string {
  const parts = combo.split(sep);
  const key = parts.pop()!.toLowerCase();
  const mods = parts.map((m) => {
    const lower = m.toLowerCase();
    return ["mod", "cmd", "ctrl", "control", "meta", "cmdorctrl", "commandorcontrol"].includes(lower) ? "mod" : lower;
  });
  return [...new Set(mods)].sort().concat(key).join("+");
}

/** Every key the editor binds, from each extension's `addKeyboardShortcuts`. */
function editorShortcuts(): Set<string> {
  const editor = createHeadlessEditor();
  const keys = new Set<string>();
  for (const ext of editor.extensionManager.extensions) {
    const add = getExtensionField<AnyConfig["addKeyboardShortcuts"]>(ext, "addKeyboardShortcuts", {
      name: ext.name,
      options: ext.options,
      storage: editor.extensionStorage[ext.name as keyof typeof editor.extensionStorage],
      editor,
      type: getSchemaTypeByName(ext.name, editor.schema),
    });
    for (const combo of Object.keys(add?.() ?? {})) keys.add(normalize(combo, "-"));
  }
  editor.destroy();
  return keys;
}

/** The native menu's accelerators, by command id. */
function menuAccelerators(): Map<string, string> {
  const rust = readFileSync("src-tauri/src/lib.rs", "utf8");
  return new Map([...rust.matchAll(/item\("([a-z0-9_]+)", "[^"]*", "([^"]+)"\)/g)].map((m) => [normalize(m[2], "+"), m[1]]));
}

// Shortcuts the editor and the native menu both define on purpose: the menu item runs the same command.
const SHARED = [
  "mod+b", "mod+i", "mod+u", "mod+shift+x", // bold, italic, underline, strike
  "mod+z", "mod+shift+z", // undo, redo
  "alt+mod+0", "alt+mod+1", "alt+mod+2", "alt+mod+3", // text, heading 1–3
  "mod+shift+7", "mod+shift+8", // numbered, bulleted list
];

test("no_editor_shortcut_collides_with_a_different_menu_command", () => {
  const editor = editorShortcuts();
  const menu = menuAccelerators();
  expect(menu.size).toBeGreaterThan(20);
  const clashes = [...menu].filter(([combo]) => editor.has(combo) && !SHARED.includes(combo)).map(([combo, id]) => `${combo} (${id})`);
  expect(clashes).toEqual([]);
});

test("the_shared_shortcuts_are_still_bound_on_both_sides", () => {
  const editor = editorShortcuts();
  const menu = menuAccelerators();
  expect(SHARED.filter((combo) => !editor.has(combo) || !menu.has(combo))).toEqual([]);
});

test("strike_is_shift_mod_x_and_save_as_keeps_shift_mod_s", () => {
  const editor = createHeadlessEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Word" }] }] });
  editor.mount(document.createElement("div"));
  editor.commands.setTextSelection({ from: 1, to: 5 });
  // ProseMirror reads Mod as Cmd on macOS and Ctrl elsewhere
  const mac = /Mac/.test(navigator.platform);
  const press = (key: string) =>
    editor.view.someProp("handleKeyDown", (f) =>
      f(editor.view, new KeyboardEvent("keydown", { key, metaKey: mac, ctrlKey: !mac, shiftKey: true })),
    );
  press("s");
  expect(editor.isActive("strike")).toBe(false);
  press("x");
  expect(editor.isActive("strike")).toBe(true);
  editor.destroy();
});
