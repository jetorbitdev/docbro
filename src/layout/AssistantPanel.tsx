import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type AssistantEvent, type AssistantStatus, type ClaudeSession, type ServerView } from "../api";
import { emptyChat, parseMention, reduceChat, sendUser, type ChatState, type Msg, type ToolCard as Card } from "../assistant/chat";
import { flashSelection, insertAssistantText } from "../assistant/insert";
import { activity, type ActivityEntry } from "../mcp/activity";
import { Composer } from "./Composer";
import { ContinueSession } from "./ContinueSession";
import { BUILTIN, ServersRow, tileOf } from "./ServersRow";
import "./assistant.css";

interface Props {
  /** the document's editor, which "Insert into doc" and "+ Selection" work on */
  editor: Editor;
  /** while MCP settings are open; when they close, the panel reloads the engine's status and the servers */
  settingsOpen: boolean;
  onClose(): void;
  /** opens MCP settings, on the form that adds a server with `addServer` */
  onSettings(addServer?: boolean): void;
}

const STATE_LABEL: Record<ActivityEntry["state"], string> = { running: "Running…", done: "✓ Done", error: "Failed" };
// "off" when the built-in document server is switched off
const BUILTIN_KEY = "docbro-builtin";
const COPIED_MS = 1200;

const SUGGESTIONS = [
  { tag: "@docbro", text: "Summarize this document in three bullets" },
  { tag: "@docbro", text: "Fix spelling and grammar in the selected text", selection: true },
  { tag: "", text: "Draft an outline for this document" },
];

type Bot = Extract<Msg, { role: "bot" }>;

const message = (e: unknown) => (e instanceof Error && e.message) || String(e);

