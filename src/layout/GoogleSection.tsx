import { useEffect, useRef, useState } from "react";
import { api, type GoogleStatus } from "../api";
import "./assistant.css";

const message = (e: unknown) => (e instanceof Error && e.message) || String(e);

interface Props {
  /** scrolled into view when the sheet opens, for an upload that found no account */
  focus?: boolean;
}

/**
 * Google Docs: the Google account documents are uploaded to, and the OAuth client DocBro signs in
 * with. The client's secret is only ever known here by its last four characters, and no token is.
 */
export function GoogleSection({ focus = false }: Props) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showClient, setShowClient] = useState(false);
  const section = useRef<HTMLElement>(null);
  // set by Cancel, so the sign-in it stops reports no error
  const cancelled = useRef(false);

  useEffect(() => {
    api.googleStatus().then(setStatus, (e) => setError(message(e)));
  }, []);

  useEffect(() => {
    if (focus) section.current?.scrollIntoView?.({ block: "start" });
  }, [focus]);

  // a sign-in started before the sheet was opened: watch for its end
  const signingIn = status?.signing_in ?? false;
  useEffect(() => {
    if (!signingIn || busy) return;
    const t = window.setInterval(() => api.googleStatus().then(setStatus, () => {}), 1000);
    return () => window.clearInterval(t);
  }, [signingIn, busy]);

  const run = async (p: Promise<GoogleStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await p);
      return true;
    } catch (e) {
      if (!cancelled.current) setError(message(e));
      return false;
    } finally {
      cancelled.current = false;
      setBusy(false);
    }
  };

  const connect = async () => {
    cancelled.current = false;
    // the sheet shows the wait at once; Rust says the same once it listens
    setStatus((s) => s && { ...s, signing_in: true });
    if (!(await run(api.googleConnect()))) api.googleStatus().then(setStatus, () => {});
  };

  const cancel = () => {
    cancelled.current = true;
    void api.googleCancel();
    if (!busy) void run(api.googleStatus());
  };

  const hasClient = !!status?.client_id;
  const clientOpen = showClient || (status !== null && !hasClient);

  return (
    <section className="mcp-section google-section" ref={section}>
      <h3 className="mcp-heading">Google Docs</h3>
      <p className="mcp-lead">
        File ▸ Upload to Google Docs puts the open document in your Google Drive as a Google Doc. Uploading the same file
        again updates that Google Doc. DocBro can reach only the files it uploaded, nothing else in your Drive.
      </p>
      <div className="mcp-row">
        <span className={`dot ${status?.connected ? "ready" : "off"}`} />
        <span className="mcp-row-text">
          <span className="name">{status?.connected ? status.email ?? "Google account" : "Not connected"}</span>
          <span className={`sub${status?.connected ? " on" : ""}`}>
            {status?.connected ? "Connected" : signingIn ? "Waiting for you to sign in in the browser…" : "No Google account"}
          </span>
        </span>
        {status?.connected ? (
          <button className="line-btn" disabled={busy} onClick={() => void run(api.googleDisconnect())}>
            Disconnect
          </button>
        ) : signingIn ? (
          <button className="line-btn" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button
            className="line-btn primary"
            disabled={!hasClient || busy}
            title={hasClient ? undefined : "Enter an OAuth client first."}
            onClick={() => void connect()}
          >
            Connect
          </button>
        )}
      </div>
      {error && <div className="mcp-error" role="alert">{error}</div>}
      {status && hasClient && (
        <button className="mcp-row-toggle google-client-toggle" aria-expanded={clientOpen} onClick={() => setShowClient((o) => !o)}>
          <span className="chevron">{clientOpen ? "▾" : "▸"}</span>
          <span className="sub">OAuth client{status.custom_client ? "" : " (this build's)"}</span>
        </button>
      )}
      {status && clientOpen && <ClientFields status={status} busy={busy} save={run} />}
    </section>
  );
}

/** The user's own OAuth client: its ID, and its secret, known here only by its last four characters. */
function ClientFields({ status, busy, save }: { status: GoogleStatus; busy: boolean; save(p: Promise<GoogleStatus>): Promise<boolean> }) {
  const [id, setId] = useState(status.custom_client ? status.client_id : "");
  const [secret, setSecret] = useState("");
  useEffect(() => setId(status.custom_client ? status.client_id : ""), [status]);

  const saved = status.custom_client ? status.client_id : "";
  const changed = id.trim() !== saved || secret.trim() !== "";
  const otherClient = status.connected && id.trim() !== status.client_id;

  const submit = async () => {
    if (await save(api.googleSaveClient(id.trim(), secret.trim() || null))) setSecret("");
  };

  return (
    <div className="engine-form google-client">
      <label className="mcp-field wide">
        <span className="label">Client ID</span>
        <input
          aria-label="Client ID"
          className="code"
          value={id}
          spellCheck={false}
          placeholder={status.built_in ? "Leave empty to use this build's client" : "…apps.googleusercontent.com"}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      <div className="mcp-field wide">
        <span className="label">Client secret</span>
        <input
          type="password"
          aria-label="Client secret"
          value={secret}
          autoComplete="off"
          spellCheck={false}
          placeholder={status.secret_hint ? "Paste a new secret to replace it" : "GOCSPX-…"}
          onChange={(e) => setSecret(e.target.value)}
        />
        {status.secret_hint && <span className="hint">•••• {status.secret_hint}</span>}
      </div>
      <p className="mcp-note">
        In Google Cloud Console,{" "}
        <button className="text-link" onClick={() => void api.googleOpenConsole("drive_api")}>
          turn on the Google Drive API
        </button>
        , then{" "}
        <button className="text-link" onClick={() => void api.googleOpenConsole("oauth_client")}>
          create an OAuth client ID
        </button>{" "}
        of type Desktop app.{otherClient ? " Saving another client disconnects your Google account." : ""}
      </p>
      <div className="server-actions">
        <div className="spacer" />
        <button className="line-btn primary" disabled={!changed || busy} onClick={() => void submit()}>
          Save
        </button>
      </div>
    </div>
  );
}
