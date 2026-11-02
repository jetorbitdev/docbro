import { useEffect, useState } from "react";
import { api, type ProviderPreset } from "../api";
import { SaveRow, type EngineFormProps } from "./EngineForm";
import { originOf } from "./ServerForm";

const message = (e: unknown) => (e instanceof Error && e.message) || String(e);

/** The host of `url`, lowercase; null when it is not a web address. */
function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).hostname || null;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Another provider through its OpenAI-compatible API: a preset fills the base URL, which stays
 * editable; the model is typed or picked from the provider's list. The list is loaded with the
 * form as it is, before it is saved, and loading it never saves or switches the engine.
 */
export function ProviderFields({ status, busy, pending, save, presets }: EngineFormProps & { presets: ProviderPreset[] }) {
  const saved = status.openai;
  const [preset, setPreset] = useState(saved.preset);
  const [baseUrl, setBaseUrl] = useState(saved.base_url);
  const [key, setKey] = useState("");
  const [askKey, setAskKey] = useState(false);
  const [model, setModel] = useState(saved.model);
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    setPreset(saved.preset);
    setBaseUrl(saved.base_url);
    setModel(saved.model);
  }, [saved]);

  const chosen = presets.find((p) => p.id === preset);
  // a blank base URL is the preset's
  const target = baseUrl.trim() || chosen?.base_url || "";
  // Rust drops a saved key when the base URL's origin changes, so it never goes to another server
  const sameServer = originOf(target) !== null && originOf(target) === originOf(saved.base_url);
  const keySaved = saved.key_hint !== null && sameServer;
  const keyLost = saved.key_hint !== null && !sameServer;
  const showKey = chosen?.key_required !== false || preset === "custom" || askKey || key !== "" || saved.key_hint !== null;
  const host = hostOf(target);
  const provider = preset === "custom" || !chosen ? host ?? "the provider" : chosen.name;
  const leaves =
    host && LOOPBACK.has(host)
      ? "Everything stays on this computer."
      : `Your messages, the document text the model reads and tool results are sent to ${provider}.`;
  const changed =
    pending || preset !== saved.preset || baseUrl.trim() !== saved.base_url || model.trim() !== saved.model || key.trim() !== "";

  const pickPreset = (id: string) => {
    setPreset(id);
    setBaseUrl(presets.find((p) => p.id === id)?.base_url ?? "");
    // a key typed for one provider never goes to the next one picked
    setKey("");
    setAskKey(false);
    setModels(null);
    setListError(null);
  };

  const loadModels = async () => {
    setLoading(true);
    setListError(null);
    try {
      setModels(await api.assistantListModels({ preset, base_url: target, api_key: key.trim() || null }));
    } catch (e) {
      setModels(null);
      setListError(message(e));
    } finally {
      setLoading(false);
    }
  };

  const saveProvider = async () => {
    if (await save(api.assistantSaveOpenai(preset, baseUrl.trim(), model.trim(), key.trim() || null))) setKey("");
  };

  return (
    <div className="engine-form">
      <label className="mcp-field wide">
        <span className="label">Provider</span>
        <select aria-label="Provider" value={preset} onChange={(e) => pickPreset(e.target.value)}>
          {!chosen && <option value={preset}>{preset}</option>}
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="mcp-field wide">
        <span className="label">Base URL</span>
        <input
          aria-label="Base URL"
          className="code"
          value={baseUrl}
          spellCheck={false}
          placeholder="https://…/v1"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      {showKey ? (
        <div className="mcp-field wide">
          <span className="label">API key</span>
          <input
            type="password"
            aria-label="API key"
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder={keySaved ? "Paste a new key to replace it" : chosen?.key_required === false ? "Optional" : "Paste the provider's key"}
            onChange={(e) => setKey(e.target.value)}
          />
          {keySaved && <span className="hint">•••• {saved.key_hint}</span>}
        </div>
      ) : (
        <div className="mcp-field wide">
          <span className="label" />
          <button className="line-btn" onClick={() => setAskKey(true)}>
            + API key
          </button>
        </div>
      )}
      {keyLost && <p className="mcp-note field-note">The saved key is not sent to a different server. Enter it again.</p>}
      <div className="mcp-field wide">
        <span className="label">Model</span>
        <input aria-label="Model" className="code" value={model} spellCheck={false} onChange={(e) => setModel(e.target.value)} />
        <button className="line-btn" disabled={loading || !target} onClick={() => void loadModels()}>
          {loading ? "Loading…" : "Load models"}
        </button>
      </div>
      {models && models.length > 0 && (
        <label className="mcp-field wide">
          <span className="label" />
          <select aria-label="Loaded models" value={models.includes(model.trim()) ? model.trim() : ""} onChange={(e) => setModel(e.target.value)}>
            <option value="" disabled>
              Pick one of {models.length} models
            </option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      )}
      {models && models.length === 0 && <p className="mcp-note field-note">The provider listed no models. Type the model's name.</p>}
      {listError && <div className="mcp-error field-note">{listError}</div>}
      <p className="mcp-note">{leaves}</p>
      <SaveRow pending={pending} disabled={!changed || busy} onSave={() => void saveProvider()}>
        <button className="line-btn" disabled={saved.key_hint === null || busy} onClick={() => void save(api.assistantClearKey("openai_compatible"))}>
          Remove key
        </button>
      </SaveRow>
    </div>
  );
}
