import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type SubmitEvent,
} from "react";
import {
  api,
  label,
  message,
  statuses,
  workspacePath,
  type Detail,
  type Field,
  type ImportFormat,
  type ImportResult,
  type TreeNode,
} from "../lib/api";
import { parseCsv, toCsv } from "../lib/csv";
import { ErrorNotice, Loading, Shell, useSession } from "./Shared";
import Select from "./Select";

function listOptions(nodes: TreeNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes
    .filter((node) => node.kind === "list")
    .map((list) => {
      const parts = [list.name];
      const seen = new Set([list.id]);
      let parent = list.parentId ? byId.get(list.parentId) : undefined;
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        parts.unshift(parent.name);
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      }
      return { id: list.id, label: parts.join(" / ") };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function formatForFile(name: string): ImportFormat {
  return name.toLowerCase().endsWith(".json") ? "json" : "csv";
}

type TargetOption = { value: string; label: string };

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[\s_]+/g, "");
}

const CANONICAL_TARGETS: Record<string, string> = {
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  startdate: "startDate",
  duedate: "dueDate",
  tags: "tags",
  assignee: "assignee",
};

function suggestTarget(source: string, customNames: string[]): string {
  if (source.startsWith("custom:")) {
    const name = source.slice("custom:".length);
    return customNames.includes(name) ? `custom:${name}` : "keep";
  }
  const normalized = normalizeName(source);
  for (const [key, target] of Object.entries(CANONICAL_TARGETS)) {
    if (normalized === key) return target;
  }
  const custom = customNames.find(
    (name) => normalizeName(name) === normalized,
  );
  return custom ? `custom:${custom}` : "keep";
}

type SourceColumn = { name: string; samples: string[] };

function sampleText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

