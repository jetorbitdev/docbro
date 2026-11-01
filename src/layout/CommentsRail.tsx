import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { DocSession } from "../doc/session";
import { hoveredComment, setHoveredComment, type LiveComment } from "../editor/comment";
import { layoutCards, relativeTime, resolveComment } from "./comments";

interface Props {
  editor: Editor;
  session: DocSession;
  /** The document's comments, in the order they start (editor/comment.ts `liveComments`). */
  comments: LiveComment[];
  /** The person at this computer: their comments read "You". */
  userName: string;
  /** The rail is showing. It stays mounted while it is not. */
  open: boolean;
}

// How often "now" becomes "1m".
const CLOCK_MS = 60_000;

// The avatar: the person's own comments in the accent, the others in one of the mock's two tints, the same for one name.
function byline(author: string, userName: string) {
  if (author === userName) return { who: "You", initial: "Y", tint: "you" };
  const who = author.trim() || "Author";
  const sum = [...who].reduce((n, ch) => n + ch.codePointAt(0)!, 0);
  return { who, initial: [...who][0].toUpperCase(), tint: sum % 2 ? "amber" : "blue" };
}

const sameTops = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((id) => a[id] === b[id]);

/**
 * Mock 184–205: a card beside each comment's text, with its author, how long ago, Resolve, and while it is new a
 * text box and Post. Hovering a card lights up its text, and clicking the text lights up its card (editor/comment.ts).
 * Comment text, from a file or an AI tool, is shown as plain text.
 */
export function CommentsRail({ editor, session, comments, userName, open }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const fields = useRef(new Map<string, HTMLTextAreaElement>());
  const focused = useRef(new Set<string>());
  const [tops, setTops] = useState<Record<string, number>>({});
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const hovered = useEditorState({ editor, selector: ({ editor }) => hoveredComment(editor.state) });

  // Each card level with its text, below the one above when they would overlap. The text moves when the page
  // reflows (typing, pictures loading, the window), so this runs after every render, and a resize redraws.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !open || editor.isDestroyed) return;
    const origin = el.getBoundingClientRect().top;
    const anchors = comments.map((c) => {
      let top = 0;
      try {
        top = editor.view.coordsAtPos(c.from, 1).top - origin;
      } catch {
        // a position the view has not drawn yet: placed at the top until the next layout
      }
      return { id: c.id, top, editing: !!c.editing, height: cards.current.get(c.id)?.offsetHeight || undefined };
    });
    const next = layoutCards(anchors);
    setTops((prev) => (sameTops(prev, next) ? prev : next));
  });

  useEffect(() => {
    if (!open || editor.isDestroyed) return;
    const observer = new ResizeObserver(() => redraw());
    observer.observe(editor.view.dom);
    if (box.current) observer.observe(box.current);
    const clock = window.setInterval(redraw, CLOCK_MS);
    return () => {
      observer.disconnect();
      window.clearInterval(clock);
    };
  }, [editor, open]);

  // a new comment's text box takes the focus once its card is in place
  useEffect(() => {
    for (const c of comments) {
      if (!c.editing || tops[c.id] === undefined || focused.current.has(c.id)) continue;
      focused.current.add(c.id);
      fields.current.get(c.id)?.focus();
    }
  }, [comments, tops]);

  // the hovered card's text stays lit only while the card is there
  useEffect(() => () => void (!editor.isDestroyed && setHoveredComment(editor.view, null)), [editor]);

  const update = (id: string, patch: { text?: string; editing?: boolean }) =>
    session.setMeta({ comments: session.meta.comments.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  // Post with nothing written takes the comment away again, as in the mock
  const post = (id: string) => {
    if (!session.meta.comments.find((c) => c.id === id)?.text.trim()) resolveComment(editor, session, id);
    else update(id, { editing: false });
    editor.commands.focus();
  };

  return (
    <div className="comments-cards" ref={box}>
      {comments.map((c) => {
        const { who, initial, tint } = byline(c.author, userName);
        const top = tops[c.id];
        return (
          <div
            key={c.id}
            ref={(el) => void (el ? cards.current.set(c.id, el) : cards.current.delete(c.id))}
            className={`comment-card${hovered === c.id ? " lit" : ""}${top === undefined ? " unplaced" : ""}`}
            style={{ top: top ?? 0 }}
            onMouseEnter={() => setHoveredComment(editor.view, c.id)}
            onMouseLeave={() => setHoveredComment(editor.view, null)}
          >
            <div className="comment-head">
              <span className={`comment-avatar ${tint}`} aria-hidden>
                {initial}
              </span>
              <span className="comment-who">{who}</span>
              <span className="comment-time">{relativeTime(c.date)}</span>
              <button className="comment-resolve" title="Resolve" onClick={() => resolveComment(editor, session, c.id)}>
                Resolve
              </button>
            </div>
            {c.editing ? (
              <>
                <textarea
                  ref={(el) => void (el ? fields.current.set(c.id, el) : fields.current.delete(c.id))}
                  value={c.text}
                  onChange={(e) => update(c.id, { text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      post(c.id);
                    }
                  }}
                  placeholder="Add a comment"
                  aria-label="Comment"
                  rows={3}
                />
                <button className="comment-post" onClick={() => post(c.id)}>
                  Post
                </button>
              </>
            ) : (
              <p className="comment-text">{c.text}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
