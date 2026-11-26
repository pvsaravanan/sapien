"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export type DropdownOption<T extends string> = { value: T; label: string; hint?: string; disabled?: boolean };

type Pos = { left: number; width: number; top?: number; bottom?: number; placement: "down" | "up" };

const MENU_MAX = 280;
const GAP = 4;

/**
 * App-wide dropdown (replaces native <select>). Listbox pattern: the trigger opens a
 * menu rendered in a portal, so it can't be clipped by overflow-hidden cards, and
 * flips upward when there's no room below.
 * Keys: ↑/↓ Home End to move, Enter/Space to pick, Esc to close, letters to jump.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  size = "md",
  label,
  title,
  disabled,
  className = "",
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  /** md: form field. sm: compact uppercase pill for toolbars. */
  size?: "md" | "sm";
  /** Accessible name when no visible label is associated. */
  label?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<Pos | null>(null);

  const selectedIdx = options.findIndex((o) => o.value === value);
  const selected = options[selectedIdx];

  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const want = Math.min(MENU_MAX, options.length * 36 + 10);
    const below = window.innerHeight - r.bottom - GAP;
    const up = below < want && r.top > below;
    setPos(
      up
        ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + GAP, placement: "up" }
        : { left: r.left, width: r.width, top: r.bottom + GAP, placement: "down" },
    );
  }, [options.length]);

  const step = useCallback(
    (from: number, dir: 1 | -1) => {
      const n = options.length;
      for (let i = 1; i <= n; i++) {
        const j = (from + dir * i + n) % n;
        if (!options[j].disabled) return j;
      }
      return from;
    },
    [options],
  );

  const openMenu = (at = selectedIdx) => {
    if (disabled) return;
    place();
    setActive(at >= 0 && !options[at]?.disabled ? at : step(-1, 1));
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    close();
  };

  // Focus the list on open; keep the menu attached to the trigger on scroll/resize.
  useLayoutEffect(() => {
    if (open) menuRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) close(false);
    };
    const onMove = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      place();
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${id}-o${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  const onTriggerKey = (e: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      openMenu(e.key === "ArrowUp" && selectedIdx < 0 ? options.length - 1 : selectedIdx);
    }
  };

  const onMenuKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setActive((a) => step(a, 1)); break;
      case "ArrowUp": e.preventDefault(); setActive((a) => step(a, -1)); break;
      case "Home": e.preventDefault(); setActive(step(-1, 1)); break;
      case "End": e.preventDefault(); setActive(step(options.length, -1)); break;
      case "Enter":
      case " ": e.preventDefault(); pick(active); break;
      case "Escape": e.preventDefault(); close(); break;
      case "Tab": close(false); break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const k = e.key.toLowerCase();
          const n = options.length;
          for (let i = 1; i <= n; i++) {
            const j = (active + i) % n;
            if (!options[j].disabled && options[j].label.toLowerCase().startsWith(k)) { setActive(j); break; }
          }
        }
    }
  };

  const sm = size === "sm";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`dd-trigger ${sm ? "dd-sm" : ""} ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={label ? `${label}: ${selected?.label ?? ""}` : undefined}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKey}
      >
        <span className="dd-value">{selected?.label ?? "Select…"}</span>
        <svg className="dd-chevron" width={sm ? 10 : 12} height={sm ? 10 : 12} viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
        </svg>
      </button>
      {open && pos &&
        createPortal(
          <ul
            ref={menuRef}
            id={`${id}-list`}
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined}
            className={`dd-menu ${sm ? "dd-menu-sm" : ""}`}
            data-placement={pos.placement}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width }}
            onKeyDown={onMenuKey}
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-o${i}`}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                data-active={i === active}
                className="dd-option"
                onPointerMove={() => !o.disabled && active !== i && setActive(i)}
                onClick={() => pick(i)}
              >
                <span className="dd-option-label">{o.label}</span>
                {o.hint && <span className="dd-hint">{o.hint}</span>}
                <svg className="dd-check" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ visibility: o.value === value ? "visible" : "hidden" }}>
                  <path d="m2 6.2 2.6 2.6L10 3.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
                </svg>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
