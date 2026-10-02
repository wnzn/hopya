import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ApiError, message, nodeIconOptions, type NodeIcon, type TreeNode } from "../lib/api";
import NodeGlyph from "./NodeGlyph";
import SolidIcon from "./SolidIcon";
import "../styles/appearance.css";

export default function NodeIconPicker({ kind, value, color, onChange, compact = false, label = "Choose icon", disabled = false }: {
  kind: TreeNode["kind"];
  value: NodeIcon | null;
  color: string | null;
  onChange: (value: NodeIcon | null) => void | Promise<void>;
  compact?: boolean;
  label?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const selectedLabel = value ? nodeIconOptions.find(option => option.id === value)?.label ?? value : "Default for type";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const showDefault = !normalizedQuery || "default for type".includes(normalizedQuery);
  const options = nodeIconOptions.filter(option => !normalizedQuery || `${option.label} ${option.id} ${option.searchTerms}`.toLocaleLowerCase().includes(normalizedQuery));

  function close(restoreFocus = false) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const bounds = triggerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const panelWidth = Math.min(320, width - 24);
      const anchorTop = Math.max(top + 12, Math.min(bounds.top, top + height - 12));
      const anchorBottom = Math.max(top + 12, Math.min(bounds.bottom, top + height - 12));
      const below = top + height - anchorBottom - 18;
      const above = anchorTop - top - 18;
      const down = below >= 260 || below >= above;
      const maxHeight = Math.max(0, Math.min(380, down ? below : above));
      setPosition({ position: "fixed", width: panelWidth, maxHeight,
        left: Math.max(left + 12, Math.min(bounds.left, left + width - panelWidth - 12)),
        top: down ? anchorBottom + 6 : "auto",
        bottom: down ? "auto" : window.innerHeight - anchorTop + 6,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  async function choose(next: NodeIcon | null) {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      await onChange(next);
      close(true);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409
        ? `${message(cause)}. Reload the resource before choosing an icon again.` : message(cause));
    } finally { setBusy(false); }
  }

  return <div ref={rootRef} className={`node-icon-picker${compact ? " node-icon-picker-compact" : ""}`}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close(); }}
    onKeyDown={event => {
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }}>
    {!compact && <span id={`${id}-label`} className="appearance-control-label">Icon</span>}
    <button ref={triggerRef} type="button" className={compact ? "resource-title-icon" : "node-icon-trigger"}
      aria-label={compact ? `${label}. Current: ${selectedLabel}` : undefined}
      aria-labelledby={compact ? undefined : `${id}-label ${id}-value`}
      title={compact ? label : undefined} disabled={disabled || busy}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-picker` : undefined}
      onClick={() => { if (open) close(); else { setError(""); setOpen(true); } }}>
      <NodeGlyph node={{ kind, icon: value, color }} />
      {!compact && <><span id={`${id}-value`}>{selectedLabel}</span><SolidIcon name="chevronDown" /></>}
    </button>
    {open && <div id={`${id}-picker`} className="node-icon-panel resource-icon-panel" style={position} role="dialog" aria-label={label} aria-busy={busy}>
      <div className="resource-icon-search">
        <label className="sr-only" htmlFor={`${id}-search`}>Search icons</label>
        <input ref={searchRef} id={`${id}-search`} type="search" value={query} autoComplete="off" placeholder="Search icons"
          onChange={event => setQuery(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter") event.preventDefault();
            if (event.key === "ArrowDown") { event.preventDefault(); gridRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
          }} />
        <button type="button" className="icon-button" aria-label="Close icon picker" onClick={() => close(true)}><SolidIcon name="x" /></button>
      </div>
      <div ref={gridRef} className="node-icon-grid" role="group" aria-label="Node icons" onKeyDown={event => {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1
          : event.key === "ArrowDown" ? index + 5 : event.key === "ArrowUp" ? index - 5
          : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : undefined;
        if (next === undefined) return;
        event.preventDefault();
        buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
      }}>
        {showDefault && <button type="button" aria-pressed={!value} aria-disabled={busy} className={!value ? "selected" : ""}
          title="Default for type" aria-label="Default for type" onClick={() => void choose(null)}>
          <NodeGlyph node={{ kind, icon: null, color: null }} /><span>Default</span>
        </button>}
        {options.map(option => <button key={option.id} type="button" aria-pressed={value === option.id} aria-disabled={busy}
          className={value === option.id ? "selected" : ""} title={option.label} aria-label={option.label} onClick={() => void choose(option.id)}>
          <NodeGlyph node={{ kind, icon: option.id, color: null }} /><span>{option.label}</span>
        </button>)}
      </div>
      {normalizedQuery && !showDefault && options.length === 0 && <p className="node-icon-empty" role="status">No matching icons.</p>}
      {busy && <p className="node-icon-empty" role="status">Saving icon…</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
    </div>}
  </div>;
}
