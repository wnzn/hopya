import { useEffect, useRef, useState } from "react";
import type { Field, Item } from "../lib/api";

// Multi-select checklist as a compact dropdown with option search, used where
// long single-column checkbox lists get awkward (task editor, table cells).
// Value semantics match the checkbox list: toggle appends/removes, clear unsets.
export default function ChecklistDropdown({ field, value, disabled, onChange, compact = false }: {
  field: Field; value: Item["customFields"][string]; disabled?: boolean;
  onChange: (value: Item["customFields"][string]) => void;
  compact?: boolean;
}) {
  const selected = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState(compact);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) search.current?.focus();
  }, [open ]);
  // No outside-click dismissal: collapsing the in-flow panel would shift
  // neighboring controls (e.g. Save) out from under the pointer mid-click.
  // The toggle button and Escape close the panel instead.
  const options = [...new Set([...(field.options ?? []), ...selected])];
  const visible = options.filter((option) =>
    option.toLowerCase().includes(query.trim().toLowerCase()));
  const summary = selected.length ? selected.join(", ") : `Select ${field.name}`;
  function toggle(option: string, checked: boolean) {
    onChange(checked ? [...selected, option] : selected.filter((entry) => entry !== option));
  }
  return (
    <fieldset disabled={disabled} className="stack bare-fieldset">
      <legend className={compact ? "sr-only" : undefined}>{field.name}</legend>
      <div className="checklist-dropdown">
        <button
          type="button"
          className="checklist-toggle"
          aria-expanded={open}
          aria-label={`${field.name}: ${summary}`}
          onClick={() => setOpen(!open)}
        >
          <span>{summary}</span>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div
            className="checklist-panel"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
            }}
          >
            <input
              ref={search}
              type="search"
              aria-label={`Search ${field.name} options`}
              placeholder="Search options..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
            {visible.length ? (
              <ul>
                {visible.map((option) => (
                  <li key={option}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.includes(option)}
                        onChange={(event) => toggle(option, event.target.checked)}
                      />
                      <span>
                        {option}
                        {!field.options?.includes(option) ? " (removed option)" : ""}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No options match.</p>
            )}
            <button type="button" className="checklist-clear" onClick={() => onChange(null)}>
              Clear {field.name}
            </button>
          </div>
        )}
      </div>
    </fieldset>
  );
}
