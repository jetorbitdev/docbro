import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { filterCommands, GROUPS, platformKeys, type Command, type Group } from "../commands";

interface Props {
  commands: Command[];
  /** Closes the palette and gives the editor its focus and selection back. */
  onClose(): void;
}

const TABS: (Group | "All")[] = ["All", ...GROUPS];

/** Mock 332–365: search every command, by group, with ↑/↓, Enter and Esc. */
export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<Group | "All">("All");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const list = filterCommands(commands, query, group);

  useEffect(() => input.current?.focus(), []);

  // keep the highlighted row in view while moving with the arrows
  useEffect(() => {
    rows.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (c: Command | undefined) => {
    if (!c?.enabled) return;
    onClose();
    c.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const n = Math.max(list.length, 1);
    if (e.key === "ArrowDown") setIndex((i) => (i + 1) % n);
    else if (e.key === "ArrowUp") setIndex((i) => (i - 1 + n) % n);
    else if (e.key === "Enter") run(list[index]);
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
  };

  const groups = GROUPS.map((g) => ({ name: g, items: list.filter((c) => c.group === g) })).filter((g) => g.items.length);

  return (
    <div className="pal-overlay" onMouseDown={onClose}>
      <div className="pal" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pal-search">
          <span className="glyph">⌕</span>
          <input
            ref={input}
            value={query}
            placeholder="Search menus and commands"
            aria-label="Search menus and commands"
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="pal-tabs">
          {TABS.map((t) => (
            <button
              key={t}
              className={`pal-tab${group === t ? " on" : ""}`}
              onClick={() => {
                setGroup(t);
                setIndex(0);
                input.current?.focus();
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="pal-list" ref={rows}>
          {groups.map((g) => (
            <div className="pal-group" key={g.name}>
              <div className="caption">{g.name.toUpperCase()}</div>
              {g.items.map((c) => {
                const i = list.indexOf(c);
                return (
                  <button
                    key={c.id}
                    className={`pal-item${i === index ? " sel" : ""}${c.enabled ? "" : " disabled"}`}
                    aria-disabled={!c.enabled}
                    onClick={() => run(c)}
                    onMouseEnter={() => setIndex(i)}
                  >
                    <span className="icon">{c.icon}</span>
                    <span className="label">{c.label}</span>
                    <span className="state">{c.state}</span>
                    <span className="keys">{platformKeys(c.keys)}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {!list.length && <div className="pal-empty">No commands match.</div>}
        </div>
      </div>
    </div>
  );
}
