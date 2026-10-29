import type { ChainedCommands, Editor } from "@tiptap/core";
import type { DocSession } from "./doc/session";
import { toggleOutline, viewportLayout, type UiState } from "./layout/viewport";
import { currentTheme, toggleTheme } from "./theme";

export type Group = "File" | "Edit" | "View" | "Insert" | "Format";

export const GROUPS: Group[] = ["File", "Edit", "View", "Insert", "Format"];

export interface Command {
  id: string;
  group: Group;
  icon: string;
  label: string;
  /** The shortcut as macOS writes it, e.g. "⇧⌘Z"; `platformKeys` turns it into "Ctrl+Shift+Z" elsewhere. */
  keys: string;
  /** "On" for a toggle that is on, else "". */
  state: string;
  /** False while nothing provides the command's action yet: it is drawn dimmed and does nothing. */
  enabled: boolean;
  run(): void;
}

type ActionKey =
  | "newWindow" | "open" | "save" | "saveAs" | "print" | "find" | "replace" | "palette" | "insertImage"
  | "insertLink" | "pickColor" | "addComment" | "toggleHeader" | "toggleFooter" | "togglePageNumbers";

export interface CommandHost {
  editor: Editor;
  session: DocSession;
  ui: UiState;
  setUi(patch: Partial<UiState>): void;
  actions: Partial<Record<ActionKey, () => void>>;
}

/** Every command id, shared with the native menu (src-tauri/src/lib.rs) and its `menu` event. */
export const COMMAND_IDS: string[] = [
  "new", "open", "save", "save_as", "print",
  "undo", "redo", "clear_format", "find", "replace", "select_all",
  "focus", "outline", "comments", "assistant", "dark_mode", "larger_text", "sans_font", "palette",
  "table", "image", "link", "divider", "comment", "header", "footer", "page_numbers",
  "text", "h1", "h2", "h3", "quote", "ul", "ol",
  "bold", "italic", "underline", "strike", "highlight", "color",
  "align_left", "align_center", "align_right", "align_justify",
];

