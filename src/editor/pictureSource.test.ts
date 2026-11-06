import type { Editor, JSONContent } from "@tiptap/core";
import { DOMParser as PMParser, DOMSerializer } from "@tiptap/pm/model";
import { afterEach, expect, test } from "vitest";
import { createHeadlessEditor } from "./headless";
import { loadsInPage } from "./pictureSource";

const REMOTE = "https://tracker.example/p.png?d=the%20secret%20text";
const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

const image = (src: string, alt: string | null = null, extra: object = {}): JSONContent => ({ type: "image", attrs: { src, alt, ...extra } });

let editors: Editor[] = [];
function make(...content: JSONContent[]): Editor {
  const editor = createHeadlessEditor({ type: "doc", content });
  editor.mount(document.body.appendChild(document.createElement("div")));
  editors.push(editor);
  return editor;
}
afterEach(() => {
  editors.forEach((e) => (e.view.dom.parentElement?.remove(), e.destroy()));
  editors = [];
});

const dom = (editor: Editor) => editor.view.dom;

test("a_picture_from_the_web_is_not_loaded_and_shows_its_alt_text_and_its_address", () => {
  const editor = make(image(REMOTE, "Quarterly chart"));
  expect(dom(editor).querySelector("img")).toBeNull();
  // nothing in the editor carries an address the window could fetch
  expect(dom(editor).querySelectorAll("[src], [srcset], [data]")).toHaveLength(0);
  expect(dom(editor).innerHTML).not.toContain("<img");
  expect(dom(editor).querySelector(".remote-image-alt")!.textContent).toBe("Quarterly chart");
  expect(dom(editor).querySelector(".remote-image-src")!.textContent).toBe(REMOTE);
});

test("a_picture_with_no_alt_text_is_called_a_picture", () => {
  const editor = make(image(REMOTE));
  expect(dom(editor).querySelector(".remote-image-alt")!.textContent).toBe("Picture");
  expect(dom(editor).querySelector(".remote-image-src")!.textContent).toBe(REMOTE);
});

test("the_address_is_drawn_as_text_even_when_it_looks_like_markup", () => {
  const evil = 'https://x.test/"><img src=https://leak.test/a.png>';
  const editor = make(image(evil, '<img src="https://leak.test/b.png">'));
  expect(dom(editor).querySelectorAll("img")).toHaveLength(0);
  expect(dom(editor).querySelector(".remote-image-src")!.textContent).toBe(evil);
});

test.each([
  ["data:image/png;base64,iVBORw0KGgo=", true],
  ["DATA:image/gif;base64,R0lGODlhAQABAAAAACw=", true],
  ["blob:https://docbro.test/6f1a", true],
  ["https://example.com/a.png", false],
  ["HTTP://example.com/a.png", false],
  ["//example.com/a.png", false],
  ["/local/a.png", false],
  ["a.png", false],
  ["file:///etc/passwd", false],
  ["javascript:alert(1)", false],
  ["ftp://example.com/a.png", false],
  ["asset://localhost/a.png", false],
  ["", false],
])("a_picture_source_%s_loads_in_the_page_is_%s", (src, loads) => {
  expect(loadsInPage(src)).toBe(loads);
  const editor = make(image(src, "alt"));
  expect(dom(editor).querySelectorAll("img")).toHaveLength(loads ? 1 : 0);
});

test("a_picture_in_the_document_or_made_by_the_page_still_renders", () => {
  const editor = make(image(PIXEL, "pixel"), image("blob:https://docbro.test/6f1a"));
  const pictures = [...dom(editor).querySelectorAll("img")];
  expect(pictures.map((i) => i.getAttribute("src"))).toEqual([PIXEL, "blob:https://docbro.test/6f1a"]);
  expect(dom(editor).querySelector(".remote-image")).toBeNull();
  expect(pictures[0].getAttribute("alt")).toBe("pixel");
});

test("a_picture_from_the_web_keeps_its_address_in_the_document", () => {
  const editor = make(image(REMOTE, "Quarterly chart", { title: "Q3" }));
  expect(editor.getJSON().content).toEqual([image(REMOTE, "Quarterly chart", { title: "Q3", width: null, height: null, cover: false, align: null, wrap: false })]);
});

test("a_picture_inserted_by_a_command_is_not_loaded_either", () => {
  const editor = make({ type: "paragraph" });
  editor.commands.insertContent(image(REMOTE, "late"));
  expect(dom(editor).querySelectorAll("img")).toHaveLength(0);
  expect(dom(editor).querySelector(".remote-image-src")!.textContent).toBe(REMOTE);
});

test("a_cover_from_the_web_is_not_loaded_either", () => {
  const editor = make(image(REMOTE, "cover", { cover: true }));
  expect(dom(editor).querySelectorAll("img, [data-cover]")).toHaveLength(0);
});

test("every_other_draw_of_a_picture_goes_through_the_same_rule", () => {
  // a kept header or footer is drawn with the schema's serializer, as is a copied selection
  const editor = make({ type: "paragraph" });
  const doc = editor.schema.nodeFromJSON({ type: "doc", content: [image(REMOTE, "logo"), image(PIXEL, "pixel")] });
  const box = document.createElement("div");
  box.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(doc.content));
  expect([...box.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([PIXEL]);
  expect(box.querySelector(".remote-image-src")!.textContent).toBe(REMOTE);
});

test("a_copied_picture_from_the_web_pastes_back_as_the_same_picture", () => {
  const editor = make({ type: "paragraph" });
  const doc = editor.schema.nodeFromJSON({ type: "doc", content: [image(REMOTE, "logo")] });
  const box = document.createElement("div");
  box.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(doc.content));
  const pasted = PMParser.fromSchema(editor.schema).parse(box);
  expect(pasted.firstChild!.type.name).toBe("image");
  expect(pasted.firstChild!.attrs).toMatchObject({ src: REMOTE, alt: "logo" });
});

test("a_cell_fill_cannot_carry_a_style_that_makes_the_window_fetch_a_picture", () => {
  const leak = "red;background-image:url(https://leak.test/a.png)";
  // pasted HTML: the fill is read as a color or not at all
  const box = document.createElement("div");
  box.innerHTML = `<table><tr><td data-background="${leak}">a</td><td data-background="#a1b2c3">b</td></tr></table>`;
  const editor = make({ type: "paragraph" });
  const pasted = PMParser.fromSchema(editor.schema).parse(box);
  const cells: unknown[] = [];
  pasted.descendants((node) => void (node.type.name === "tableCell" && cells.push(node.attrs.background)));
  expect(cells).toEqual([null, "#a1b2c3"]);
  // a fill that got into the document anyway is not drawn
  const table = { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { background: leak }, content: [{ type: "paragraph" }] }] }] };
  const shown = make(table);
  expect(dom(shown).innerHTML).not.toContain("url(");
  expect(dom(shown).querySelector("td")!.getAttribute("style") ?? "").not.toContain("background");
});
