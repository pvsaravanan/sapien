"use client";

/** Square toggle switch used across settings panels. */
export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => onChange(!value)}
      className="relative h-[20px] w-[36px] shrink-0 border transition-colors"
      style={{ borderColor: value ? "var(--blue)" : "var(--rule-soft)", background: value ? "var(--blue-tint-strong)" : "transparent" }}
    >
      <span className="absolute top-[3px] h-3 w-3 transition-all" style={{ left: value ? 19 : 3, background: value ? "var(--blue)" : "var(--ink-mute)" }} />
    </button>
  );
}

/** Mono segmented control. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex flex-wrap border" style={{ borderColor: "var(--rule-soft)" }}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className="ui px-3.5 py-2 text-[0.72rem] uppercase tracking-[0.1em] transition-colors"
          style={{
            borderLeft: i ? "1px solid var(--rule-soft)" : undefined,
            background: value === o.value ? "var(--blue-tint)" : "transparent",
            color: value === o.value ? "var(--blue)" : "var(--ink-soft)",
            boxShadow: value === o.value ? "inset 0 0 0 1px var(--blue)" : undefined,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
