import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type ClaudeSession, type TeleportOutcome } from "../api";
import "./assistant.css";

const message = (e: unknown) => (e instanceof Error && e.message) || String(e);
const COPIED_MS = 1500;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `iso` was, in words; a date once it is a month old, nothing when it is not a time. */
export function ago(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const gone = Math.max(0, now - at);
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (gone < MINUTE) return "just now";
  if (gone < HOUR) return count(Math.floor(gone / MINUTE), "minute");
  if (gone < DAY) return count(Math.floor(gone / HOUR), "hour");
  if (gone < 2 * DAY) return "yesterday";
  if (gone < 30 * DAY) return count(Math.floor(gone / DAY), "day");
  return new Date(at).toLocaleDateString();
}

interface Props {
  /** Continues `session` in the panel; the sheet shows why when it rejects. */
  onContinue(session: ClaudeSession): Promise<void>;
  onClose(): void;
}

/**
 * "Continue a Claude Code session": one from this Mac, picked from a list, or one from Claude
 * Code on the web, which the user brings over once with a command in Terminal. Titles and
 * project names come from the session files: they are shown as text, never as markup.
 */
export function ContinueSession({ onContinue, onClose }: Props) {
  const [tab, setTab] = useState<"mac" | "web">("mac");
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [outcome, setOutcome] = useState<TeleportOutcome | null>(null);
  const [webError, setWebError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sheet.current?.focus();
    let gone = false;
    api.claudeSessions().then(
      (list) => !gone && setSessions(list),
      (e) => {
        if (gone) return;
        setSessions([]);
        setError(message(e));
      },
    );
    return () => {
      gone = true;
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [copied]);

  const pick = async (s: ClaudeSession) => {
    setPicking(s.id);
    setError(null);
    try {
      await onContinue(s);
    } catch (e) {
      setError(message(e));
    } finally {
      setPicking(null);
    }
  };

  const getCommand = async () => {
    setWebError(null);
    setOutcome(null);
    try {
      setOutcome(await api.assistantTeleport(link));
    } catch (e) {
      setWebError(message(e));
    }
  };

  const copy = (text: string) =>
    void writeText(text).then(
      () => setCopied(true),
      (e) => setWebError(message(e)),
    );

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  return (
    <div className="pal-overlay" onMouseDown={onClose}>
      <div
        className="pal mcp-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="continue-session-title"
        tabIndex={-1}
        ref={sheet}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="mcp-sheet-head">
          <span id="continue-session-title" className="title">
            Continue a Claude Code session
          </span>
          <div className="spacer" />
          <span className="kbd">esc</span>
          <button className="close-btn" title="Close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="pal-tabs" role="tablist" aria-label="Where the session is">
          {(
            [
              ["mac", "On this Mac"],
              ["web", "From the web"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`pal-tab${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="mcp-sheet-body">
          {tab === "mac" ? (
            <div className="session-pane">
              <p className="mcp-lead">
                Your next message goes on in a copy of the session, so the original stays as it was. Its earlier messages
                are not shown here.
              </p>
              {error && <div className="mcp-error" role="alert">{error}</div>}
              {sessions === null ? (
                <p className="mcp-note">Loading…</p>
              ) : sessions.length === 0 ? (
                !error && <p className="mcp-note">No Claude Code sessions on this Mac yet.</p>
              ) : (
                <div className="session-list">
                  {sessions.map((s) => {
                    const when = ago(s.modified);
                    return (
                      <button key={s.id} className="session-row" disabled={picking !== null} onClick={() => void pick(s)}>
                        <span className="session-title">{s.title}</span>
                        <span className="session-meta">{when ? `${s.project} · ${when}` : s.project}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="session-pane">
              <p className="mcp-lead">Paste the link of a session from Claude Code on the web, or its id.</p>
              <div className="mcp-field">
                <input
                  className="code"
                  aria-label="Session link or id"
                  value={link}
                  spellCheck={false}
                  placeholder="https://claude.ai/code/session_…"
                  onChange={(e) => setLink(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && link.trim()) void getCommand();
                  }}
                />
                <button className="line-btn primary" disabled={!link.trim()} onClick={() => void getCommand()}>
                  Get the command
                </button>
              </div>
              {webError && <div className="mcp-error" role="alert">{webError}</div>}
              {outcome && (
                <>
                  <div className="mcp-where">
                    <span>Run this once in Terminal, in the session's repository folder, then pick the session under On this Mac.</span>
                    <button className="line-btn" onClick={() => copy(outcome.command)}>
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre className="mcp-snippet">
                    <code>{outcome.command}</code>
                  </pre>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
