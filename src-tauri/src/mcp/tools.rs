//! The document tools DocBro serves: their names and the schemas MCP clients (and the Assistant's model) see.
//! The webview runs them (src/mcp/tools.ts).

use serde_json::{json, Value};

/// The tools the webview runs (`TOOL_NAMES` in src/mcp/tools.ts, same order; names.test.ts
/// checks it). Anything else is refused here, before it reaches the window.
pub(crate) const TOOL_NAMES: [&str; 13] = [
    "document_info",
    "read_document",
    "insert_content",
    "replace_blocks",
    "delete_blocks",
    "find_replace",
    "format_text",
    "list_comments",
    "add_comment",
    "undo",
    "redo",
    "open_document",
    "save_document",
];

enum Hint {
    Read,
    /// changes the document but loses nothing that undo cannot bring back
    Safe,
    Destructive,
}

fn tool(name: &str, title: &str, description: &str, props: Value, required: &[&str], hint: Hint) -> Value {
    let (read_only, destructive) = match hint {
        Hint::Read => (true, false),
        Hint::Safe => (false, false),
        Hint::Destructive => (false, true),
    };
    json!({
        "name": name,
        "title": title,
        "description": description,
        // the webview refuses arguments it does not know, so a misspelt one is never ignored
        "inputSchema": { "type": "object", "properties": props, "required": required, "additionalProperties": false },
        "annotations": {
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "openWorldHint": false,
        },
    })
}

