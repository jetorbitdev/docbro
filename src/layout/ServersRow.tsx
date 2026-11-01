import { useState } from "react";
import type { ServerView } from "../api";

/** The built-in document server, as the chat names it. */
export const BUILTIN = { id: "docbro", name: "DocBro Docs" };

/** The tile letter of a server. */
export const tileOf = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

interface Props {
  servers: ServerView[];
  builtin: boolean;
  onBuiltin(on: boolean): void;
  /** switches one of the user's servers on or off; it is busy until the promise settles */
  onToggle(id: string, enabled: boolean): Promise<void>;
  onAdd(): void;
}

/**
 * Mock 241–263: CONNECTED SERVERS, how many are on, and when opened the list with a switch
 * each: the built-in document server, then the user's. A server's error is its own text and is
 * shown as text.
 */
export function ServersRow({ servers, builtin, onBuiltin, onToggle, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const on = (builtin ? 1 : 0) + servers.filter((s) => s.enabled).length;

  const toggle = async (s: ServerView) => {
    setPending((p) => [...p, s.id]);
    await onToggle(s.id, !s.enabled);
    setPending((p) => p.filter((id) => id !== s.id));
  };

  return (
    <div className="servers">
      <button className="servers-toggle" aria-expanded={open} aria-controls="assistant-servers" onClick={() => setOpen((o) => !o)}>
        <span className="caption">CONNECTED SERVERS</span>
        <span className="count">
          {on} of {servers.length + 1} on
        </span>
        <span className="spacer" />
        <span className="arrow">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="servers-list" id="assistant-servers">
          <div className="server-card">
            <span className="server-tile">D</span>
            <div className="server-text">
              <span className="name">{BUILTIN.name}</span>
              <span className="meta">read_document · insert_content · …</span>
            </div>
            <Switch label={BUILTIN.name} on={builtin} onClick={() => onBuiltin(!builtin)} />
          </div>
          {servers.map((s) => (
            <div className="server-card" key={s.id}>
              <span className="server-tile other">{tileOf(s.name)}</span>
              <div className="server-text">
                <span className="name">
                  <span className={`dot ${s.status}`} />
                  {s.name}
                </span>
                {s.error ? (
                  <span className="server-error">{s.error}</span>
                ) : (
                  <span className="meta">{s.tools ? `${s.tools} tools · ${s.summary}` : s.summary}</span>
                )}
              </div>
              <Switch label={s.name} on={s.enabled} disabled={pending.includes(s.id)} onClick={() => toggle(s)} />
            </div>
          ))}
          <button className="add-btn" onClick={onAdd}>
            + Add MCP server
          </button>
        </div>
      )}
    </div>
  );
}

function Switch({ label, on, disabled, onClick }: { label: string; on: boolean; disabled?: boolean; onClick(): void }) {
  return (
    <button className={`switch${on ? " on" : ""}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick}>
      <span />
    </button>
  );
}