function builtinOn(): boolean {
  try {
    return localStorage.getItem(BUILTIN_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Why the composer is off, and what fixes it, for the engine picked. */
function offText(status: AssistantStatus | null): string {
  switch (status?.engine) {
    case "claude_code":
      return "Claude Code was not found. Install it from claude.com/code, or switch to an API key in MCP settings.";
    case "openai_compatible":
      return "Finish the other provider's settings to start chatting.";
    default:
      return "Add your Anthropic API key to start chatting.";
  }
}

/** The text selected in the document, if any. */
function selectionText(editor: Editor): string {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, "\n", " ").trim();
}

/**
 * Mock 231–329: the chat, which can use the document and the user's MCP servers (Rust runs it,
 * on Claude Code, the Anthropic API or another provider, so no key reaches the webview), with
 * the tool calls external AI clients make in this window shown between the messages.
 */
export function AssistantPanel({ editor, settingsOpen, onClose, onSettings }: Props) {
  const calls = useSyncExternalStore(activity.subscribe, activity.list);
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [stopping, setStopping] = useState(false);
  const [context, setContext] = useState<string | null>(null);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  // the title of the Claude Code session the chat goes on in, and whether the sheet to pick one is open
  const [continuing, setContinuing] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [servers, setServers] = useState<ServerView[]>([]);
  const [builtin, setBuiltin] = useState(builtinOn);
  const [copied, setCopied] = useState<number | null>(null);
  const lastId = useRef(0);
  // busy at once, so a second Enter before the next render sends nothing
  const busy = useRef(false);
  const stream = useRef<HTMLDivElement>(null);

  // A reloaded window starts with an empty chat: Rust drops the conversation it had and stops
  // its answer, so the chat is never stuck waiting for one.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    getCurrentWindow()
      .listen<AssistantEvent>("assistant-event", ({ payload }) => setChat((c) => reduceChat(c, payload)))
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      }, () => {});
    api.assistantReset().catch(() => {});
    return () => {
      gone = true;
      stop?.();
    };
  }, []);

  // an engine may have been set up and servers added in the settings; a message may have connected a server or failed to
  useEffect(() => {
    if (settingsOpen || chat.busy) return;
    api.assistantStatus().then(setStatus, () => {});
    api.serversList().then(setServers, () => {});
  }, [settingsOpen, chat.busy]);

  useEffect(() => {
    busy.current = chat.busy;
    if (!chat.busy) setStopping(false);
  }, [chat.busy]);

  useEffect(() => {
    if (copied === null) return;
    const t = window.setTimeout(() => setCopied(null), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [copied]);

  // the newest message is at the bottom
  useEffect(() => {
    const el = stream.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [calls, chat]);

  const setBuiltinOn = (on: boolean) => {
    setBuiltin(on);
    try {
      localStorage.setItem(BUILTIN_KEY, on ? "on" : "off");
    } catch {
      // not remembered, still applied
    }
  };

  const toggleServer = async (id: string, enabled: boolean) => {
    try {
      setServers(await api.serversSetEnabled(id, enabled));
    } catch {
      api.serversList().then(setServers, () => {});
    }
  };

  /** Sends `typed` with the selection chip (or `extra`); false when an answer is still coming. */
  const send = (typed: string, extra: string | null = null): boolean => {
    const shown = typed.trim();
    if (!shown || busy.current) return false;
    busy.current = true;
    const { text, only } = parseMention(shown, [BUILTIN.id, ...servers.map((s) => s.id)]);
    const id = Math.max(Date.now(), lastId.current + 2);
    lastId.current = id;
    setChat((c) => sendUser(c, id, shown));
    api.assistantSend(text, context ?? extra, only, !builtin).catch((e) => setChat((c) => reduceChat(c, { type: "error", message: message(e) })));
    setContext(null);
    return true;
  };

  const stop = () => {
    setStopping(true);
    // the answer still ends with `done`, which makes the chat idle
    api.assistantCancel().catch(() => setStopping(false));
  };

  const clear = () => {
    setChat(emptyChat);
    setContext(null);
    setContinuing(null);
    activity.clear();
    return api.assistantReset().catch(() => {});
  };

  /** A new chat whose next message goes on in a copy of `session`; rejects with why it cannot. */
  const continueSession = async (session: ClaudeSession) => {
    // a reset would stop the answer coming in
    if (busy.current) throw new Error("The assistant is still answering. Stop it first.");
    await clear();
    await api.assistantContinue(session.id);
    setContinuing(session.title);
    setPicking(false);
  };

  const useSelection = () => {
    const text = selectionText(editor);
    if (text) setContext(text);
    return !!text;
  };

  const insert = (text: string) => {
    insertAssistantText(editor, text);
    editor.view.focus();
    flashSelection(editor);
  };

  const copy = (m: Bot) => void writeText(m.text).then(() => setCopied(m.id), () => {});

  const serverName = (id: string) => (id === BUILTIN.id ? BUILTIN.name : servers.find((s) => s.id === id)?.name ?? id);
  const on = [...(builtin ? [BUILTIN] : []), ...servers.filter((s) => s.enabled)];
  // the messages and the external calls, by when they started; an answer's id comes right after its question's
  const items: ({ at: number; msg: Msg } | { at: number; call: ActivityEntry })[] = [
    ...chat.msgs.map((msg) => ({ at: msg.id, msg })),
    ...calls.map((call) => ({ at: call.at, call })),
  ].sort((a, b) => a.at - b.at);
  const answering = chat.busy ? chat.msgs[chat.msgs.length - 1] : null;
  // sessions can be continued once Claude Code is the engine and was found
  const claudeCode = status?.engine === "claude_code" && status.configured;

  return (
    <>
      <div className="assistant-head">
        <span className="title">Assistant</span>
        <span className="pill">MCP</span>
        <div className="spacer" />
        <button className="head-btn" title="New chat" onClick={() => void clear()}>
          New
        </button>
        <button className="icon-btn" title="MCP settings" aria-label="MCP settings" onClick={() => onSettings()}>
          ⚙
        </button>
        <button className="close-btn" title="Close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <ServersRow servers={servers} builtin={builtin} onBuiltin={setBuiltinOn} onToggle={toggleServer} onAdd={() => onSettings(true)} />
      {continuing !== null && claudeCode && (
        <div className="continuing" title={continuing}>
          Continuing “{continuing}”
        </div>
      )}
      <div className="assistant-stream" ref={stream}>
        {items.length ? (
          items.map((item) =>
            "call" in item ? (
              <ExternalCard key={`call-${item.call.id}`} entry={item.call} />
            ) : item.msg.role === "user" ? (
              <div key={item.msg.id} className="msg-user">
                {item.msg.text}
              </div>
            ) : (
              <BotMessage
                key={item.msg.id}
                msg={item.msg}
                answering={item.msg === answering}
                copied={copied === item.msg.id}
                serverName={serverName}
                onInsert={insert}
                onCopy={copy}
              />
            ),
          )
        ) : (
          <div className="assistant-empty">
            <p>Ask about this document or pull data from your connected servers.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((q) => (
                <button
                  key={q.text}
                  className="suggestion"
                  onClick={() => send(q.tag ? `${q.tag} ${q.text}` : q.text, q.selection ? selectionText(editor) || null : null)}
                >
                  {q.tag && <span className="tag">{q.tag}</span>}
                  <span>{q.text}</span>
                </button>
              ))}
            </div>
            {claudeCode && (
              <button className="line-btn continue-btn" onClick={() => setPicking(true)}>
                Continue a Claude Code session…
              </button>
            )}
          </div>
        )}
      </div>
      {status?.configured === false ? (
        <div className="composer-wrap">
          <div className="composer-off">
            <p>{offText(status)}</p>
            <button className="line-btn" onClick={() => onSettings()}>
              Open MCP settings
            </button>
          </div>
        </div>
      ) : (
        <Composer
          servers={on}
          context={context}
          onClearContext={() => setContext(null)}
          onUseSelection={useSelection}
          busy={chat.busy}
          stopping={stopping}
          onSend={send}
          onStop={stop}
        />
      )}
      {picking && claudeCode && <ContinueSession onContinue={continueSession} onClose={() => setPicking(false)} />}
    </>
  );
}

interface BotProps {
  msg: Bot;
  /** the answer still coming in */
  answering: boolean;
  copied: boolean;
  serverName(id: string): string;
  onInsert(text: string): void;
  onCopy(msg: Bot): void;
}

/** Mock 285–305: an answer, with the tools it called, then its text, or why it failed. The text is shown as typed, never as markup. */
function BotMessage({ msg, answering, copied, serverName, onInsert, onCopy }: BotProps) {
  return (
    <div className="msg-bot">
      {msg.tools.map((t) => (
        <ToolCard key={t.id} card={t} server={serverName(t.server)} />
      ))}
      {answering && !msg.text && <div className="msg-working">Working…</div>}
      {msg.text && <div className="msg-text">{msg.text}</div>}
      {msg.text && !answering && (
        <div className="msg-actions">
          <button className="line-btn" onClick={() => onInsert(msg.text)}>
            Insert into doc
          </button>
          <button className="head-btn small" onClick={() => onCopy(msg)}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {msg.error && <div className="msg-error">{msg.error}</div>}
    </div>
  );
}

/** Mock 287–294: a tool the assistant called, with what it was asked to do, and why it failed if it did. */
function ToolCard({ card, server }: { card: Card; server: string }) {
  return (
    <div className="tool-card">
      <div className="tool-card-head">
        <span className="tool-tile">{tileOf(server)}</span>
        <span className="tool-name">
          {server} · <span className="tool">{card.name}</span>
        </span>
        <span className={`tool-state ${card.state}`}>{STATE_LABEL[card.state]}</span>
      </div>
      <div className="tool-args" title={card.args}>
        {card.args}
      </div>
      {card.state === "error" && <div className="tool-message">{card.text}</div>}
    </div>
  );
}

/** A tool call an external AI client made in this window. */
function ExternalCard({ entry }: { entry: ActivityEntry }) {
  return (
    <div className="tool-card">
      <div className="tool-card-head">
        <span className="tool-tile">D</span>
        <span className="tool-name">
          External · docbro · <span className="tool">{entry.tool}</span>
        </span>
        <span className={`tool-state ${entry.state}`}>{STATE_LABEL[entry.state]}</span>
      </div>
      <div className="tool-args" title={entry.args}>
        {entry.args}
      </div>
      {entry.state === "error" && <div className="tool-message">{entry.message}</div>}
    </div>
  );
}
