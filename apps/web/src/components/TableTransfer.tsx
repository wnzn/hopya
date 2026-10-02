import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { api, message, workspacePath, type Detail, type TableSummary } from "../lib/api";
import { ErrorNotice } from "./Shared";
import Select from "./Select";

export default function TableTransfer({ detail, table, onImported, onBusyChange, live = false }: { detail: Detail; table?: TableSummary; onImported?: (table: TableSummary) => void; onBusyChange?: (busy: boolean) => void; live?: boolean }) {
  const [target, setTarget] = useState(table?.id ?? "");
  const [exportTarget, setExportTarget] = useState(table?.id ?? detail.tables?.[0]?.id ?? "");
  const [name, setName] = useState("");
  const [format, setFormat] = useState("csv");
  const [data, setData] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ table: TableSummary; imported: number } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const readable = detail.permissions.includes("tables:read");
  const writable = readable && detail.permissions.includes("tables:write") && !live;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  async function runImport(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const imported = await api<{ table: TableSummary; imported: number }>(`${workspacePath(detail.workspace.id)}/tables${target ? `/${target}` : ""}/import`, "POST", {
        format, data, ...(!target && name.trim() ? { name: name.trim() } : {}),
      });
      setResult(imported); setData("");
      if (file.current) file.current.value = "";
      setExportTarget(imported.table.id);
      onImported?.(imported.table);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function download(exportFormat: "csv" | "json") {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1${workspacePath(detail.workspace.id)}/tables/${exportTarget}/export?format=${exportFormat}`, { credentials: "same-origin" });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || "Export failed"); }
      const blob = await response.blob();
      // Wait for the entire response before offering a download. Truncated JSON
      // and interrupted streams must not appear as a successful saved export.
      if (exportFormat === "json") JSON.parse(await blob.text());
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = `table-${exportTarget}.${exportFormat}`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <div className="table-transfer stack">
    <ErrorNotice error={error} />
    {result && <p role="status">Imported {result.imported} records. <a href={`/app?workspace=${detail.workspace.id}&node=${result.table.id}`}>Open {result.table.name}</a></p>}
    {writable && <form className="stack" onSubmit={runImport}>
      <h3>Import records</h3>
      <p className="muted">Append CSV or JSON to a local Table, or create a new Table. Imports are atomic: up to 500 records and 1 MB per file. CSV headers match column names; new CSV columns start as text. Hopya JSON retains column types, empty values, and select options.</p>
      {!table && <label>Destination Table<Select value={target} onChange={event => setTarget(event.target.value)} disabled={busy}>
        <option value="">Create a new Table</option>{detail.tables?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </Select></label>}
      {!target && <label>New Table name<input value={name} maxLength={120} placeholder="Use the name from JSON, or Imported table" onChange={event => setName(event.target.value)} disabled={busy} /></label>}
      <label>Table file<input ref={file} type="file" accept=".csv,.json,text/csv,application/json" disabled={busy} onChange={async event => {
        const selected = event.target.files?.[0]; if (!selected) return;
        setData(""); setError(""); setResult(null);
        if (selected.size > 1_000_000) { setError("Table imports are limited to 1 MB."); event.target.value = ""; return; }
        try { setData(await selected.text()); setFormat(selected.name.toLowerCase().endsWith(".json") ? "json" : "csv"); }
        catch (cause) { setError(message(cause)); }
      }} /></label>
      <label>Format<Select value={format} onChange={event => setFormat(event.target.value)} disabled={busy}><option value="csv">CSV</option><option value="json">JSON</option></Select></label>
      <label>File contents<textarea rows={5} maxLength={1_000_000} value={data} onChange={event => setData(event.target.value)} disabled={busy} placeholder={'Name,Quantity\nKeyboard,12'} /></label>
      <div className="button-group"><button className="primary" disabled={busy || !data.trim()}>{busy ? "Working..." : target ? "Append records" : "Import new Table"}</button></div>
    </form>}
    {readable && <div className="stack">
      <h3>Export records</h3><p className="muted">Downloads every record from a consistent snapshot, including records not loaded in the grid. CSV is for spreadsheets; JSON preserves types and exact empty values. Live Tables export their source data.</p>
      {!table && <label>Source Table<Select value={exportTarget} onChange={event => setExportTarget(event.target.value)} disabled={busy}>
        <option value="">Choose a Table</option>{detail.tables?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </Select></label>}
      <div className="button-group"><button type="button" disabled={busy || !exportTarget} onClick={() => download("csv")}>Export CSV</button><button type="button" disabled={busy || !exportTarget} onClick={() => download("json")}>Export JSON</button></div>
    </div>}
    {!readable && <p className="notice">Table read access is required for import and export.</p>}
  </div>;
}
