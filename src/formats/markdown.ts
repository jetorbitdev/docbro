import { type Editor, Extension, type JSONContent } from "@tiptap/core";
import { Fragment, type NodeType, type Schema } from "@tiptap/pm/model";
import { createHeadlessEditor } from "../editor/headless";

// The schema has no code block and no inline code mark. Without a handler the
// Markdown package silently drops both, so register ones that keep the text.
const codeBlockAsParagraphs = Extension.create({
  name: "codeBlockAsParagraphs",
  markdownTokenName: "code",
  parseMarkdown: (token, helpers) =>
    String(token.text ?? "")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => helpers.createNode("paragraph", {}, [helpers.createTextNode(line)])),
});

const inlineCodeAsText = Extension.create({
  name: "inlineCodeAsText",
  markdownTokenName: "codespan",
  parseMarkdown: (token, helpers) => helpers.createTextNode(String(token.text ?? "")),
});

let converter: Editor | undefined;

function getConverter(): Editor {
  if (!converter) {
    converter = createHeadlessEditor();
    converter.markdown!.registerExtension(codeBlockAsParagraphs);
    converter.markdown!.registerExtension(inlineCodeAsText);
  }
  return converter;
}

export function markdownToDoc(md: string): JSONContent {
  const editor = getConverter();
  return conform(editor.schema, editor.markdown!.parse(md))[0];
}

export function docToMarkdown(doc: JSONContent): string {
  return getConverter().markdown!.serialize(doc);
}

// The parser can return nodes the schema does not allow where they sit (an
// image inside a paragraph, a bare text node in a list item, a level 4
// heading). Rewrite the tree so that every node's content is valid.
function conform(schema: Schema, node: JSONContent): JSONContent[] {
  const type = schema.nodes[node.type!];
  if (!type) return (node.content ?? []).flatMap((kid) => conform(schema, kid));
  if (node.type === "heading") {
    const level = node.attrs?.level;
    if (!(level >= 1 && level <= 3)) return conform(schema, { type: "paragraph", content: node.content });
  }
  if (type.isLeaf) return [node];

  const kids = (node.content ?? []).flatMap((kid) => conform(schema, kid));
  return type.inlineContent ? hoistBlocks(schema, node, kids) : [{ ...node, content: fit(schema, type, kids) }];
}

const isInline = (schema: Schema, node: JSONContent) => schema.nodes[node.type!].isInline;

// Gather each run of consecutive inline nodes in `kids` into one node made by `wrap`.
function groupInline(schema: Schema, kids: JSONContent[], wrap: (run: JSONContent[]) => JSONContent): JSONContent[] {
  const out: JSONContent[] = [];
  let run: JSONContent[] = [];
  const flush = () => {
    if (run.length) out.push(wrap(run));
    run = [];
  };
  for (const kid of kids) {
    if (isInline(schema, kid)) run.push(kid);
    else {
      flush();
      out.push(kid);
    }
  }
  flush();
  return out;
}

// A text block cannot hold block children, so they move out beside it.
function hoistBlocks(schema: Schema, node: JSONContent, kids: JSONContent[]): JSONContent[] {
  const out = groupInline(schema, kids, (run) => ({ ...node, content: run }));
  return out.length ? out : [{ ...node, content: [] }];
}

// Make `kids` valid content for a block container: wrap loose inline nodes in
// a paragraph, add the nodes its content rules require, drop what cannot fit.
function fit(schema: Schema, type: NodeType, kids: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  let match = type.contentMatch;
  const add = (fill: Fragment) => {
    out.push(...(fill.toJSON() ?? []));
    match = match.matchFragment(fill)!;
  };
  for (const block of groupInline(schema, kids, (run) => ({ type: "paragraph", content: run }))) {
    const blockType = schema.nodes[block.type!];
    if (!match.matchType(blockType)) {
      const fill = match.fillBefore(Fragment.from(blockType.create()), false);
      if (!fill) continue;
      add(fill);
    }
    out.push(block);
    match = match.matchType(blockType)!;
  }
  const end = match.fillBefore(Fragment.empty, true);
  if (end) add(end);
  return out;
}
