import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type McpStatus, type ServerConfig, type ServerView } from "../api";
import { ModelSection } from "./ModelSection";
import { ServerForm } from "./ServerForm";
import "./assistant.css";

interface Client {
  id: string;
  name: string;
  /** what to do with the snippet */
  where: string;
  snippet: (s: McpStatus) => string;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);
const bearer = (s: McpStatus) => ({ Authorization: `Bearer ${s.token}` });

// Ported from SheetBro's McpPanel. Clients that speak HTTP get the URL and token; stdio-only
// ones run this app with --mcp-stdio, which relays to the running app (and needs no token).
const CLIENTS: Client[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    where: "Run in a terminal:",
    snippet: (s) => `claude mcp add --transport http docbro ${s.url} --header "Authorization: Bearer ${s.token}"`,
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    where: "Add to ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude:",
    snippet: (s) => json({ mcpServers: { docbro: { command: s.command, args: ["--mcp-stdio"] } } }),
  },
  {
    id: "cursor",
    name: "Cursor",
    where: "Add to ~/.cursor/mcp.json:",
    snippet: (s) => json({ mcpServers: { docbro: { url: s.url, headers: bearer(s) } } }),
  },
  {
    id: "vscode",
    name: "VS Code",
    where: "Add to .vscode/mcp.json (or your user MCP configuration):",
    snippet: (s) => json({ servers: { docbro: { type: "http", url: s.url, headers: bearer(s) } } }),
  },
  {
    id: "windsurf",
    name: "Windsurf",
    where: "Add to ~/.codeium/windsurf/mcp_config.json:",
    snippet: (s) => json({ mcpServers: { docbro: { serverUrl: s.url, headers: bearer(s) } } }),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    where: "Add to ~/.gemini/settings.json:",
    snippet: (s) => json({ mcpServers: { docbro: { httpUrl: s.url, headers: bearer(s) } } }),
  },
  {
    id: "codex",
    name: "Codex CLI",
    where: "Add to ~/.codex/config.toml:",
    snippet: (s) => `[mcp_servers.docbro]\ncommand = ${JSON.stringify(s.command)}\nargs = ["--mcp-stdio"]`,
  },
  {
    id: "other",
    name: "Other",
    where: "Any MCP client: use the HTTP details, or the command if it only runs local servers.",
    snippet: (s) =>
      `HTTP (streamable)\n  URL:      ${s.url}\n  Header:   Authorization: Bearer ${s.token}\n\nstdio\n  Command:  ${s.command}\n  Args:     --mcp-stdio`,
  },
];

const portOk = (p: string) => Number(p) >= 1024 && Number(p) <= 65535;
const message = (e: unknown) => (e instanceof Error && e.message) || String(e);

interface Props {
  /** Closes the sheet and gives the editor its focus back. */
  onClose(): void;
  /** opens on the form that adds a server */
  addServer?: boolean;
}

/**
 * MCP settings: a sheet over the window with the command palette's chrome (mock 332–334). The
 * Assistant's model and the user's servers come first, then Serve DocBro, the server external
 * AI clients connect to. Adding or editing a server takes the whole sheet.
 */