export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** The menus, the palette and the native menu all run these. Icons, labels and keys follow mock 392–421, else the native menu. */
export function buildCommands(host: CommandHost): Command[] {
  const { editor, session, ui, setUi, actions } = host;
  const layout = viewportLayout(window.innerWidth, ui);
  const meta = session.meta;

  const cmd = (id: string, group: Group, icon: string, label: string, keys: string, run: (() => void) | undefined, on = false): Command => ({
    id, group, icon, label, keys, state: on ? "On" : "", enabled: !!run, run: () => run?.(),
  });
  // Editor commands focus the editor first, which brings back the selection a menu or the palette took focus from.
  const edit = (fn: (c: ChainedCommands) => ChainedCommands) => () => void fn(editor.chain().focus()).run();
  const flip = (key: keyof UiState) => () => setUi({ [key]: !ui[key] });

  return [
    cmd("new", "File", "□", "New", "⌘N", actions.newWindow),
    cmd("open", "File", "↥", "Open…", "⌘O", actions.open),
    cmd("save", "File", "↓", "Save", "⌘S", actions.save),
    cmd("save_as", "File", "⇣", "Save as…", "⇧⌘S", actions.saveAs),
    cmd("print", "File", "⎙", "Print…", "⌘P", actions.print),

    cmd("undo", "Edit", "↶", "Undo", "⌘Z", edit((c) => c.undo())),
    cmd("redo", "Edit", "↷", "Redo", "⇧⌘Z", edit((c) => c.redo())),
    cmd("select_all", "Edit", "▢", "Select all", "⌘A", edit((c) => c.selectAll())),
    cmd("clear_format", "Edit", "⌫", "Clear formatting", "⌘\\", edit((c) => c.unsetAllMarks())),
    cmd("find", "Edit", "⌕", "Find…", "⌘F", actions.find),
    cmd("replace", "Edit", "⇄", "Find and replace…", "⌥⌘F", actions.replace),

    cmd("focus", "View", "◎", "Focus mode", "", flip("focus"), ui.focus),
    cmd("outline", "View", "☰", "Show outline", "", () => setUi(toggleOutline(layout.showOutline)), layout.showOutline),
    cmd("comments", "View", "✎", "Show comments", "", flip("hideComments"), !ui.hideComments),
    cmd("assistant", "View", "✦", "Assistant (MCP)", "⌥⌘A", flip("assistantOpen"), ui.assistantOpen),
    // the theme lives on <html>, not in `ui`: an empty patch re-renders the menus with the new state
    cmd("dark_mode", "View", "◐", "Dark mode", "", () => (toggleTheme(), setUi({})), currentTheme() === "dark"),
    cmd("larger_text", "View", "A", "Larger text", "", flip("largerText"), ui.largerText),
    cmd("sans_font", "View", "a", "Sans-serif body", "", flip("sansFont"), ui.sansFont),
    cmd("palette", "View", "›", "Command palette…", "⌘K", actions.palette),

    cmd("table", "Insert", "▦", "Table", "", edit((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))),
    cmd("image", "Insert", "▣", "Image…", "", actions.insertImage),
    cmd("link", "Insert", "↗", "Link…", "⇧⌘K", actions.insertLink),
    cmd("divider", "Insert", "—", "Divider", "", edit((c) => c.setHorizontalRule())),
    cmd("comment", "Insert", "✎", "Comment on selection", "⌥⌘M", actions.addComment),
    cmd("header", "Insert", "▔", "Header", "", actions.toggleHeader, meta.header !== null),
    cmd("footer", "Insert", "▁", "Footer", "", actions.toggleFooter, meta.footer !== null),
    cmd("page_numbers", "Insert", "#", "Page numbers", "", actions.togglePageNumbers, meta.pageNumbers),

    cmd("text", "Format", "T", "Normal text", "⌥⌘0", edit((c) => c.setParagraph())),
    cmd("h1", "Format", "H1", "Heading 1", "⌥⌘1", edit((c) => c.setHeading({ level: 1 }))),
    cmd("h2", "Format", "H2", "Heading 2", "⌥⌘2", edit((c) => c.setHeading({ level: 2 }))),
    cmd("h3", "Format", "H3", "Heading 3", "⌥⌘3", edit((c) => c.setHeading({ level: 3 }))),
    cmd("quote", "Format", "“", "Quote", "", edit((c) => c.toggleBlockquote())),
    cmd("ul", "Format", "•", "Bulleted list", "⇧⌘8", edit((c) => c.toggleBulletList())),
    cmd("ol", "Format", "1.", "Numbered list", "⇧⌘7", edit((c) => c.toggleOrderedList())),
    cmd("bold", "Format", "B", "Bold", "⌘B", edit((c) => c.toggleBold())),
    cmd("italic", "Format", "I", "Italic", "⌘I", edit((c) => c.toggleItalic())),
    cmd("underline", "Format", "U", "Underline", "⌘U", edit((c) => c.toggleUnderline())),
    cmd("strike", "Format", "S", "Strikethrough", "⇧⌘X", edit((c) => c.toggleStrike())),
    cmd("highlight", "Format", "▮", "Highlight", "", edit((c) => c.toggleHighlight())),
    cmd("color", "Format", "●", "Text color…", "", actions.pickColor),
    cmd("align_left", "Format", "⇤", "Align left", "", edit((c) => c.setTextAlign("left"))),
    cmd("align_center", "Format", "↔", "Align center", "", edit((c) => c.setTextAlign("center"))),
    cmd("align_right", "Format", "⇥", "Align right", "", edit((c) => c.setTextAlign("right"))),
    cmd("align_justify", "Format", "≡", "Justify", "", edit((c) => c.setTextAlign("justify"))),
  ];
}

/** The palette's search: `label + " " + group`, any case, within one group unless "All". */
export function filterCommands(cmds: Command[], query: string, group: Group | "All"): Command[] {
  const q = query.toLowerCase().trim();
  return cmds.filter(
    (c) => (group === "All" || c.group === group) && (!q || `${c.label} ${c.group}`.toLowerCase().includes(q)),
  );
}

/** A shortcut as this OS writes it: "⇧⌘Z" on macOS, "Ctrl+Shift+Z" elsewhere. */
export function platformKeys(keys: string, mac = IS_MAC): string {
  if (mac || !keys) return keys;
  const key = keys.replace(/[⌃⌥⇧⌘]/g, "");
  const mods = [keys.includes("⌘") && "Ctrl", keys.includes("⌥") && "Alt", keys.includes("⇧") && "Shift"];
  return [...mods.filter(Boolean), key].join("+");
}
