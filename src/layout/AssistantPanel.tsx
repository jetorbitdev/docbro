import { useEffect, useRef, useSyncExternalStore } from "react";
import { activity, type ActivityEntry } from "../mcp/activity";
import "./assistant.css";

interface Props {
  onClose(): void;
  onSettings(): void;
}

const STATE_LABEL: Record<ActivityEntry["state"], string> = { running: "Running…", done: "✓ Done", error: "Failed" };

/**
 * Mock 231–329, first slice: the header, and the tool calls external AI clients make in this
 * window as compact cards. The chat (Tasks 15–17) joins this stream.
 */
export function AssistantPanel({ onClose, onSettings }: Props) {
  const calls = useSyncExternalStore(activity.subscribe, activity.list);
  const stream = useRef<HTMLDivElement>(null);

  // the newest call is at the bottom, like a chat
  useEffect(() => {
    const el = stream.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [calls]);

  return (
    <>
      <div className="assistant-head">
        <span className="title">Assistant</span>
        <span className="pill">MCP</span>
        <div className="spacer" />
        <button className="head-btn" title="Clear the tool calls" onClick={activity.clear}>
          New
        </button>
        <button className="icon-btn" title="MCP settings" aria-label="MCP settings" onClick={onSettings}>
          ⚙
        </button>
        <button className="close-btn" title="Close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="assistant-stream" ref={stream}>
        {calls.length ? (
          calls.map((c) => <ToolCard key={c.id} entry={c} />)
        ) : (
          <div className="assistant-empty">
            <p>Connect an AI tool in MCP settings and its edits show up here.</p>
            <button className="line-btn" onClick={onSettings}>
              Open MCP settings
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** Mock 287–294: one tool call, with what it was asked to do, and why it failed if it did. */
function ToolCard({ entry }: { entry: ActivityEntry }) {
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
