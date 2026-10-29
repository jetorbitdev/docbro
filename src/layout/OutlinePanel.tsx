import type { Editor, EditorEvents } from "@tiptap/core";
import { useEffect, useState } from "react";
import { formatOf } from "../formats";
import { activeHeading, crumbs, docStats, outlineOf, type OutlineEntry } from "./outline";

interface Props {
  editor: Editor;
  /** Showing now. The panel stays mounted when it is not (it is inert, and does no work). */
  active: boolean;
  /** The element the paper scrolls in. */
  scroller: HTMLElement | null;
  path: string | null;
  onHide(): void;
}

const headingElement = (editor: Editor, entry: OutlineEntry) => editor.view.nodeDOM(entry.pos) as HTMLElement | null;

/** Mock 98–127: headings 1–3 that follow the scroll, the document's counts and a FILE card. */
export function Outline({ editor, active: shown, scroller, path, onHide }: Props) {
  const [entries, setEntries] = useState<OutlineEntry[]>([]);
  const [stats, setStats] = useState(() => docStats(""));
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!shown) return;
    const update = () => {
      setEntries(outlineOf(editor.state.doc));
      setStats(docStats(editor.getText({ blockSeparator: "\n" })));
    };
    // every document change, including opening a file, which sends no `update` event
    const onTransaction = ({ transaction }: EditorEvents["transaction"]) => {
      if (transaction.docChanged) update();
    };
    update();
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, shown]);

  useEffect(() => {
    if (!scroller || !shown) return;
    const onScroll = () => {
      const top = scroller.getBoundingClientRect().top;
      const tops = entries.map((e) => (headingElement(editor, e)?.getBoundingClientRect().top ?? Infinity) - top);
      setActive(activeHeading(tops));
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [editor, scroller, entries, shown]);

  const go = (entry: OutlineEntry) => {
    const el = headingElement(editor, entry);
    if (!el || !scroller) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 40;
    scroller.scrollTo({ top, behavior: "smooth" });
  };

  const { name } = crumbs(path);
  const format = path ? formatOf(path) : null;
  const kind = format === "docx" ? "Word document" : format === "md" ? "Markdown" : "Not saved yet";

  return (
    <aside className="outline" inert={!shown} aria-hidden={shown ? undefined : true}>
      <div className="outline-head">
        <span className="caption">OUTLINE</span>
        <button className="ghost-btn" title="Hide outline" aria-label="Hide outline" onClick={onHide}>
          «
        </button>
      </div>
      <nav className="outline-nav">
        {entries.map((entry, i) => (
          <button key={`${i}-${entry.pos}`} className={`outline-item l${entry.level}${i === active ? " active" : ""}`} onClick={() => go(entry)}>
            {entry.text}
          </button>
        ))}
      </nav>
      <div className="spacer" />
      <div className="outline-foot">
        <div className="stats">
          <Stat value={stats.words.toLocaleString("en-US")} label="words" />
          <Stat value={stats.characters.toLocaleString("en-US")} label="characters" />
          <Stat value={String(stats.readMinutes)} label="min read" />
        </div>
        <div className="caption">FILE</div>
        <div className="file-card" title={path ? `${kind} · ${path}` : kind}>
          <span className="tile">{format === "md" ? "M" : "W"}</span>
          <span className="name">{name}</span>
        </div>
      </div>
    </aside>
  );
}

/** The number in bold, then its label. */
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span className="stat">
      <b>{value}</b> {label}
    </span>
  );
}

/** Mock 98–102: the 40px rail an outline collapses to. Mounted with the outline; `active` is whether it shows. */
export function OutlineRail({ active, onShow }: { active: boolean; onShow(): void }) {
  return (
    <div className="outline-rail" inert={!active} aria-hidden={active ? undefined : true}>
      <button className="rail-btn" title="Show outline" aria-label="Show outline" onClick={onShow}>
        ☰
      </button>
    </div>
  );
}
