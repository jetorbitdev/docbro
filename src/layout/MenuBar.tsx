import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { GROUPS, platformKeys, type Command, type Group } from "../commands";

const ICONS: Record<Group, string> = { File: "▤", Edit: "✎", View: "◉", Insert: "+", Format: "Aa" };

// A mouse-down on the bar would take focus (and the selection) from the editor.
const keepFocus = (e: MouseEvent) => e.preventDefault();

/** Mock 67–94: click opens a menu, hovering another switches while one is open, the backdrop or Esc closes. */
export function MenuBar({ commands }: { commands: Command[] }) {
  const [open, setOpen] = useState<Group | null>(null);
  const larger = commands.find((c) => c.id === "larger_text");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const choose = (c: Command) => {
    setOpen(null);
    c.run();
  };

  return (
    <>
      <nav className="menubar" onMouseDown={keepFocus}>
        {GROUPS.map((group) => (
          <div className="menu" key={group}>
            <button
              className={`menu-btn${open === group ? " open" : ""}`}
              onClick={() => setOpen(open === group ? null : group)}
              onMouseEnter={() => open && open !== group && setOpen(group)}
            >
              <span className="glyph">{ICONS[group]}</span>
              {group}
              <span className="caret">▾</span>
            </button>
            {open === group && <MenuList items={commands.filter((c) => c.group === group)} onChoose={choose} />}
          </div>
        ))}
        <div className="spacer" />
        {larger && (
          <button className={`big-btn${larger.state ? " on" : ""}`} title="Make text larger" onClick={larger.run}>
            <span className="aa">
              A<span>A</span>
            </span>
            Larger text
          </button>
        )}
      </nav>
      {open && (
        <div
          className="menu-backdrop"
          onMouseDown={(e) => {
            keepFocus(e);
            setOpen(null);
          }}
        />
      )}
    </>
  );
}

function MenuList({ items, onChoose }: { items: Command[]; onChoose(c: Command): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [alignRight, setAlignRight] = useState(false);

  // the last menus would run off a narrow window: open them leftwards instead
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.getBoundingClientRect().right > window.innerWidth - 8) setAlignRight(true);
  }, []);

  return (
    <div ref={ref} className={`menu-list${alignRight ? " right" : ""}`} role="menu">
      {items.map((c) => (
        <button key={c.id} className="menu-item" role="menuitem" disabled={!c.enabled} onClick={() => onChoose(c)}>
          <span className="icon">{c.icon}</span>
          <span className="label">{c.label}</span>
          <span className="state">{c.state}</span>
          <span className="keys">{platformKeys(c.keys)}</span>
        </button>
      ))}
    </div>
  );
}
