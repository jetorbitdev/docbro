import { Mark } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { CommentData } from "../doc/meta";

/**
 * A comment on a stretch of text: the mark holds only the comment's id, and `DocMeta.comments` its author, date and
 * text. The mark is in the undo history and the entry is not, so the entry follows the mark: a comment is part of the
 * document while some text carries its mark, and an entry whose mark is gone (resolved, undone, deleted) is not.
 * Typing at its end does not extend it. Comments can overlap, so a text can carry several.
 */
export const CommentMark = Mark.create({
  name: "comment",
  inclusive: false,
  excludes: "",

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-c"),
        renderHTML: (attributes: Record<string, unknown>) => (attributes.id ? { "data-c": attributes.id } : {}),
      },
    };
  },

  // ahead of the highlight's plain `mark`
  parseHTML() {
    return [{ tag: "mark[data-c]", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["mark", HTMLAttributes, 0];
  },

  addProseMirrorPlugins() {
    return [commentPlugin()];
  },
});

export interface CommentRange {
  /** The first and the last marked character's positions: a comment can run across blocks. */
  from: number;
  to: number;
}

export type LiveComment = CommentData & CommentRange;

/** Where each comment's marked text is, by id, in the order the comments start in the document. */
export function commentRanges(doc: PMNode): Map<string, CommentRange> {
  const ranges = new Map<string, CommentRange>();
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== "comment" || typeof mark.attrs.id !== "string") continue;
      const range = ranges.get(mark.attrs.id);
      if (range) range.to = pos + node.nodeSize;
      else ranges.set(mark.attrs.id, { from: pos, to: pos + node.nodeSize });
    }
    return false;
  });
  return ranges;
}

/** The ids of the comments some text in `doc` carries. */
export const commentIds = (doc: PMNode): Set<string> => new Set(commentRanges(doc).keys());

/** The comments that are part of the document: those whose mark is in it, in the order they start. */
export function liveComments(comments: CommentData[], doc: PMNode): LiveComment[] {
  if (!comments.length) return [];
  const ranges = commentRanges(doc);
  return comments
    .flatMap((comment) => {
      const range = ranges.get(comment.id);
      return range ? [{ ...comment, ...range }] : [];
    })
    .sort((a, b) => a.from - b.from);
}

// ------------------------------------------------------------------ hover and flash

interface HoverState {
  id: string | null;
  decorations: DecorationSet;
}

/** The comment whose text is lit up: its card is hovered, or its text was just clicked. */
export const commentHoverKey = new PluginKey<HoverState>("docbroCommentHover");

export const hoveredComment = (state: EditorState): string | null => commentHoverKey.getState(state)?.id ?? null;

/** Lights up the text of comment `id`, or none. Nothing in the document changes. */
export const setHoveredComment = (view: EditorView, id: string | null) => {
  if (view.isDestroyed || hoveredComment(view.state) === id) return;
  view.dispatch(view.state.tr.setMeta(commentHoverKey, id).setMeta("addToHistory", false));
};

// How long a click on commented text lights its card up (mock 739).
const FLASH_MS = 900;

function lit(doc: PMNode, id: string | null): DecorationSet {
  if (!id) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    if (node.marks.some((m) => m.type.name === "comment" && m.attrs.id === id))
      decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: "comment-hover" }));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

// Takes off the comments `taken` names.
function withoutComments(fragment: Fragment, taken: (id: unknown) => boolean): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    const marks = node.marks.filter((m) => m.type.name !== "comment" || !taken(m.attrs.id));
    nodes.push(node.isLeaf ? node.mark(marks) : node.copy(withoutComments(node.content, taken)).mark(marks));
  });
  return Fragment.from(nodes);
}

// A pasted copy is text of its own: a comment still on its original stays there, so an id is on one stretch of text.
// Text that was cut, or dragged to move it, takes its comments along.
function pastedComments(slice: Slice, view: EditorView): Slice {
  if ((view.dragging as { move?: boolean } | null)?.move) return slice;
  const live = commentIds(view.state.doc);
  if (!live.size) return slice;
  return new Slice(withoutComments(slice.content, (id) => typeof id === "string" && live.has(id)), slice.openStart, slice.openEnd);
}

function commentPlugin(): Plugin {
  return new Plugin<HoverState>({
    key: commentHoverKey,
    state: {
      init: () => ({ id: null, decorations: DecorationSet.empty }),
      apply(tr, value): HoverState {
        const asked = tr.getMeta(commentHoverKey) as string | null | undefined;
        if (asked !== undefined) return { id: asked, decorations: lit(tr.doc, asked) };
        if (!tr.docChanged || !value.id) return value;
        return { id: value.id, decorations: lit(tr.doc, value.id) };
      },
    },
    props: {
      decorations: (state) => commentHoverKey.getState(state)?.decorations,
      handleClick(view, _pos, event) {
        const id = (event.target as Element | null)?.closest?.("mark[data-c]")?.getAttribute("data-c");
        if (!id) return false;
        setHoveredComment(view, id);
        window.setTimeout(() => {
          if (!view.isDestroyed && hoveredComment(view.state) === id) setHoveredComment(view, null);
        }, FLASH_MS);
        return false; // the click still puts the caret there
      },
      transformPasted: pastedComments,
    },
  });
}