export function McpSettings({ onClose, addServer = false }: Props) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<ServerView[]>([]);
  // the server form, and the server it edits (null adds one)
  const [form, setForm] = useState<{ editing: ServerView | null } | null>(addServer ? { editing: null } : null);
  const [port, setPort] = useState("");
  const [clientId, setClientId] = useState(CLIENTS[0].id);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"token" | "snippet" | null>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sheet.current?.focus();
    api.mcpStatus().then((s) => {
      setStatus(s);
      setPort(String(s.port));
    }, (e) => setError(message(e)));
    api.serversList().then(setServers, () => {});
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const change = async (p: Promise<McpStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await p);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (what: "token" | "snippet", text: string) => {
    try {
      await writeText(text);
      setCopied(what);
    } catch (e) {
      setError(message(e));
    }
  };

  const regenerate = async () => {
    const yes = await ask("Tools you already connected will be locked out until you paste the new settings into them.", {
      title: "Create a new access token?",
      kind: "warning",
      okLabel: "Create new token",
      cancelLabel: "Cancel",
    });
    if (yes) await change(api.mcpRegenerateToken());
  };

  const closeForm = () => {
    setForm(null);
    sheet.current?.focus();
  };

  // Esc leaves the server form first, then the sheet
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (form) closeForm();
    else onClose();
  };

  const on = status?.running ?? false;
  const client = CLIENTS.find((c) => c.id === clientId) ?? CLIENTS[0];
  const problem = error ?? status?.error ?? null;

  return (
    <div className="pal-overlay" onMouseDown={onClose}>
      <div
        className="pal mcp-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-settings-title"
        tabIndex={-1}
        ref={sheet}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="mcp-sheet-head">
          <span id="mcp-settings-title" className="title">
            MCP settings
          </span>
          <div className="spacer" />
          <span className="kbd">esc</span>
          <button className="close-btn" title="Close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="mcp-sheet-body">
          {form ? (
            <ServerForm
              editing={form.editing}
              taken={servers.map((s) => s.id)}
              onSaved={(views) => {
                setServers(views);
                closeForm();
              }}
              onCancel={closeForm}
            />
          ) : (
            <>
              <ModelSection />
              <ServersSection servers={servers} onChange={setServers} onEdit={(editing) => setForm({ editing })} />
              <section className="mcp-section">
                <div className="mcp-row">
                  <button
                    className="mcp-row-toggle"
                    aria-expanded={open}
                    aria-controls="serve-docbro"
                    onClick={() => setOpen((o) => !o)}
                  >
                    <span className="chevron">{open ? "▾" : "▸"}</span>
                    <span className="mcp-row-text">
                      <span className="name">Serve DocBro</span>
                      <span className={`sub${on ? " on" : ""}`}>{on ? `On · 127.0.0.1:${status?.port}` : "Off"}</span>
                    </span>
                  </button>
                  <button
                    className={`switch${on ? " on" : ""}`}
                    role="switch"
                    aria-checked={on}
                    aria-label="Serve DocBro"
                    disabled={!status || busy || (!on && !portOk(port))}
                    onClick={() => change(on ? api.mcpSetEnabled(false) : api.mcpSetEnabled(true, Number(port)))}
                  >
                    <span />
                  </button>
                </div>
                {problem && <div className="mcp-error" role="alert">{problem}</div>}
                {open && status && (
                  <div className="mcp-details" id="serve-docbro">
                    <p className="mcp-lead">
                      Lets AI tools like Claude, Cursor or Codex read and edit the document you have open. It listens on
                      this computer only, and every change they make can be undone.
                    </p>
                    <label className="mcp-field">
                      <span className="label">Port</span>
                      <input
                        value={port}
                        inputMode="numeric"
                        spellCheck={false}
                        disabled={on || busy}
                        aria-invalid={!portOk(port)}
                        onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))}
                      />
                      <span className="hint">
                        {on ? "Switch off to change it." : portOk(port) ? "" : "Choose a port between 1024 and 65535."}
                      </span>
                    </label>
                    <div className="mcp-field">
                      <span className="label">Token</span>
                      <input className="code" value={status.token} readOnly aria-label="Access token" />
                      <button className="line-btn" onClick={() => copy("token", status.token)}>
                        {copied === "token" ? "Copied" : "Copy"}
                      </button>
                      <button className="line-btn" disabled={busy} onClick={regenerate}>
                        Regenerate
                      </button>
                    </div>
                    <div className="mcp-clients" role="tablist" aria-label="AI tool">
                      {CLIENTS.map((c) => (
                        <button
                          key={c.id}
                          role="tab"
                          aria-selected={c.id === client.id}
                          className={`pal-tab${c.id === client.id ? " on" : ""}`}
                          onClick={() => setClientId(c.id)}
                        >
                          {c.name}
                        </button>
                      ))}
                    </div>
                    <div className="mcp-where">
                      <span>{client.where}</span>
                      <button className="line-btn" onClick={() => copy("snippet", client.snippet(status))}>
                        {copied === "snippet" ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <pre className="mcp-snippet">
                      <code>{client.snippet(status)}</code>
                    </pre>
                    <p className="mcp-note">
                      {on
                        ? "These settings contain a private access token. Don't share them."
                        : "Switch Serve DocBro on before you connect a tool."}
                    </p>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A saved server as a config for `servers_test`: its secrets as empty values, which Rust fills from the saved ones. */
function savedConfig(v: ServerView): ServerConfig {
  const secrets = Object.fromEntries(v.secret_keys.map((k) => [k, ""]));
  const spec: ServerConfig["spec"] =
    v.transport === "http"
      ? { transport: "http", url: v.url ?? "", headers: secrets }
      : { transport: "stdio", command: v.command ?? "", args: v.args, env: secrets };
  return { id: v.id, name: v.name, enabled: v.enabled, spec };
}

interface ServersProps {
  servers: ServerView[];
  onChange(views: ServerView[]): void;
  onEdit(server: ServerView | null): void;
}

/** The user's MCP servers. Error text comes from the server: it is shown as text, never as markup. */
function ServersSection({ servers, onChange, onEdit }: ServersProps) {
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string } | "running">>({});
  const [error, setError] = useState<string | null>(null);

  const test = async (v: ServerView) => {
    setTests((t) => ({ ...t, [v.id]: "running" }));
    let result: { ok: boolean; text: string };
    try {
      const tools = await api.serversTest(savedConfig(v));
      result = { ok: true, text: tools.length ? `Tools: ${tools.join(", ")}` : "Connected. It has no tools." };
    } catch (e) {
      result = { ok: false, text: message(e) };
    }
    setTests((t) => ({ ...t, [v.id]: result }));
  };

  const remove = async (v: ServerView) => {
    const yes = await ask("The Assistant can no longer use its tools.", {
      title: `Remove ${v.name}?`,
      kind: "warning",
      okLabel: "Remove",
      cancelLabel: "Cancel",
    });
    if (!yes) return;
    setError(null);
    api.serversRemove(v.id).then(onChange, (e) => setError(message(e)));
  };

  return (
    <section className="mcp-section">
      <h3 className="mcp-heading">Servers</h3>
      <p className="mcp-lead">
        MCP servers the Assistant can use. One only runs while it is switched on in the Assistant panel.
      </p>
      <div className="server-list">
        {servers.map((v) => {
          const result = tests[v.id];
          return (
            <div className="server-item" key={v.id}>
              <div className="mcp-row">
                <span className={`dot ${v.status}`} title={STATUS[v.status]} />
                <span className="mcp-row-text">
                  <span className="name">{v.name}</span>
                  <span className="sub">
                    {STATUS[v.status]}
                    {v.tools ? ` · ${v.tools} tools` : ""} · {v.summary}
                  </span>
                </span>
                <button className="line-btn" onClick={() => onEdit(v)}>
                  Edit
                </button>
                <button
                  className="line-btn"
                  disabled={!v.enabled || result === "running"}
                  title={v.enabled ? undefined : "Switch it on in the Assistant panel to test it."}
                  onClick={() => test(v)}
                >
                  {result === "running" ? "Testing…" : "Test"}
                </button>
                <button className="line-btn" onClick={() => remove(v)}>
                  Remove
                </button>
              </div>
              {v.error && <div className="mcp-error">{v.error}</div>}
              {result && result !== "running" && <div className={result.ok ? "server-tested" : "mcp-error"}>{result.text}</div>}
            </div>
          );
        })}
        {error && <div className="mcp-error" role="alert">{error}</div>}
        <button className="add-btn" onClick={() => onEdit(null)}>
          + Add MCP server
        </button>
      </div>
    </section>
  );
}

const STATUS: Record<ServerView["status"], string> = { off: "Off", ready: "On", error: "Not working" };