export default function ImportExport() {
  const { user, error: authError } = useSession();
  const [workspaces, setWorkspaces] = useState<
    { id: string; name: string }[]
  >([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [wid, setWid] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);

  const [nodeId, setNodeId] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileText, setFileText] = useState("");
  const [pasted, setPasted] = useState("");
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState("");
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [customFields, setCustomFields] = useState<Field[]>([]);
  const [mapping, setMapping] = useState<Record<number, string>>({});

  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [exportFormat, setExportFormat] = useState<ImportFormat>("csv");

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setLoadError("");
    api<{ id: string; name: string }[]>(
      "/workspaces",
      "GET",
      undefined,
      controller.signal,
    )
      .then((rows) => {
        if (controller.signal.aborted) return;
        setWorkspaces(rows);
        setWorkspacesLoaded(true);
        const stored = localStorage.getItem("hopya.workspace");
        setWid(
          (current) =>
            current ||
            rows.find((workspace) => workspace.id === stored)?.id ||
            rows[0]?.id ||
            "",
        );
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setWorkspacesLoaded(true);
        setLoadError(message(e));
      });
    return () => controller.abort();
  }, [user, revision]);

  useEffect(() => {
    if (!wid) return;
    const controller = new AbortController();
    setDetail(null);
    api<Detail>(workspacePath(wid), "GET", undefined, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setDetail(loaded);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setLoadError(message(e));
      });
    return () => controller.abort();
  }, [wid]);

  useEffect(() => {
    if (!wid) {
      setCustomFields([]);
      return;
    }
    const controller = new AbortController();
    api<Field[]>(`${workspacePath(wid)}/fields`, "GET", undefined, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setCustomFields(loaded);
      })
      .catch(() => {
        // Custom options are best-effort: a denied fetch (e.g. 403)
        // simply omits them; "Keep column name" still sends custom:X.
        if (!controller.signal.aborted) setCustomFields([]);
      });
    return () => controller.abort();
  }, [wid]);

  const lists = detail ? listOptions(detail.nodes) : [];
  const resolvedNode = lists.some((list) => list.id === nodeId)
    ? nodeId
    : (lists[0]?.id ?? "");
  const resolvedScope = lists.some((list) => list.id === scope)
    ? scope
    : "all";

  function chooseWorkspace(next: string) {
    setWid(next);
    setNodeId("");
    setScope("all");
    try {
      localStorage.setItem("hopya.workspace", next);
    } catch {
      // Storage is a convenience only; the page works without it.
    }
  }

  const sourceData = pasted.trim() ? pasted : fileText;
  // Pasted contents have no filename to sniff the format from: JSON
  // payloads would otherwise parse as a single garbage CSV column.
  const detectedFormat = fileName
    ? formatForFile(fileName)
    : /^[\s]*[{\[]/.test(sourceData)
      ? "json"
      : "csv";
  const customNames = useMemo(
    () =>
      customFields
        .filter(
          (field): field is Field & { name: string } =>
            typeof field?.name === "string" && field.name.length > 0,
        )
        .map((field) => field.name),
    [customFields],
  );
  const columns = useMemo<SourceColumn[]>(() => {
    if (!sourceData.trim()) return [];
    try {
      if (detectedFormat === "csv") {
        const rows = parseCsv(sourceData);
        if (!rows.length) return [];
        const header = rows[0];
        return header.map((name, index) => ({
          name,
          samples: rows
            .slice(1, 4)
            .map((row) => row[index] ?? "")
            .filter((value) => value !== ""),
        }));
      }
      const parsed: unknown = JSON.parse(sourceData);
      const objects = (
        Array.isArray(parsed) ? parsed.slice(0, 50) : [parsed]
      ).filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      );
      const keys: string[] = [];
      for (const entry of objects) {
        for (const key of Object.keys(entry)) {
          if (!keys.includes(key)) keys.push(key);
          if (keys.length >= 100) break;
        }
        if (keys.length >= 100) break;
      }
      return keys.map((name) => {
        const samples: string[] = [];
        for (const entry of objects) {
          const text = sampleText(entry[name]);
          if (text !== null && text !== "" && !samples.includes(text)) {
            samples.push(text);
          }
          if (samples.length >= 3) break;
        }
        return { name, samples };
      });
    } catch {
      return [];
    }
  }, [sourceData, detectedFormat]);

  const targetOptions = useMemo<TargetOption[]>(
    () => [
      { value: "ignore", label: "Ignore" },
      { value: "title", label: "Title" },
      { value: "description", label: "Description" },
      { value: "status", label: "Status" },
      { value: "priority", label: "Priority" },
      { value: "startDate", label: "Start date" },
      { value: "dueDate", label: "Due date" },
      { value: "tags", label: "Tags" },
      { value: "assignee", label: "Assignee" },
      { value: "keep", label: "Keep column name" },
      ...customNames.map((name) => ({
        value: `custom:${name}`,
        label: `Custom: ${name}`,
      })),
    ],
    [customNames],
  );

  function effectiveTarget(index: number): string {
    const source = columns[index]?.name ?? "";
    return mapping[index] ?? suggestTarget(source, customNames);
  }

  function resolvedTarget(index: number): string {
    const selected = effectiveTarget(index);
    if (selected === "keep") return `keep:${columns[index]?.name ?? ""}`;
    return selected;
  }

  function mappingProblem(): string {
    if (!columns.length) return "";
    const resolved = columns.map((_, index) => resolvedTarget(index));
    const titles = resolved.filter((target) => target === "title");
    if (titles.length !== 1) {
      return "Map exactly one column to Title before importing.";
    }
    const seen = new Set<string>();
    for (const target of resolved) {
      if (target === "ignore" || target.startsWith("custom:")) continue;
      if (seen.has(target)) {
        return "Each target may only be used once (except Ignore).";
      }
      seen.add(target);
    }
    return "";
  }

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setImportError("");
    setImportResult("");
    setMapping({});
    try {
      setFileText(await file.text());
    } catch (e) {
      setFileText("");
      setImportError(message(e));
    }
  }

  function transformImport(data: string, format: ImportFormat): string {
    if (!columns.length) return data;
    if (format === "csv") {
      const rows = parseCsv(data);
      if (!rows.length) return data;
      const kept: number[] = [];
      const header: string[] = [];
      rows[0].forEach((name, index) => {
        const selected = effectiveTarget(index);
        if (selected === "ignore") return;
        kept.push(index);
        header.push(selected === "keep" ? name : selected);
      });
      return toCsv([
        header,
        ...rows.slice(1).map((row) => kept.map((index) => row[index] ?? "")),
      ]);
    }
    const parsed: unknown = JSON.parse(data);
    const rename = (entry: unknown) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return entry;
      }
      const record = entry as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        if (!(column.name in record)) return;
        const selected = effectiveTarget(index);
        if (selected === "ignore") return;
        out[selected === "keep" ? column.name : selected] = record[column.name];
      });
      return out;
    };
    return JSON.stringify(
      Array.isArray(parsed) ? parsed.map(rename) : rename(parsed),
    );
  }

  async function runImport(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setImporting(true);
    setImportError("");
    setImportResult("");
    try {
      const data = pasted.trim() ? pasted : fileText;
      if (!resolvedNode)
        throw new Error("Choose a destination list for the import.");
      if (!data.trim())
        throw new Error(
          "Choose a file or paste CSV or JSON contents to import.",
        );
      const format = detectedFormat;
      const problem = mappingProblem();
      if (problem) throw new Error(problem);
      const transformed = transformImport(data, format);
      const result = await api<ImportResult>(
        `${workspacePath(wid)}/items/import`,
        "POST",
        { nodeId: resolvedNode, format, data: transformed },
      );
      const count =
        typeof result?.imported === "number"
          ? result.imported
          : typeof result?.count === "number"
            ? result.count
            : 0;
      setImportResult(`Imported ${count} task${count === 1 ? "" : "s"}`);
      setFileName("");
      setFileText("");
      setPasted("");
      setMapping({});
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setImportError(message(e));
    } finally {
      setImporting(false);
    }
  }

  function downloadExport() {
    const params = new URLSearchParams({ format: exportFormat });
    if (resolvedScope !== "all") params.set("nodeId", resolvedScope);
    if (status) params.set("status", status);
    if (search.trim()) params.set("search", search.trim());
    window.location.href = `/api/v1${workspacePath(wid)}/items/export?${params.toString()}`;
  }

  const pageError = authError || loadError;
  const loading =
    !user || !workspacesLoaded || (!!wid && !detail && !pageError);
  return (
    <Shell user={user} active="app" currentPage="Import & export" navigation={{
      workspaces,
      workspaceId: wid,
      detail,
      onWorkspaceChange: chooseWorkspace,
    }}>
      <div className="settings-body">
        <h1>Import &amp; export</h1>
        <p className="muted">
          Move tasks in and out of {detail?.workspace.name || "your workspace"}{" "}
          with CSV or JSON files.
        </p>
        <ErrorNotice error={pageError} />
        {pageError && (
          <button onClick={() => setRevision((value) => value + 1)}>
            Retry loading
          </button>
        )}
        {loading ? (
          <Loading />
        ) : !detail ? (
          <section className="notice">
            <h2>No workspace available</h2>
            <p>Create or join a workspace before importing or exporting.</p>
          </section>
        ) : (
          <>
            <section
              className="settings-section"
              aria-labelledby="templates-heading"
            >
              <div className="section-intro">
                <h2 id="templates-heading">Templates</h2>
                <p>
                  Start from a template with two sample rows. Both files use
                  the same columns.
                </p>
              </div>
              <div className="stack">
                <p>
                  <a href="/templates/tasks.csv" download>
                    tasks.csv
                  </a>{" "}
                  ·{" "}
                  <a href="/templates/tasks.json" download>
                    tasks.json
                  </a>
                </p>
                <ul>
                  <li>
                    <code>title*</code> — required task title.
                  </li>
                  <li>
                    <code>description</code> — longer details.
                  </li>
                  <li>
                    <code>status</code> — status id or name.
                  </li>
                  <li>
                    <code>priority</code> — none, low, medium, high or urgent.
                  </li>
                  <li>
                    <code>startDate</code> / <code>dueDate</code> — YYYY-MM-DD.
                  </li>
                  <li>
                    <code>tags</code> — semicolon-separated.
                  </li>
                  <li>
                    <code>assignee</code> — member email.
                  </li>
                  <li>
                    <code>custom:&lt;FieldName&gt;</code> — value for a custom
                    field, for example <code>custom:Effort</code>.
                  </li>
                </ul>
              </div>
            </section>
            <section
              className="settings-section"
              aria-labelledby="import-heading"
            >
              <div className="section-intro">
                <h2 id="import-heading">Import</h2>
                <p>
                  Bring tasks from a CSV or JSON file into one list. The server
                  checks task creation permission and reports denied requests.
                </p>
              </div>
              <form
                className="stack"
                onSubmit={(event) => void runImport(event)}
              >
                <ErrorNotice error={importError} />
                {importResult ? (
                  <p className="muted" role="status">
                    {importResult}
                  </p>
                ) : null}
                <label>
                  Destination list
                  <Select
                    value={resolvedNode}
                    disabled={!lists.length}
                    onChange={(event) => setNodeId(event.target.value)}
                  >
                    {lists.length ? (
                      lists.map((list) => (
                        <option key={list.id} value={list.id}>
                          {list.label}
                        </option>
                      ))
                    ) : (
                      <option value="">No lists yet</option>
                    )}
                  </Select>
                </label>
                <label>
                  Import file
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,.json,text/csv,application/json"
                    onChange={(event) => void onFileChange(event)}
                  />
                </label>
                {fileName ? (
                  <p className="muted">
                    Selected {fileName} — detected format:{" "}
                    {formatForFile(fileName).toUpperCase()}.
                  </p>
                ) : null}
                <label>
                  Or paste file contents
                  <textarea
                    rows={6}
                    maxLength={2000000}
                    placeholder="title,description,status,..."
                    value={pasted}
                    onChange={(event) => setPasted(event.target.value)}
                  />
                </label>
                {columns.length ? (
                  <fieldset className="bare-fieldset">
                    <legend>Column mapping</legend>
                    <p className="muted">
                      Match each source column to a task field. Exactly one
                      column must map to Title.
                    </p>
                    <div className="stack">
                      {columns.map((column, index) => (
                        <label key={`${index}:${column.name}`}>
                          <span>
                            {column.name || `Column ${index + 1}`}
                            {column.samples.length ? (
                              <span className="muted">
                                {" "}
                                — e.g. {column.samples.join(", ")}
                              </span>
                            ) : null}
                          </span>
                          <Select
                            aria-label={`Map ${column.name || `column ${index + 1}`} to`}
                            value={effectiveTarget(index)}
                            onChange={(event) =>
                              setMapping((current) => ({
                                ...current,
                                [index]: event.target.value,
                              }))
                            }
                          >
                            {targetOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </label>
                      ))}
                    </div>
                    {mappingProblem() ? (
                      <p className="muted" role="note">
                        {mappingProblem()}
                      </p>
                    ) : null}
                  </fieldset>
                ) : null}
                <div className="button-group">
                  <button
                    className="primary"
                    disabled={importing || !resolvedNode}
                  >
                    {importing ? "Importing..." : "Import"}
                  </button>
                </div>
              </form>
            </section>
            <section
              className="settings-section"
              aria-labelledby="export-heading"
            >
              <div className="section-intro">
                <h2 id="export-heading">Export</h2>
                <p>
                  Download tasks as CSV or JSON. The server checks task viewing
                  permission and reports denied requests.
                </p>
              </div>
              <div className="stack">
                <label>
                  Scope
                  <Select
                    value={resolvedScope}
                    onChange={(event) => setScope(event.target.value)}
                  >
                    <option value="all">All tasks</option>
                    {lists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  Status
                  <Select
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                  >
                    <option value="">All statuses</option>
                    {statuses.map((value) => (
                      <option key={value} value={value}>
                        {label(value)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  Search
                  <input
                    type="search"
                    maxLength={300}
                    placeholder="Filter by title or description"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <fieldset className="bare-fieldset">
                  <legend>Format</legend>
                  <label className="inline-check">
                    <input
                      type="radio"
                      name="export-format"
                      value="csv"
                      checked={exportFormat === "csv"}
                      onChange={() => setExportFormat("csv")}
                    />
                    <span>CSV</span>
                  </label>
                  <label className="inline-check">
                    <input
                      type="radio"
                      name="export-format"
                      value="json"
                      checked={exportFormat === "json"}
                      onChange={() => setExportFormat("json")}
                    />
                    <span>JSON</span>
                  </label>
                </fieldset>
                <div className="button-group">
                  <button type="button" onClick={downloadExport}>
                    Download
                  </button>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </Shell>
  );
}
