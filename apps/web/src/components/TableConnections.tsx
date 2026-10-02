import { useEffect, useState, type SubmitEvent } from "react";
import { api, message, workspacePath, type Detail, type TableSummary } from "../lib/api";
import { ErrorNotice } from "./Shared";
import Select from "./Select";

type Connection = { id: string; name: string; dialect: "pg" | "mysql" | "sqlite" };
type Source = { schema: string; name: string };

export default function TableConnections({ detail, onConnected }: { detail: Detail; onConnected?: (table: TableSummary) => void }) {
  const path = `${workspacePath(detail.workspace.id)}/table-connections`;
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selected, setSelected] = useState("");
  const [dialect, setDialect] = useState<Connection["dialect"]>("pg");
  const [sources, setSources] = useState<Source[]>([]);
  const [source, setSource] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [result, setResult] = useState<TableSummary | null>(null);
  const canManage = detail.permissions.includes("credentials:manage");
  const canLink = canManage && detail.permissions.includes("tables:write") && detail.permissions.includes("tables:read");
  useEffect(() => {
    if (!canManage) { setLoading(false); return; }
    const controller = new AbortController();
    api<Connection[]>(path, "GET", undefined, controller.signal).then(rows => { if (!controller.signal.aborted) setConnections(rows); })
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, canManage]);
  async function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
    try {
      const created = await api<Connection>(path, "POST", { name: values.name, dialect,
        ...(dialect === "sqlite" ? { filename: values.filename } : { host: values.host, port: Number(values.port), database: values.database, username: values.username, password: values.password, tls: values.tls === "on" }),
      });
      setConnections(current => [...current, created]); setSelected(created.id); setSources([]); setSource(""); form.reset();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function browse() {
    setBusy(true); setError(""); setSources([]); setSource("");
    try { const catalog = await api<{ tables: Source[]; more: boolean }>(`${path}/${selected}/catalog`); setSources(catalog.tables); setMore(catalog.more); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function connect(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setResult(null);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const target: Source = JSON.parse(source);
      const table = await api<TableSummary>(`${workspacePath(detail.workspace.id)}/tables/connect`, "POST", { connectionId: selected, schema: target.schema, table: target.name, name: values.name || target.name, parentId: values.parentId || null });
      setResult(table); onConnected?.(table);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  if (!canManage) return <p className="notice">Managing SQL connections requires credential management permission.</p>;
  return <div className="stack">
    <ErrorNotice error={error} />
    <p className="muted">Link a PostgreSQL, MySQL, or SQLite table. Refresh reads current source rows; saving a cell writes directly to the database. The source needs a primary key. Connection secrets are encrypted and never returned to the browser.</p>
    {result && <p role="status">Connected. <a href={`/app?workspace=${detail.workspace.id}&node=${result.id}`}>Open {result.name}</a></p>}
    <div className="stack">
      <label>Saved connection<Select value={selected} disabled={loading || busy} onChange={event => { setSelected(event.target.value); setSources([]); setSource(""); }}>
        <option value="">Choose a connection</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} ({connection.dialect})</option>)}
      </Select></label>
      <div className="button-group"><button type="button" disabled={busy || !selected} onClick={browse}>Browse source tables</button>
        <button type="button" className="danger" disabled={busy || !selected} onClick={async () => {
          if (!window.confirm("Delete this saved connection? Linked Hopya Tables must be removed first.")) return;
          setBusy(true); setError("");
          try { await api(`${path}/${selected}`, "DELETE"); setConnections(current => current.filter(connection => connection.id !== selected)); setSelected(""); setSources([]); }
          catch (cause) { setError(message(cause)); } finally { setBusy(false); }
        }}>Delete connection</button></div>
      {sources.length > 0 && canLink && <form className="stack" onSubmit={connect}>
        <label>Source table<Select value={source} disabled={busy} onChange={event => setSource(event.target.value)}><option value="">Choose a source table</option>{sources.map(item => <option key={`${item.schema}.${item.name}`} value={JSON.stringify(item)}>{item.schema}.{item.name}</option>)}</Select></label>
        {more && <p className="notice">Showing the first 500 source tables. Use the connect API for tables beyond this catalog page.</p>}
        <label>Hopya Table name<input name="name" maxLength={120} disabled={busy} placeholder="Use source table name" /></label>
        <label>Location<Select name="parentId" disabled={busy}><option value="">Workspace root</option>{detail.nodes.filter(node => node.kind === "project" || node.kind === "folder").map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</Select></label>
        <div className="button-group"><button className="primary" disabled={busy || !source}>Connect live Table</button></div>
      </form>}
    </div>
    <details><summary>Add database connection</summary>
      <form className="stack" onSubmit={create}>
        <label>Connection name<input name="name" required maxLength={120} disabled={busy} /></label>
        <label>Database engine<Select value={dialect} disabled={busy} onChange={event => setDialect(event.target.value as Connection["dialect"])}><option value="pg">PostgreSQL</option><option value="mysql">MySQL</option><option value="sqlite">SQLite</option></Select></label>
        {dialect === "sqlite" ? <label>Database file<input name="filename" required maxLength={1024} disabled={busy} placeholder="inventory.sqlite" /><small>Existing file inside the server's SQL_SQLITE_ROOT directory.</small></label>
          : <div className="stack" key={dialect}>
            <label>Host<input name="host" required maxLength={253} disabled={busy} /><small>The host and port must be listed in the server's SQL_ALLOWED_HOSTS.</small></label>
            <label>Port<input name="port" type="number" min={1} max={65535} defaultValue={dialect === "pg" ? 5432 : 3306} required disabled={busy} /></label>
            <label>Database<input name="database" required maxLength={120} disabled={busy} /></label>
            <label>Username<input name="username" required maxLength={120} autoComplete="off" disabled={busy} /></label>
            <label>Password<input name="password" type="password" maxLength={4096} autoComplete="new-password" disabled={busy} /></label>
            <label className="checkbox-row"><input name="tls" type="checkbox" defaultChecked disabled={busy} /> Use verified TLS</label>
          </div>}
        <div className="button-group"><button disabled={busy}>{busy ? "Connecting..." : "Test and save connection"}</button></div>
      </form>
    </details>
  </div>;
}
