import { useEffect, useRef, useState, type KeyboardEvent } from "react";

interface Props {
  /** the servers that are on, for the @ list and the count */
  servers: { id: string; name: string }[];
  /** the text "+ Selection" took, which goes with the next message */
  context: string | null;
  onClearContext(): void;
  /** takes the document's selection; false when nothing is selected */
  onUseSelection(): boolean;
  busy: boolean;
  /** Stop was pressed and the answer has not ended yet */
  stopping: boolean;
  /** false when the message was not taken, so the text stays */
  onSend(text: string): boolean;
  onStop(): void;
}

const CONTEXT_CHARS = 60;
const NOTE_MS = 2500;

/**
 * Mock 311–327: the message box, the selection chip, the @ list of servers, and send, which is
 * Stop while an answer comes in. Enter sends, Shift+Enter starts a new line.
 */
export function Composer({ servers, context, onClearContext, onUseSelection, busy, stopping, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), NOTE_MS);
    return () => window.clearTimeout(t);
  }, [note]);

  // only a mention at the very start picks a server (chat.ts, parseMention), so the list is offered there
  const typed = /^@([a-z0-9_-]*)$/i.exec(text);
  const options = typed && !dismissed ? servers.filter((s) => s.id.startsWith(typed[1].toLowerCase())) : [];
  const current = Math.min(active, options.length - 1);

  const change = (value: string) => {
    setText(value);
    setDismissed(false);
    setActive(0);
  };
  const pick = (id: string) => {
    change(`@${id} `);
    box.current?.focus();
  };
  const send = () => {
    if (!busy && text.trim() && onSend(text)) change("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (options.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((current + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(options[current].id);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const shown = context && (context.length > CONTEXT_CHARS ? `${context.slice(0, CONTEXT_CHARS)}…` : context);

  return (
    <div className="composer-wrap">
      <div className="composer">
        {shown && (
          <div className="context-chip">
            <span>“{shown}”</span>
            <button aria-label="Leave out the selection" title="Leave out the selection" onClick={onClearContext}>
              ×
            </button>
          </div>
        )}
        {options.length > 0 && (
          <div className="mention-list" role="listbox" id="mention-list" aria-label="Servers">
            {options.map((s, i) => (
              <div
                key={s.id}
                id={`mention-${s.id}`}
                role="option"
                aria-selected={i === current}
                className={i === current ? "sel" : ""}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s.id)}
              >
                <span className="tag">@{s.id}</span>
                <span>{s.name}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={box}
          rows={2}
          value={text}
          placeholder="Ask, or type @ to pick a server"
          aria-label="Message"
          aria-controls={options.length ? "mention-list" : undefined}
          aria-activedescendant={options.length ? `mention-${options[current].id}` : undefined}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-bar">
          <button
            className="selection-btn"
            title="Use the selected text as context"
            onClick={() => setNote(onUseSelection() ? null : "Select some text in the document first.")}
          >
            + Selection
          </button>
          <span className="composer-label">{note ?? `${servers.length} ${servers.length === 1 ? "server" : "servers"}`}</span>
          <div className="spacer" />
          {busy ? (
            <button className="stop-btn" title="Stop the answer" disabled={stopping} onClick={onStop}>
              {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button className={`send-btn${text.trim() ? " ready" : ""}`} aria-label="Send" title="Send" disabled={!text.trim()} onClick={send}>
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