/// The tool list sent to MCP clients (and, from Task 16, to the assistant's model).
pub(crate) fn tool_defs() -> Vec<Value> {
    let block = |what: &str| json!({ "type": "integer", "minimum": 1, "description": what });
    let flag = |what: &str| json!({ "type": "boolean", "description": what });
    let color = |what: &str| {
        json!({
            "type": ["string", "null"],
            "pattern": "^#[0-9a-fA-F]{6}$",
            "description": format!("{what} as \"#rrggbb\", or null to remove it."),
        })
    };
    let from = block("First block, counting from 1.");
    let to = block("Last block (inclusive). Defaults to from.");
    let markdown = json!({ "type": "string", "description": "Markdown: headings, paragraphs, lists, quotes, tables, links, bold, italic." });
    vec![
        tool(
            "document_info",
            "Document info",
            "Name, path, format (docx or md), unsaved-changes flag, block, word, character and comment \
             counts and outline (headings with their block numbers) of the document open in DocBro, as \
             JSON. `dropped` lists parts of the file DocBro cannot keep. Call this first.",
            json!({}),
            &[],
            Hint::Read,
        ),
        tool(
            "read_document",
            "Read document",
            "Reads blocks from..to as Markdown, each starting with [n], its block number. Blocks are the \
             document's top-level paragraphs, headings, lists, quotes, tables, images and dividers, \
             numbered from 1; a whole list or table is one block. A long document comes in pages: the end \
             of the text says where to go on.",
            json!({
                "from": block("First block to read, counting from 1. Defaults to 1."),
                "to": block("Last block to read (inclusive). Defaults to the last block."),
            }),
            &[],
            Hint::Read,
        ),
        tool(
            "insert_content",
            "Insert content",
            "Inserts Markdown as new top-level blocks before or after a block (give one of them), or at \
             the end when neither is given. It works on top-level blocks only: it cannot go inside a list \
             or a table cell, so replace the whole list or table instead. One undo step.",
            json!({
                "markdown": markdown,
                "before": block("Insert before this block."),
                "after": block("Insert after this block."),
            }),
            &["markdown"],
            Hint::Safe,
        ),
        tool(
            "replace_blocks",
            "Replace blocks",
            "Replaces top-level blocks from..to with Markdown. A whole list or table is one block, so this \
             is how to change inside one. One undo step.",
            json!({ "from": from, "to": to, "markdown": markdown }),
            &["from", "markdown"],
            Hint::Destructive,
        ),
        tool(
            "delete_blocks",
            "Delete blocks",
            "Deletes top-level blocks from..to. One undo step.",
            json!({ "from": from, "to": to }),
            &["from"],
            Hint::Destructive,
        ),
        tool(
            "find_replace",
            "Find and replace",
            "Replaces every occurrence of the literal text `find` with `replace`, optionally only in blocks \
             from..to. Case sensitive unless case_sensitive is false. A match never crosses from one \
             paragraph into the next. Reports how many were replaced (0 is not an error). One undo step.",
            json!({
                "find": { "type": "string", "description": "Text to look for (not a pattern)." },
                "replace": { "type": "string", "description": "Text to put in its place." },
                "case_sensitive": flag("Match upper and lower case exactly. Defaults to true."),
                "from": block("First block to search. Defaults to 1."),
                "to": block("Last block to search (inclusive). Defaults to the last block."),
            }),
            &["find", "replace"],
            Hint::Safe,
        ),
        tool(
            "format_text",
            "Format text",
            "Formats top-level blocks from..to. Pass only what should change, at least one option. With \
             `text`, bold, italic, underline, strike, color, highlight and link go on the occurrences of \
             that text only; style, align and list always apply to whole paragraphs and headings. One \
             undo step.",
            json!({
                "from": from,
                "to": to,
                "text": { "type": "string", "description": "Only format the occurrences of this text (case sensitive)." },
                "bold": flag("Bold on or off."),
                "italic": flag("Italic on or off."),
                "underline": flag("Underline on or off."),
                "strike": flag("Strikethrough on or off."),
                "color": color("Text color"),
                "highlight": color("Highlight color"),
                "link": { "type": ["string", "null"], "description": "An http, https or mailto URL, or null to remove the link." },
                "style": { "type": "string", "enum": ["body", "heading1", "heading2", "heading3", "quote"], "description": "Paragraph style." },
                "align": { "type": ["string", "null"], "enum": ["left", "center", "right", "justify", null], "description": "Alignment, or null for the default." },
                "list": { "type": "string", "enum": ["bullet", "numbered", "none"], "description": "Make the blocks a list, or none to take a list apart." },
            }),
            &["from"],
            Hint::Safe,
        ),
        tool(
            "list_comments",
            "List comments",
            "The document's comments, in the order they come in the text, as a JSON array of \
             { id, author, date, text, quote }: quote is the text the comment is on.",
            json!({}),
            &[],
            Hint::Read,
        ),
        tool(
            "add_comment",
            "Add comment",
            "Adds a comment, by \"AI\", on top-level block `block`: on the first occurrence of `text` in \
             it (case sensitive) when given, else on the whole block. The user sees it beside the page \
             and can resolve it. One undo step.",
            json!({
                "block": block("The block the comment is on, counting from 1."),
                "text": { "type": "string", "description": "Only comment on this text in the block (case sensitive)." },
                "comment": { "type": "string", "description": "The comment, as plain text." },
            }),
            &["block", "comment"],
            Hint::Safe,
        ),
        tool("undo", "Undo", "Undoes the last change, the user's or an AI's. Each edit tool call is one step.", json!({}), &[], Hint::Safe),
        tool("redo", "Redo", "Redoes the last undone change.", json!({}), &[], Hint::Safe),
        tool(
            "open_document",
            "Open file",
            "Opens a .docx or .md file in DocBro, replacing the current document. Refused while the \
             document has unsaved changes unless discard is true, so ask the user before setting that.",
            json!({
                "path": { "type": "string", "description": "Absolute path of a .docx or .md file." },
                "discard": flag("Throw away unsaved changes in the current document."),
            }),
            &["path"],
            Hint::Destructive,
        ),
        tool(
            "save_document",
            "Save file",
            "Saves the document. Without `path` it saves to the file it was opened from. With `path` it \
             saves there and refuses to replace another file unless overwrite is true. Refuses when the \
             file would lose parts DocBro cannot keep, unless accept_loss is true.",
            json!({
                "path": { "type": "string", "description": "Absolute target path ending in .docx or .md." },
                "overwrite": flag("Allow replacing an existing file at `path`."),
                "accept_loss": flag("Save even though the file will lose parts DocBro cannot keep."),
            }),
            &[],
            Hint::Destructive,
        ),
    ]
}
