import { useEffect, useState } from "react";
import { api, type AssistantStatus } from "../api";
import "./assistant.css";

const message = (e: unknown) => (e instanceof Error && e.message) || String(e);

/** The Anthropic API key, which the webview only ever knows by its last four characters, and the model. */
export function ModelSection() {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.assistantStatus().then((s) => {
      setStatus(s);
      setModel(s.model);
    }, (e) => setError(message(e)));
  }, []);

  const change = async (p: Promise<AssistantStatus>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await p;
      setStatus(s);
      setModel(s.model);
      setKey("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const saved = status?.configured ? (status.key_hint ? `•••• ${status.key_hint}` : "Saved") : "";
  const changed = key.trim() !== "" || (status !== null && model.trim() !== status.model);

  return (
    <section className="mcp-section">
      <h3 className="mcp-heading">Model</h3>
      <p className="mcp-lead">
        The Assistant chats with Claude over the Anthropic API, with your own API key. The key stays on this computer.
      </p>
      <div className="mcp-field wide">
        <span className="label">API key</span>
        <input
          type="password"
          aria-label="API key"
          value={key}
          autoComplete="off"
          spellCheck={false}
          placeholder={status?.configured ? "Paste a new key to replace it" : "sk-ant-…"}
          onChange={(e) => setKey(e.target.value)}
        />
        {saved && <span className="hint">{saved}</span>}
      </div>
      <label className="mcp-field wide">
        <span className="label">Model</span>
        <input aria-label="Model" className="code" value={model} spellCheck={false} onChange={(e) => setModel(e.target.value)} />
      </label>
      {error && <div className="mcp-error" role="alert">{error}</div>}
      <div className="server-actions">
        <div className="spacer" />
        <button className="line-btn" disabled={!status?.configured || busy} onClick={() => change(api.assistantClearKey())}>
          Remove key
        </button>
        <button
          className="line-btn primary"
          disabled={!status || !changed || !model.trim() || busy}
          onClick={() => change(api.assistantSave(key.trim() || null, model.trim()))}
        >
          Save
        </button>
      </div>
    </section>
  );
}
