import { useEffect, useState } from "react";
import { ErrorNotice, Loading, Shell, useSession } from "./Shared";

type JsonObject = Record<string, unknown>;
type Parameter = { name?: string; in?: string; required?: boolean; description?: string; schema?: unknown; example?: unknown; examples?: unknown };
type Media = { schema?: unknown; example?: unknown; examples?: unknown };
type Operation = {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: { required?: boolean; description?: string; content?: Record<string, Media> };
  responses?: Record<string, { description?: string; content?: Record<string, Media> }>;
};
type Spec = {
  info: { title: string; version: string; description?: string };
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};

const methodOrder = ["get", "post", "patch", "put", "delete"] as const;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_ENTRIES = 80;
const MAX_SCHEMA_NODES = 500;
const MAX_EXAMPLE_DEPTH = 7;
const MAX_EXAMPLE_ENTRIES = 80;
const MAX_EXAMPLE_CHARS = 20_000;
const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const operationId = (method: string, path: string) => `endpoint-${method}-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;

function resolveRef(spec: Spec, value: unknown): { schema: unknown; ref?: string } {
  if (!isObject(value) || typeof value.$ref !== "string" || !value.$ref.startsWith("#/")) return { schema: value };
  const parts = value.$ref.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let resolved: unknown = spec;
  for (const part of parts) {
    if (!isObject(resolved) || !Object.hasOwn(resolved, part)) return { schema: value, ref: value.$ref };
    resolved = resolved[part];
  }
  return { schema: resolved, ref: value.$ref };
}

function schemaLabel(value: unknown, spec: Spec): string {
  const { schema, ref: localRef } = resolveRef(spec, value);
  if (localRef) return localRef.split("/").at(-1) ?? localRef;
  if (!isObject(schema)) return "unspecified";
  if (typeof schema.title === "string") return schema.title;
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (typeof schema.type === "string") return schema.type === "array" ? `array of ${schemaLabel(schema.items, spec)}` : schema.type;
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) if (Array.isArray(schema[keyword])) return `${keyword} (${schema[keyword].length})`;
  return "schema";
}

function Constraints({ schema }: { schema: JsonObject }) {
  const values: string[] = [];
  for (const key of ["format", "pattern", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "minProperties", "maxProperties"] as const) {
    if (schema[key] !== undefined) values.push(`${key}: ${String(schema[key])}`);
  }
  if (schema.uniqueItems === true) values.push("unique items");
  if (schema.readOnly === true) values.push("read only");
  if (schema.writeOnly === true) values.push("write only");
  if (!values.length) return null;
  return <small className="muted">{values.join("; ")}</small>;
}

function Example({ value, label = "Example" }: { value: unknown; label?: string }) {
  const seen = new WeakSet<object>();
  let entries = 0;
  const bounded = (input: unknown, depth: number): unknown => {
    if (++entries > MAX_EXAMPLE_ENTRIES) return "[entry limit]";
    if (depth > MAX_EXAMPLE_DEPTH) return "[depth limit]";
    if (input === null || typeof input !== "object") return typeof input === "string" && input.length > 2000 ? `${input.slice(0, 2000)}...` : input;
    if (seen.has(input)) return "[cycle]";
    seen.add(input);
    if (Array.isArray(input)) return input.slice(0, MAX_EXAMPLE_ENTRIES).map((entry) => bounded(entry, depth + 1));
    const output: JsonObject = {};
    for (const [key, entry] of Object.entries(input).slice(0, MAX_EXAMPLE_ENTRIES)) {
      if (entries >= MAX_EXAMPLE_ENTRIES) { output["..."] = "[entry limit]"; break; }
      output[key] = bounded(entry, depth + 1);
    }
    return output;
  };
  let text: string;
  try { text = JSON.stringify(bounded(value, 0), null, 2) ?? String(value); }
  catch { text = "[unrenderable example]"; }
  if (text.length > MAX_EXAMPLE_CHARS) text = `${text.slice(0, MAX_EXAMPLE_CHARS)}\n... [truncated]`;
  return <figure className="docs-example"><figcaption>{label}</figcaption><pre><code>{text}</code></pre></figure>;
}

function Examples({ media }: { media: Media }) {
  if (media.example !== undefined) return <Example value={media.example} />;
  if (isObject(media.examples)) return <>{Object.entries(media.examples).slice(0, 20).map(([name, value]) => {
    const example = isObject(value) && "value" in value ? value.value : value;
    return <Example key={name} value={example} label={`Example: ${name}`} />;
  })}</>;
  const resolvedExample = isObject(media.schema) ? media.schema.example ?? media.schema.examples : undefined;
  return resolvedExample === undefined ? null : <Example value={resolvedExample} />;
}

function SchemaView({ value, spec, depth = 0, refs = new Set<string>(), budget = { count: 0 }, name }: { value: unknown; spec: Spec; depth?: number; refs?: Set<string>; budget?: { count: number }; name?: string }) {
  if (++budget.count > MAX_SCHEMA_NODES) return <p className="muted">Schema node limit reached.</p>;
  if (depth > MAX_SCHEMA_DEPTH) return <p className="muted">Schema depth limit reached.</p>;
  const { schema: resolved, ref: localRef } = resolveRef(spec, value);
  if (localRef && refs.has(localRef)) return <p className="muted"><code>{localRef}</code> (recursive reference)</p>;
  if (!isObject(resolved)) return <code>{String(resolved ?? "unspecified")}</code>;
  const nextRefs = new Set(refs);
  if (localRef) nextRefs.add(localRef);
  const properties = isObject(resolved.properties) ? Object.entries(resolved.properties).slice(0, MAX_SCHEMA_ENTRIES) : [];
  const required = new Set(Array.isArray(resolved.required) ? resolved.required.filter((entry): entry is string => typeof entry === "string") : []);
  const variants = (["oneOf", "anyOf", "allOf"] as const).flatMap((keyword) => Array.isArray(resolved[keyword]) ? [{ keyword, schemas: resolved[keyword] as unknown[] }] : []);
  const title = `${name ? `${name}: ` : ""}${schemaLabel(value, spec)}${localRef ? ` (${localRef})` : ""}`;
  return (
    <div className={`docs-schema${depth === 0 ? " docs-schema-root" : ""}`}>
      <div className="docs-schema-title"><code>{title}</code></div>
      {typeof resolved.description === "string" && <p>{resolved.description}</p>}
      <Constraints schema={resolved} />
      {Array.isArray(resolved.enum) && <p><small>Allowed: <code>{resolved.enum.map(String).join(" | ")}</code></small></p>}
      {resolved.const !== undefined && <p><small>Constant: <code>{String(resolved.const)}</code></small></p>}
      {resolved.default !== undefined && <Example value={resolved.default} label="Default" />}
      {(resolved.example !== undefined || resolved.examples !== undefined) && <Examples media={{ schema: resolved }} />}
      {variants.map(({ keyword, schemas: choices }) => (
        <div key={keyword}>
          <strong>{keyword}</strong>
          {choices.slice(0, MAX_SCHEMA_ENTRIES).map((choice, index) => <SchemaView key={`${keyword}-${index}`} value={choice} spec={spec} depth={depth + 1} refs={nextRefs} budget={budget} name={`Option ${index + 1}`} />)}
        </div>
      ))}
      {resolved.type === "array" && <SchemaView value={resolved.items} spec={spec} depth={depth + 1} refs={nextRefs} budget={budget} name="Items" />}
      {properties.map(([property, propertySchema]) => <SchemaView key={property} value={propertySchema} spec={spec} depth={depth + 1} refs={nextRefs} budget={budget} name={`${property}${required.has(property) ? " (required)" : ""}`} />)}
      {isObject(resolved.additionalProperties) && <SchemaView value={resolved.additionalProperties} spec={spec} depth={depth + 1} refs={nextRefs} budget={budget} name="Additional properties" />}
      {resolved.additionalProperties === true && <p className="muted">Additional properties are allowed.</p>}
      {isObject(resolved.not) && <SchemaView value={resolved.not} spec={spec} depth={depth + 1} refs={nextRefs} budget={budget} name="Must not match" />}
      {isObject(resolved.if) && <SchemaView value={resolved.if} spec={spec} depth={depth + 1} refs={nextRefs} budget={budget} name="If" />}
      {isObject(resolved.then) && <SchemaView value={resolved.then} spec={spec} depth={depth + 1} refs={nextRefs} budget={budget} name="Then" />}
    </div>
  );
}

function MediaView({ content, spec }: { content?: Record<string, Media>; spec: Spec }) {
  if (!content) return <p className="muted">No response body.</p>;
  return <>{Object.entries(content).slice(0, 20).map(([type, media]) => (
    <div key={type}>
      <p><code>{type}</code></p>
      {media.schema !== undefined && <SchemaView value={media.schema} spec={spec} />}
      <Examples media={media} />
    </div>
  ))}</>;
}

function OperationDetails({ method, path, operation, pathParameters, spec }: { method: string; path: string; operation: Operation; pathParameters: Parameter[]; spec: Spec }) {
  const parameters = [...pathParameters, ...(operation.parameters ?? [])];
  return (
    <article className="docs-operation" id={operationId(method, path)}>
      <header className="docs-operation-heading">
        <code className={`method method-${method}`}>{method.toUpperCase()}</code>{" "}
        <code className="docs-path">{path}</code>{" "}
        <h3>{operation.summary || "Endpoint"}</h3>
      </header>
      {operation.description && <p>{operation.description}</p>}
      {parameters.length > 0 && <section className="docs-operation-section"><h4>Parameters <span>{parameters.length}</span></h4>
        <ul className="docs-parameters">
          {parameters.slice(0, MAX_SCHEMA_ENTRIES).map((parameter, index) => <li key={`${parameter.in}:${parameter.name}:${index}`}>
            <p><code>{parameter.name ?? "unnamed"}</code> <span>{parameter.in ?? "unknown"}</span>{parameter.required && <strong>Required</strong>}</p>
            {parameter.description && <p>{parameter.description}</p>}
            {parameter.schema !== undefined && <SchemaView value={parameter.schema} spec={spec} />}
            {parameter.example !== undefined && <Example value={parameter.example} />}
          </li>)}
        </ul>
      </section>}
      {operation.requestBody && <section className="docs-operation-section"><h4>Request body {operation.requestBody.required && <strong>Required</strong>}</h4>
        {operation.requestBody.description && <p>{operation.requestBody.description}</p>}
        <MediaView content={operation.requestBody.content} spec={spec} />
      </section>}
      {operation.responses && <section className="docs-operation-section"><h4>Responses</h4>
        <div className="docs-responses">{Object.entries(operation.responses).slice(0, MAX_SCHEMA_ENTRIES).map(([status, result]) => <article key={status}>
          <h5><code>{status}</code> {result.description ?? "Response"}</h5>
          <MediaView content={result.content} spec={spec} />
        </article>)}</div>
      </section>}
    </article>
  );
}

function Docs() {
  const { user, error: authError } = useSession();
  const [spec, setSpec] = useState<Spec | null>(null);
  const [error, setError] = useState("");
  const [queryText, setQueryText] = useState("");
  const [methodFilter, setMethodFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/openapi.json", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Docs unavailable (${response.status})`);
        return response.json() as Promise<Spec>;
      })
      .then(setSpec)
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Docs unavailable"); });
    return () => controller.abort();
  }, []);
  const lower = queryText.toLowerCase();
  const operations = spec ? Object.entries(spec.paths).flatMap(([path, pathItem]) => {
    const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters.filter(isObject) as Parameter[] : [];
    return methodOrder.flatMap(method => isObject(pathItem[method])
      ? [{ path, method, operation: pathItem[method] as Operation, pathParameters }]
      : []);
  }) : [];
  const entries = operations.filter(({ path, method, operation }) =>
    (!methodFilter || method === methodFilter) &&
    (!tagFilter || (operation.tags?.[0] ?? "Other") === tagFilter) &&
    (!lower || `${path} ${method} ${operation.summary ?? ""} ${operation.description ?? ""} ${(operation.tags ?? []).join(" ")}`.toLowerCase().includes(lower)));
  const grouped = new Map<string, typeof entries>();
  for (const entry of entries) {
    const tag = entry.operation.tags?.[0] ?? "Other";
    if (!grouped.has(tag)) grouped.set(tag, []);
    grouped.get(tag)!.push(entry);
  }
  const tagNames = [...new Set(operations.map(entry => entry.operation.tags?.[0] ?? "Other"))];
  const tags: { name: string; description?: string }[] = [...(spec?.tags ?? []), ...tagNames.filter((name) => !(spec?.tags ?? []).some((tag) => tag.name === name)).map((name) => ({ name }))];
  return (
    <Shell user={user} active="app" currentPage="API docs">
      <div className="settings-body docs-body">
        <h1>API documentation</h1>
        <p className="muted">{spec?.info.description ?? "OpenAPI description of the Hopya REST API."}</p>
        <p className="muted">Raw specification: <a href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer">/api/v1/openapi.json</a> - import it into Swagger UI, Postman or Insomnia.</p>
        <ErrorNotice error={authError || error} />
        {!spec && !error ? <Loading /> : spec ? <>
          <div className="docs-filterbar" role="search">
            <label className="docs-search"><span className="sr-only">Search endpoints</span><input aria-label="Search endpoints" type="search" value={queryText} placeholder="Search endpoints..." maxLength={120} onChange={(event) => setQueryText(event.target.value)} /></label>
            <label><span className="sr-only">Filter by method</span><select aria-label="Filter by method" value={methodFilter} onChange={event => setMethodFilter(event.target.value)}><option value="">All methods</option>{methodOrder.map(method => <option key={method} value={method}>{method.toUpperCase()}</option>)}</select></label>
            <label><span className="sr-only">Filter by category</span><select aria-label="Filter by category" value={tagFilter} onChange={event => setTagFilter(event.target.value)}><option value="">All categories</option>{tagNames.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select></label>
            <span className="docs-result-count" role="status">{entries.length} endpoint{entries.length === 1 ? "" : "s"}</span>
            {(queryText || methodFilter || tagFilter) && <button type="button" onClick={() => { setQueryText(""); setMethodFilter(""); setTagFilter(""); }}>Clear</button>}
          </div>
          <div className="docs-layout">
            {entries.length > 0 && <nav className="docs-index" aria-label="Filtered endpoints">
              {tags.map(tag => {
                const group = grouped.get(tag.name);
                if (!group?.length) return null;
                return <section key={tag.name}>
                  <h2>{tag.name}</h2>
                  <ul>{group.map(({ path, method, operation }) => <li key={`${method}:${path}`}>
                    <a href={`#${operationId(method, path)}`} title={operation.summary}>
                      <code className={`method method-${method}`}>{method.toUpperCase()}</code>
                      <code>{path}</code>
                    </a>
                  </li>)}</ul>
                </section>;
              })}
            </nav>}
            <div className="docs-reference">
              {tags.map((tag, tagIndex) => {
                const group = grouped.get(tag.name);
                if (!group?.length) return null;
                const headingId = `docs-tag-${tagIndex}`;
                return <section key={tag.name} className="settings-section docs-group" aria-labelledby={headingId}>
                  <div className="section-intro"><h2 id={headingId}>{tag.name}</h2>{tag.description && <p>{tag.description}</p>}</div>
                  <ul className="record-list docs-list">
                    {group.map(({ path, method, operation, pathParameters }) => <li key={`${method}:${path}`}><OperationDetails method={method} path={path} operation={operation} pathParameters={pathParameters} spec={spec} /></li>)}
                  </ul>
                </section>;
              })}
              {!entries.length && <p className="muted">No endpoints match your filter.</p>}
            </div>
          </div>
        </> : null}
      </div>
    </Shell>
  );
}

export default Docs;
