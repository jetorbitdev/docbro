import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { GROUPS, platformKeys, type Command, type Group } from "../commands";

const ICONS: Record<Group, string> = { File: "▤", Edit: "✎", View: "◉", Insert: "+", Format: "Aa" };

// A mouse-down on the bar would take focus (and the selection) from the editor.
const keepFocus = (e: MouseEvent) => e.preventDefault();

/**
 * Mock 67–94: click opens a menu, hovering another switches while one is open, the backdrop or Esc closes.
 * The bar stays mounted when `visible` is false (Focus mode): its slot animates the height to 0 and is inert.
 */
export function MenuBar({ commands, visible }: { commands: Command[]; visible: boolean }) {
  const [open, setOpen] = useState<Group | null>(null);
  const larger = commands.find((c) => c.id === "larger_text");
  const palette = commands.find((c) => c.id === "palette");

  useEffect(() => {
    if (!visible) setOpen(null);
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    // the open list is placed against the window when it opens; a resize would leave it behind
    const close = () => setOpen(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const choose = (c: Command) => {
    setOpen(null);
    c.run();
  };

  return (
    <div className="menubar-slot" data-open={visible} inert={!visible} aria-hidden={visible ? undefined : true}>
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
        {palette && (
          <button className="search-btn" title={`Search the menus (${platformKeys("⌘K")} or ${platformKeys("⌥/")})`} onClick={palette.run}>
            <span className="label">
              <span className="glyph">⌕</span>Search menus
            </span>
            <span className="kbd">{platformKeys("⌘K")}</span>
          </button>
        )}
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
    </div>
  );
}

function MenuList({ items, onChoose }: { items: Command[]; onChoose(c: Command): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  // Fixed, under its button: the bar's slot clips anything that overflows it, a fixed box is not clipped.
  // The last menus would run off a narrow window: open them leftwards instead.
  useLayoutEffect(() => {
    const el = ref.current;
    const button = el?.parentElement?.querySelector(".menu-btn");
    if (!el || !button) return;
    const b = button.getBoundingClientRect();
    const left = b.left + el.offsetWidth > window.innerWidth - 8 ? Math.max(8, b.right - el.offsetWidth) : b.left;
    setAt({ left, top: b.bottom + 4 });
  }, []);

  return (
    <div ref={ref} className="menu-list" role="menu" style={at ?? { visibility: "hidden" }}>
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
