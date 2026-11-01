import { useEffect, useState } from "react";
import { api, type AssistantEngine, type AssistantStatus, type ProviderPreset } from "../api";
import { SaveRow, type EngineFormProps } from "./EngineForm";
import { ProviderFields } from "./ProviderFields";
import "./assistant.css";

const message = (e: unknown) => (e instanceof Error && e.message) || String(e);

const ENGINES: { id: AssistantEngine; label: string }[] = [
  { id: "claude_code", label: "Claude Code — uses your Claude subscription" },
  { id: "api_key", label: "Anthropic API key" },
  { id: "openai_compatible", label: "Other provider (OpenAI-compatible)" },
];

/**
 * Who answers in the Assistant: the user's Claude Code, the Anthropic API with their key, or
 * another provider. Keys are only ever known here by their last four characters.
 */
export function ModelSection() {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  // the engine whose settings are shown; it is picked when they are saved
  const [engine, setEngine] = useState<AssistantEngine | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.assistantStatus().then((s) => {
      setStatus(s);
      setEngine(s.engine);
    }, (e) => setError(message(e)));
    api.assistantPresets().then(setPresets, () => {});
  }, []);

  const save = async (p: Promise<AssistantStatus>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await p;
      setStatus(s);
      setEngine(s.engine);
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const shown = engine ?? status?.engine;
  const props = status && { status, busy, pending: shown !== status.engine, save };

  return (
    <section className="mcp-section">
      <h3 className="mcp-heading">Model</h3>
      <p className="mcp-lead">Pick who answers in the Assistant chat.</p>
      <div className="engine-list" role="radiogroup" aria-label="Engine">
        {ENGINES.map((e) => (
          <label key={e.id} className={`engine-row${shown === e.id ? " on" : ""}`}>
            <input
              type="radio"
              name="assistant-engine"
              checked={shown === e.id}
              disabled={!status}
              onChange={() => {
                setEngine(e.id);
                setError(null);
              }}
            />
            <span>{e.label}</span>
          </label>
        ))}
      </div>
      {props && shown === "claude_code" && <ClaudeCodeFields {...props} />}
      {props && shown === "api_key" && <ApiKeyFields {...props} />}
      {props && shown === "openai_compatible" && <ProviderFields {...props} presets={presets} />}
      {error && <div className="mcp-error" role="alert">{error}</div>}
    </section>
  );
}

/** `/Users/<name>/…` (or `/home/<name>/…`) as `~/…`. */
const tilde = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, "~");

/** The `claude` DocBro found, and the model it runs. */
function ClaudeCodeFields({ status, busy, pending, save }: EngineFormProps) {
  const [model, setModel] = useState(status.claude_model);
  useEffect(() => setModel(status.claude_model), [status]);

  const { found, path, version } = status.claude;
  const changed = pending || model.trim() !== status.claude_model;

  return (
    <div className="engine-form">
      <p className={`engine-status${found ? " on" : ""}`}>
        {found
          ? `Claude Code${version ? ` ${version}` : ""} found${path ? ` at ${tilde(path)}` : ""}`
          : "Claude Code was not found. Install it from claude.com/code."}
      </p>
      <label className="mcp-field wide">
        <span className="label">Model</span>
        <input
          aria-label="Model"
          className="code"
          value={model}
          placeholder="sonnet"
          spellCheck={false}
          onChange={(e) => setModel(e.target.value)}
        />
      </label>
      <p className="mcp-note">
        Your messages, the document text Claude reads and tool results go through your Claude Code and your Claude
        subscription. If Claude Code is not signed in, run claude in a terminal once and sign in.
      </p>
      <SaveRow
        pending={pending}
        disabled={!changed || !model.trim() || busy}
        onSave={() => void save(api.assistantSave(null, model.trim(), "claude_code"))}
      />
    </div>
  );
}

/** The Anthropic API key, which the webview only ever knows by its last four characters, and the model. */
function ApiKeyFields({ status, busy, pending, save }: EngineFormProps) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(status.model);
  useEffect(() => setModel(status.model), [status]);

  // a key too short to have a hint is still known to be saved while it is the engine in use
  const hasKey = status.key_hint !== null || (status.engine === "api_key" && status.configured);
  const saved = hasKey ? (status.key_hint ? `•••• ${status.key_hint}` : "Saved") : "";
  const changed = pending || key.trim() !== "" || model.trim() !== status.model;

  const saveKey = async () => {
    if (await save(api.assistantSave(key.trim() || null, model.trim(), "api_key"))) setKey("");
  };

  return (
    <div className="engine-form">
      <div className="mcp-field wide">
        <span className="label">API key</span>
        <input
          type="password"
          aria-label="API key"
          value={key}
          autoComplete="off"
          spellCheck={false}
          placeholder={hasKey ? "Paste a new key to replace it" : "sk-ant-…"}
          onChange={(e) => setKey(e.target.value)}
        />
        {saved && <span className="hint">{saved}</span>}
      </div>
      <label className="mcp-field wide">
        <span className="label">Model</span>
        <input aria-label="Model" className="code" value={model} spellCheck={false} onChange={(e) => setModel(e.target.value)} />
      </label>
      <p className="mcp-note">
        Your messages, the document text Claude reads and tool results are sent to the Anthropic API with your key. The
        key stays on this computer.
      </p>
      <SaveRow pending={pending} disabled={!changed || !model.trim() || busy} onSave={() => void saveKey()}>
        <button className="line-btn" disabled={!hasKey || busy} onClick={() => void save(api.assistantClearKey())}>
          Remove key
        </button>
      </SaveRow>
    </div>
  );
}
