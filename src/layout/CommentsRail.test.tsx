import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { CommentData } from "../doc/meta";
import { DocSession } from "../doc/session";
import { hoveredComment, liveComments } from "../editor/comment";
import { createHeadlessEditor } from "../editor/headless";
import { findMark } from "../formats/docx/testing";
import { CommentsRail } from "./CommentsRail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout: nothing is observed, and every card sits at the top
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
  unobserve() {}
} as unknown as typeof ResizeObserver;

let editor: Editor;
let session: DocSession;
let root: Root;
let host: HTMLElement;

const mark = (id: string) => [{ type: "comment", attrs: { id } }];
const COMMENTS: CommentData[] = [
  { id: "b", author: "Rina", date: "2026-10-01T09:00:00Z", text: "Add <b>numbers</b>." },
  { id: "a", author: "gilang", date: new Date().toISOString(), text: "", editing: true },
];

const render = () =>
  act(() =>
    root.render(
      <CommentsRail editor={editor} session={session} comments={liveComments(session.meta.comments, editor.state.doc)} userName="gilang" open />,
    ),
  );

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  editor = createHeadlessEditor({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "First", marks: mark("a") }, { type: "text", text: " and " }, { type: "text", text: "second", marks: mark("b") }] },
    ],
  });
  editor.mount(host.appendChild(document.createElement("div")));
  session = new DocSession(editor, { read: async () => new Uint8Array(), write: async () => {}, exists: async () => false, meta: () => {} });
  session.setMeta({ comments: COMMENTS });
  root = createRoot(host.appendChild(document.createElement("div")));
  render();
});

afterEach(() => {
  act(() => root.unmount());
  session.destroy();
  editor.destroy();
  host.remove();
});

const cards = () => [...host.querySelectorAll<HTMLElement>(".comment-card")];
const card = (who: string) => cards().find((c) => c.querySelector(".comment-who")!.textContent === who)!;
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
function type(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  act(() => void textarea.dispatchEvent(new Event("input", { bubbles: true })));
}

test("a_card_per_comment_in_the_order_of_the_text_with_its_author_and_plain_text", () => {
  expect(cards().map((c) => c.querySelector(".comment-who")!.textContent)).toEqual(["You", "Rina"]);
  expect(card("You").querySelector(".comment-avatar")!.textContent).toBe("Y");
  expect(card("You").querySelector(".comment-time")!.textContent).toBe("now");
  const text = card("Rina").querySelector(".comment-text")!;
  expect(text.textContent).toBe("Add <b>numbers</b>.");
  expect(text.querySelector("b")).toBeNull();
  // the new comment's text box has the focus
  expect(document.activeElement).toBe(card("You").querySelector("textarea"));
});

test("typing_then_post_keeps_the_text_and_post_with_nothing_written_takes_the_comment_away", () => {
  type(card("You").querySelector("textarea")!, "Looks good");
  expect(session.meta.comments.find((c) => c.id === "a")).toMatchObject({ text: "Looks good", editing: true });
  click(card("You").querySelector(".comment-post")!);
  expect(session.meta.comments.find((c) => c.id === "a")).toMatchObject({ text: "Looks good", editing: false });
  render();
  expect(card("You").querySelector(".comment-text")!.textContent).toBe("Looks good");

  session.setMeta({ comments: session.meta.comments.map((c) => (c.id === "a" ? { ...c, text: " ", editing: true } : c)) });
  render();
  click(card("You").querySelector(".comment-post")!);
  expect(liveComments(session.meta.comments, editor.state.doc).map((c) => c.id)).toEqual(["b"]);
});

test("resolve_takes_the_mark_off_and_hovering_a_card_lights_its_text", () => {
  act(() => void card("Rina").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(hoveredComment(editor.state)).toBe("b");
  render();
  expect(card("Rina").classList).toContain("lit");
  expect(editor.view.dom.querySelector(".comment-hover")!.textContent).toBe("second");
  act(() => void card("Rina").dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  expect(hoveredComment(editor.state)).toBeNull();

  click(card("Rina").querySelector(".comment-resolve")!);
  expect(findMark(editor.getJSON(), "comment")!.attrs!.id).toBe("a");
  render();
  expect(cards()).toHaveLength(1);
});
