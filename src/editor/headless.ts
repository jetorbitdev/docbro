import { Editor, type JSONContent } from "@tiptap/core";
import { createExtensions } from "./extensions";

// An editor with no view: the same schema and commands, no DOM.
export function createHeadlessEditor(content?: JSONContent): Editor {
  return new Editor({ element: undefined, extensions: createExtensions(), content });
}
