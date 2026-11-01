import { useState } from "react";
import { api, type ServerConfig, type ServerSpec, type ServerView } from "../api";

/** A header or environment variable. A saved one comes back with its name only: an empty value keeps it. */
interface Row {
  name: string;
  value: string;
  saved?: boolean;
}

const SHEETBRO_URL = "http://127.0.0.1:7424/mcp";
const MAX_ID = 32;
// what Rust accepts (mcp_client.rs, `validate`)
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

const message = (e: unknown) => (e instanceof Error && e.message) || String(e);

/**
 * Arguments typed on one line, split at spaces. Quotes keep spaces in an argument: '…' as is,
 * "…" with \" and \\ for a quote and a backslash inside. Other backslashes are kept, so
 * Windows paths survive. `open` is true when a quote is never closed.
 */
function parseArgs(text: string): { args: string[]; open: boolean } {
  const args: string[] = [];
  let arg = "";
  let started = false; // an argument is open, even an empty "" one
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) arg += text[++i];
      else arg += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) args.push(arg);
      arg = "";
      started = false;
    } else {
      arg += c;
      started = true;
    }
  }
  if (started) args.push(arg);
  return { args, open: quote !== null };
}

export const splitArgs = (text: string) => parseArgs(text).args;

/** One argument written so that `splitArgs` reads it back unchanged: quoted, with \ and " escaped, unless it is plain. */
export const quoteArg = (a: string) => (a && !/[\s"'\\]/.test(a) ? a : `"${a.replace(/[\\"]/g, "\\$&")}"`);

/** The command line as Rust shows it (`ServerSpec::summary`): for reading, not for parsing back. */
export const commandLine = (command: string, args: string[]) =>
  [command, ...args].map((a) => (a && !/[\s"]/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(" ");

/** `scheme://host[:port]` of a URL, as Rust compares them (servers.rs, `same_target`); null when it is not one. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** A new server's id, from its name: lowercase, unique, never `docbro`. */
function newId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_ID).replace(/-+$/, "") || "server";
  const used = new Set([...taken, "docbro"]);
  for (let n = 1; ; n++) {
    const tail = n === 1 ? "" : `-${n}`;
    const id = base.slice(0, MAX_ID - tail.length) + tail;
    if (!used.has(id)) return id;
  }
}

/** The first thing that stops the form from being saved, in words; null when it can be. */
function problem(
  name: string,
  transport: ServerSpec["transport"],
  url: string,
  command: string,
  openQuote: boolean,
  rows: Row[],
  kept: boolean,
): string | null {
  if (!name.trim()) return "Give the server a name.";
  const lost = rows.find((r) => r.saved && !r.value && !kept);
  if (lost) return `Enter the value of ${lost.name} again.`;
  if (transport === "http") {
    if (!/^https?:\/\/[^\s/?#]+/i.test(url.trim())) return "The URL must start with http:// or https://.";
    for (const r of rows) {
      if (!r.name) return "Give every header a name.";
      if (!HEADER_NAME.test(r.name)) return `"${r.name}" is not a valid header name.`;
      if (!HEADER_VALUE.test(r.value)) return `The value of the ${r.name} header contains a character headers cannot hold.`;
      if (r.value.trim() === "Bearer") return `Paste the token after "Bearer" in the ${r.name} header.`;
    }
  } else {
    if (!command.trim()) return "Enter the command to run.";
    if (openQuote) return "A quote in the arguments is not closed.";
    for (const r of rows) {
      if (!r.name) return "Give every variable a name.";
      if (r.name.includes("=")) return `"${r.name}" is not a valid environment variable name.`;
    }
  }
  return null;
}

interface Props {
  /** the server being edited; null adds one */
  editing: ServerView | null;
  /** ids in use, so a new server gets one of its own */
  taken: string[];
  onSaved(views: ServerView[]): void;
  onCancel(): void;
}

/**
 * Adds or edits one of the user's MCP servers. A Command server runs a program on this
 * computer, so testing or saving one first says which command line will run, and waits for a
 * confirm.
 */
export function ServerForm({ editing, taken, onSaved, onCancel }: Props) {
  const savedRows = (kind: ServerSpec["transport"]) =>
    editing?.transport === kind ? editing.secret_keys.map((name) => ({ name, value: "", saved: true })) : [];
  const [name, setName] = useState(editing?.name ?? "");
  const [transport, setTransport] = useState<ServerSpec["transport"]>(editing?.transport ?? "http");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [headers, setHeaders] = useState<Row[]>(() => savedRows("http"));
  const [command, setCommand] = useState(editing?.command ?? "");
  const [args, setArgs] = useState(() => editing?.args.map(quoteArg).join(" ") ?? "");
  const [env, setEnv] = useState<Row[]>(() => savedRows("stdio"));
  const [confirm, setConfirm] = useState<"save" | "test" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);

  const id = editing?.id ?? newId(name, taken);
  const http = transport === "http";
  const rows = http ? headers : env;
  const setRows = http ? setHeaders : setEnv;
  // a row left blank is no row
  const filled = rows.filter((r) => r.name.trim() || r.value || r.saved).map((r) => ({ ...r, name: r.name.trim() }));
  // Rust only fills empty saved values in for the same origin or command, so a token never goes to another host
  const kept =
    editing?.transport === transport &&
    (http ? originOf(url) !== null && originOf(url) === originOf(editing.url ?? "") : command.trim() === editing.command?.trim());
  const { args: argList, open: openQuote } = parseArgs(args);
  const invalid = problem(name, transport, url, command, openQuote, filled, kept);
  const line = commandLine(command.trim(), argList);

  const config = (): ServerConfig => {
    const values = Object.fromEntries(filled.map((r) => [r.name, r.value]));
    const spec: ServerSpec = http
      ? { transport: "http", url: url.trim(), headers: values }
      : { transport: "stdio", command: command.trim(), args: argList, env: values };
    return { id, name: name.trim(), enabled: editing?.enabled ?? true, spec };
  };

  const run = async (what: "save" | "test") => {
    setConfirm(null);
    setBusy(true);
    setError(null);
    setTested(null);
    try {
      if (what === "save") onSaved(await api.serversSave(config()));
      else {
        const tools = await api.serversTest(config());
        setTested({ ok: true, text: tools.length ? `Tools: ${tools.join(", ")}` : "Connected. It has no tools." });
      }
    } catch (e) {
      if (what === "save") setError(message(e));
      else setTested({ ok: false, text: message(e) });
    } finally {
      setBusy(false);
    }
  };
  // a Command server runs only once the person has seen the command line
  const start = (what: "save" | "test") => (http ? run(what) : setConfirm(what));

  const sheetbro = () => {
    setName((n) => n || "SheetBro");
    setTransport("http");
    setUrl(SHEETBRO_URL);
    setHeaders([{ name: "Authorization", value: "Bearer " }]);
  };

  const edit = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const what = http ? "Header" : "Variable";

  return (
    <div className="server-form">
      <div className="server-form-head">
        <span className="name">{editing ? `Edit ${editing.name}` : "Add MCP server"}</span>
        <div className="spacer" />
        {!editing && (
          <button className="line-btn" onClick={sheetbro}>
            SheetBro preset
          </button>
        )}
      </div>
      <label className="mcp-field wide">
        <span className="label">Name</span>
        <input aria-label="Name" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className="mcp-note">Start a chat message with @{id} to leave your other servers out of it.</p>
      <div className="mcp-field wide">
        <span className="label">Type</span>
        <div className="segmented" role="radiogroup" aria-label="Type">
          {(["http", "stdio"] as const).map((t) => (
            <button key={t} role="radio" aria-checked={transport === t} className={transport === t ? "on" : ""} onClick={() => setTransport(t)}>
              {t === "http" ? "HTTP" : "Command"}
            </button>
          ))}
        </div>
      </div>
      {http ? (
        <label className="mcp-field wide">
          <span className="label">URL</span>
          <input aria-label="URL" className="code" value={url} spellCheck={false} placeholder="https://…/mcp" onChange={(e) => setUrl(e.target.value)} />
        </label>
      ) : (
        <>
          <label className="mcp-field wide">
            <span className="label">Command</span>
            <input aria-label="Command" className="code" value={command} spellCheck={false} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
          </label>
          <label className="mcp-field wide">
            <span className="label">Arguments</span>
            <input aria-label="Arguments" className="code" value={args} spellCheck={false} placeholder='-y "@scope/server"' onChange={(e) => setArgs(e.target.value)} />
          </label>
        </>
      )}
      <div className="server-rows">
        <span className="label">{http ? "Headers" : "Environment"}</span>
        {rows.map((r, i) => (
          <div className="server-row" key={i}>
            <input aria-label={`${what} ${i + 1} name`} className="code" value={r.name} spellCheck={false} placeholder="Name"
              onChange={(e) => edit(i, { name: e.target.value, saved: false })} />
            <input aria-label={`${what} ${i + 1} value`} className="code" value={r.value} spellCheck={false}
              placeholder={r.saved ? "Saved. Leave empty to keep it." : "Value"} onChange={(e) => edit(i, { value: e.target.value })} />
            <button className="close-btn" aria-label={`Remove ${what.toLowerCase()} ${i + 1}`} title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        {!kept && rows.some((r) => r.saved) && (
          <p className="mcp-note">The saved values are not sent to a different server. Enter them again.</p>
        )}
        <button className="add-btn" onClick={() => setRows([...rows, { name: "", value: "" }])}>
          {http ? "+ Add header" : "+ Add variable"}
        </button>
      </div>
      {confirm ? (
        <div className="server-confirm" role="alertdialog" aria-label="Run this command?">
          <p>
            DocBro will run: <code>{line}</code>{" "}
            {confirm === "save" ? "on this computer whenever this server is on." : "on this computer to test it."} Continue?
          </p>
          <div className="server-actions">
            <div className="spacer" />
            <button className="line-btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="line-btn primary" onClick={() => run(confirm)}>
              Run it
            </button>
          </div>
        </div>
      ) : (
        <>
          {tested && <div className={tested.ok ? "server-tested" : "mcp-error"}>{tested.text}</div>}
          {error && <div className="mcp-error" role="alert">{error}</div>}
          {invalid && name.trim() && <div className="mcp-note">{invalid}</div>}
          <div className="server-actions">
            <button className="line-btn" disabled={!!invalid || busy} onClick={() => start("test")}>
              {busy ? "Working…" : "Test"}
            </button>
            <div className="spacer" />
            <button className="line-btn" onClick={onCancel}>
              Cancel
            </button>
            <button className="line-btn primary" disabled={!!invalid || busy} onClick={() => start("save")}>
              Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}
