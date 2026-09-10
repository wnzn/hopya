import {
  Children,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

type Choice = { value: string; label: ReactNode; text: string; disabled: boolean; group?: string };
type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  openOnMount?: boolean;
  onDismiss?: () => void;
  pinnedValue?: string;
};

function choicesFrom(children: ReactNode, group?: string): Choice[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement(child)) return [];
    const props = child.props as { children?: ReactNode; value?: string | number; disabled?: boolean; label?: string };
    if (child.type === "optgroup") return choicesFrom(props.children, props.label);
    if (child.type !== "option") return [];
    const text = Children.toArray(props.children).join("");
    return [{ value: String(props.value ?? text), label: props.children, text, disabled: Boolean(props.disabled), group }];
  });
}

const Select = forwardRef<HTMLSelectElement, Props>(function Select({
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  autoFocus,
  className,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  required,
  openOnMount,
  onDismiss,
  pinnedValue,
  style,
  ...nativeProps
}, forwardedRef) {
  const generatedId = useId();
  const triggerId = id ?? `select-${generatedId}`;
  const listboxId = `${triggerId}-options`;
  const nativeRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef("");
  const searchTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [uncontrolled, setUncontrolled] = useState(String(defaultValue ?? ""));
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<React.CSSProperties>();
  const choices = choicesFrom(children);
  const selectedValue = String(value ?? uncontrolled);
  const selected = choices.find(choice => choice.value === selectedValue) ?? choices[0];
  const pinnedIndex = pinnedValue === undefined ? -1 : choices.findIndex(choice => choice.value === pinnedValue);
  useImperativeHandle(forwardedRef, () => nativeRef.current!, []);

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    const maxHeight = Math.min(280, Math.max(120, below >= 160 ? below - 8 : rect.top - 8));
    setPosition({
      position: "fixed",
      left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 180) - 8)),
      top: below >= 160 ? rect.bottom + 3 : undefined,
      bottom: below < 160 ? window.innerHeight - rect.top + 3 : undefined,
      width: Math.max(rect.width, 180),
      maxHeight,
    });
  };
  useEffect(() => {
    if (!open) return;
    place();
    const close = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if ((event.target as Element).closest?.(`#${CSS.escape(listboxId)}`)) return;
      setOpen(false);
      onDismiss?.();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", close);
    };
  }, [open, listboxId, onDismiss]);
  useEffect(() => {
    if (!autoFocus) return;
    triggerRef.current?.focus();
    if (openOnMount) requestAnimationFrame(openMenu);
  }, [autoFocus, openOnMount]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listboxId}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listboxId, open]);

  function choose(next: Choice) {
    if (next.disabled) return;
    if (value === undefined) setUncontrolled(next.value);
    const target = nativeRef.current!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(target, next.value);
    onChange?.({ target, currentTarget: target } as ChangeEvent<HTMLSelectElement>);
    setOpen(false);
  }
  function move(direction: 1 | -1) {
    if (!choices.length) return;
    let next = active;
    do next = (next + direction + choices.length) % choices.length;
    while (choices[next]?.disabled && next !== active);
    setActive(next);
  }
  function openMenu() {
    if (disabled) return;
    setActive(Math.max(0, choices.findIndex(choice => choice.value === selectedValue)));
    setOpen(true);
  }

  const sidebarPicker = Boolean(rootRef.current?.closest(".sidebar"));
  const renderChoice = (choice: Choice, index: number) => <div key={`${choice.group ?? ""}:${choice.value}:${index}`}>
      {choice.group && (index === 0 || choices[index - 1]?.group !== choice.group) && <div className="select-menu-group">{choice.group}</div>}
      <button id={`${listboxId}-option-${index}`} type="button" role="option" aria-selected={choice.value === selectedValue} disabled={choice.disabled}
        className={index === active ? "active" : ""} onPointerMove={() => setActive(index)} onClick={() => choose(choice)}>
        <span>{choice.label}</span>{choice.value === selectedValue && <span aria-hidden="true">✓</span>}
      </button>
    </div>;
  const picker = open && position && <div id={listboxId} className={`select-menu${sidebarPicker ? " select-menu-sidebar" : ""}`} role="listbox" aria-labelledby={ariaLabelledBy ?? triggerId} style={position}
    onPointerDown={event => event.preventDefault()}>
    <div className="select-menu-options">
      {choices.map((choice, index) => index === pinnedIndex ? null : renderChoice(choice, index))}
    </div>
    {pinnedIndex >= 0 && <div className="select-menu-footer">{renderChoice(choices[pinnedIndex]!, pinnedIndex)}</div>}
  </div>;
  const portalTarget = rootRef.current?.closest("dialog") ?? (typeof document === "undefined" ? null : document.body);

  return <div ref={rootRef} className={`custom-select${className ? ` ${className}` : ""}`} style={style}>
    <button ref={triggerRef} id={triggerId} type="button" className="custom-select-trigger" disabled={disabled}
      role="combobox" aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} aria-describedby={ariaDescribedBy} aria-invalid={ariaInvalid}
      aria-required={required || undefined} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listboxId : undefined}
      aria-activedescendant={open ? `${listboxId}-option-${active}` : undefined}
      onClick={() => {
        if (!open) openMenu();
        else { setOpen(false); onDismiss?.(); }
      }} onKeyDown={event => {
        if (event.key === "Escape") {
          if (open) { event.stopPropagation(); setOpen(false); onDismiss?.(); }
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!open) openMenu(); else move(event.key === "ArrowDown" ? 1 : -1);
        } else if (open && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          const choice = choices[active];
          if (choice) choose(choice);
        } else if (open && event.key === "Home") { event.preventDefault(); setActive(0); }
        else if (open && event.key === "End") { event.preventDefault(); setActive(choices.length - 1); }
        else if (event.key === "Tab" && open) { setOpen(false); onDismiss?.(); }
        else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          searchRef.current += event.key.toLocaleLowerCase();
          window.clearTimeout(searchTimer.current);
          searchTimer.current = window.setTimeout(() => { searchRef.current = ""; }, 500);
          const match = choices.findIndex(choice => !choice.disabled && choice.text.toLocaleLowerCase().startsWith(searchRef.current));
          if (match >= 0) { event.preventDefault(); if (!open) openMenu(); setActive(match); }
        }
      }}>
      <span className="custom-select-value">{selected?.label}</span><span className="custom-select-chevron" aria-hidden="true" />
    </button>
    <select {...nativeProps} ref={nativeRef} value={value} defaultValue={defaultValue} disabled={disabled} required={required}
      className="custom-select-native" aria-hidden="true" tabIndex={-1} onChange={onChange}
      onFocus={() => triggerRef.current?.focus()} onInvalid={event => { event.preventDefault(); triggerRef.current?.focus(); }}>
      {children}
    </select>
    {portalTarget && picker ? createPortal(picker, portalTarget) : null}
  </div>;
});

export default Select;
