<p align="center">
  <img src="app-icon.svg" width="88" alt="DocBro icon">
</p>

<h1 align="center">DocBro</h1>

<p align="center">
  A fast, native word processor for Word and Markdown files, with your AI built in.<br>
  macOS · Windows · Linux
</p>

<p align="center">
  <img src="docs/media/demo.gif" alt="Asking the Assistant to add a risks table: it reads the document, inserts the table, and the edit shows up live on the page">
</p>

DocBro opens `.docx` and `.md` files and edits them in a clean, paged editor. It also runs an MCP server, so Claude, Cursor, Codex and other AI tools can read and edit the document you have open. Every edit shows up on the page as it happens, and **each AI edit is a single undo step**, so ⌘Z takes back exactly what the AI did, never your own typing.

<p align="center">
  <a href="docs/media/docbro-teaser.mp4">
    <img src="docs/media/teaser-poster.jpg" width="720" alt="Watch the 43-second DocBro teaser">
  </a>
  <br>
  <sub><a href="docs/media/docbro-teaser.mp4">Watch the 43-second teaser</a></sub>
</p>

## Features

**Documents**

- Open `.docx` and `.md` files from the Open dialog, by dragging them onto the window, or with Finder's *Open With*. Save as `.docx`, or pick `.md` in *Save as…*
- A Word file keeps its page size, margins, headers and footers. If it holds parts DocBro can't keep yet, such as footnotes or tracked changes, saving over it first names those parts and asks before anything is lost.
- Pages laid out as sheets, with page breaks, headers, footers and page numbers
- Headings, lists, tables, images, links, quotes, dividers, text color, highlight, alignment and comments
- One document per window

**Editing**

- Slash menu: type `/` to insert a heading, list, table, image, page break and more
- A selection bubble for bold, italic, underline, headings, quotes, highlights and comments
- Command palette (⌘K) that searches every menu command
- Find and replace (⌘F, ⌥⌘F)
- An outline sidebar, plus word count, character count and reading time
- Focus mode, dark mode, larger text, and a serif or sans-serif body font

**AI**

- **Built-in MCP server.** AI clients connect over HTTP on `127.0.0.1`, or over stdio with `--mcp-stdio`, and get 11 document tools: `document_info`, `read_document`, `insert_content`, `replace_blocks`, `delete_blocks`, `find_replace`, `format_text`, `undo`, `redo`, `open_document` and `save_document`.
- **Assistant panel.** Chat with Claude about the document. It can use DocBro's document tools and the tools of any MCP server you add, whether HTTP or stdio.
- When another app's AI edits the document, its tool calls show up in the Assistant panel as "External" cards.

## Screenshots

| | |
|---|---|
| ![The editor with the outline, the page and the Assistant panel](docs/media/editor.png) | ![The Assistant added a risks table through the document tools](docs/media/assistant.png) |
| **Editor.** A Word file opened as laid out, with its header, table and outline | **Assistant.** Claude reads the brief and inserts a table, as one undo step |
| ![The slash menu listing blocks to insert](docs/media/slash-menu.png) | ![The selection bubble over selected text](docs/media/selection-bubble.png) |
| **Slash menu.** Type `/` to insert any block | **Selection bubble.** Format selected text or comment on it |
| ![The command palette filtered to "table"](docs/media/command-palette.png) | ![MCP settings with the API key, servers and the Serve DocBro switch](docs/media/mcp-settings.png) |
| **Command palette.** ⌘K searches every menu command | **MCP settings.** Model, your MCP servers, and DocBro's own server |
| ![The editor in dark mode](docs/media/dark.png) | |
| **Dark mode** | |

## Connect your AI tools

1. Open the Assistant panel (⌥⌘A) and click the gear to open **MCP settings**.
2. Turn on **Serve DocBro**. It listens on `http://127.0.0.1:7425/mcp` and requires a bearer token, which you can regenerate at any time.
3. Copy the ready-made snippet for your client: Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI, Codex CLI, or "Other". For Claude Code, the snippet looks like this:

   ```bash
   claude mcp add --transport http docbro http://127.0.0.1:7425/mcp --header "Authorization: Bearer <token>"
   ```

   Clients that run stdio servers start the DocBro app with `--mcp-stdio`. It relays to the running app and needs no token.

The server is off by default. It binds to `127.0.0.1` only, and refuses requests that carry an `Origin` header or the wrong `Host`.

## The Assistant

The Assistant answers through one of two engines:

- **Claude Code.** If the `claude` CLI is installed and you haven't saved an API key, the Assistant runs on Claude Code and uses your Claude subscription.
- **Anthropic API.** Paste an API key in MCP settings. The default model is `claude-sonnet-5-5`.

Settings live in your OS config folder under `com.jetorbit.docbro/`, readable only by you (file mode `0600` on macOS and Linux). The API key never reaches the window. The app shows only its last four characters, and the key never appears in logs or error messages.

## Build from source

You need [Rust](https://rustup.rs) (stable), Node.js 20.19+ or 22.12+, [pnpm](https://pnpm.io), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
pnpm tauri dev      # run the app with hot reload
pnpm tauri build    # build the .app and .dmg (or your OS's bundles)
```

To run the tests:

```bash
pnpm test                                       # TypeScript (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml # Rust core
```

## How it works

DocBro is a [Tauri 2](https://tauri.app) app. The Rust core owns the windows, menus, file I/O, the MCP server and the Assistant's chat loop. The document itself lives in the webview's editor ([TipTap](https://tiptap.dev) / ProseMirror), so typing stays local and instant. When an AI tool call arrives, Rust forwards it to the window that has the document open. The window runs it as one editor transaction (which is why it is one undo step) and sends the result back. `.docx` and Markdown conversion runs in TypeScript, next to the editor schema it has to match.

```
src/            React + TypeScript UI, the editor, .docx/.md conversion, MCP tool handlers
src-tauri/      Rust core: windows, files, MCP server and client, Assistant
video/          The Remotion project that renders the teaser
docs/           Design notes and plans
```

The teaser is made with [Remotion](https://www.remotion.dev). To re-render it, see [video/README.md](video/README.md).

## License

[MIT](LICENSE)
