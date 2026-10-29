import type { JSONContent } from "@tiptap/core";

// A 1x1 PNG.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQztkAAAINAUgHmjx0AAAAAElFTkSuQmCC";

type Mark = NonNullable<JSONContent["marks"]>[number];

const text = (value: string, ...marks: Mark[]): JSONContent =>
  marks.length ? { type: "text", text: value, marks } : { type: "text", text: value };

const paragraph = (content: JSONContent[], textAlign?: string): JSONContent =>
  textAlign ? { type: "paragraph", attrs: { textAlign }, content } : { type: "paragraph", content };

const item = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
const cell = (type: "tableHeader" | "tableCell", value: string): JSONContent => ({
  type,
  content: [paragraph([text(value)])],
});

// One of every node, mark and attribute of the shared schema (except `comment`).
// Tasks 4, 6 and 10 reuse it, so a change here changes their tests too.
export function fixtureDoc(): JSONContent {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1, textAlign: "center" }, content: [text("Judul Dokumen")] },
      { type: "heading", attrs: { level: 2 }, content: [text("Bagian Kedua")] },
      { type: "heading", attrs: { level: 3, textAlign: "right" }, content: [text("Sub-bagian Ketiga")] },
      paragraph([
        text("tebal", { type: "bold" }),
        text(", "),
        text("miring", { type: "italic" }),
        text(", "),
        text("garis bawah", { type: "underline" }),
        text(", "),
        text("coret", { type: "strike" }),
        text(", "),
        text("tautan", { type: "link", attrs: { href: "https://example.com/docbro" } }),
        text(", "),
        text("warna", { type: "textStyle", attrs: { color: "#cc0000" } }),
        text(", "),
        text("sorot", { type: "highlight", attrs: { color: "#f3dc6b" } }),
        text(", dan "),
        text("gabungan", { type: "bold" }, { type: "italic" }, { type: "textStyle", attrs: { color: "#0044aa" } }),
      ]),
      paragraph([text("Rata kiri.")], "left"),
      paragraph([text("Rata tengah.")], "center"),
      paragraph([text("Rata kanan.")], "right"),
      paragraph([text("Rata kiri dan kanan.")], "justify"),
      paragraph([text("  dua spasi\tlalu tab"), { type: "hardBreak" }, text("baris setelah jeda")]),
      paragraph([text("Émoji 🎉 dan kalimat Indonesia: Selamat pagi!")]),
      { type: "blockquote", content: [paragraph([text("Sebuah kutipan.")])] },
      { type: "horizontalRule" },
      {
        type: "bulletList",
        content: [
          item(
            paragraph([text("Butir satu")]),
            { type: "bulletList", content: [item(paragraph([text("Sub-butir A")])), item(paragraph([text("Sub-butir B")]))] },
          ),
          item(paragraph([text("Butir dua")])),
        ],
      },
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [item(paragraph([text("Langkah tiga")])), item(paragraph([text("Langkah empat")]))],
      },
      {
        type: "table",
        content: [
          { type: "tableRow", content: [cell("tableHeader", "Nama"), cell("tableHeader", "Nilai")] },
          { type: "tableRow", content: [cell("tableCell", "Alfa"), cell("tableCell", "1")] },
        ],
      },
      { type: "image", attrs: { src: PIXEL, alt: "Satu piksel" } },
      paragraph([text("Penutup.")]),
    ],
  };
}
