"use client";

import { useState } from "react";
import type { KnowledgeStates } from "@/src/core/types";

/** Split the prober's detailed notes into labelled sections and numbered points.
 *  Labels are runs of capitals ending in ":" (e.g. "HELD FIRMLY:", "MISSING:"). */
export function sections(text: string): { label?: string; items: string[] }[] {
  const parts = text.split(/\b([A-Z][A-Z ]{3,}[A-Z](?: \([^)]{1,40}\))?):\s*/);
  const out: { label?: string; items: string[] }[] = [];
  const items = (t: string) =>
    t
      .split(/\s(?=\(\d+\)\s)/)
      .map((x) => x.replace(/^\(\d+\)\s*/, "").trim())
      .filter(Boolean);
  if (parts[0]?.trim()) out.push({ items: [parts[0].trim()] });
  for (let i = 1; i < parts.length; i += 2) {
    const label = parts[i].trim();
    out.push({ label: label.charAt(0) + label.slice(1).toLowerCase(), items: items(parts[i + 1] ?? "") });
  }
  return out;
}

function firstSentence(text: string): string {
  const m = /^(.{20,180}?[.!?])(\s|$)/.exec(text.trim());
  return m ? m[1] : text.trim().slice(0, 160) + (text.length > 160 ? "…" : "");
}

function Detail({ text }: { text: string }) {
  return (
    <div className="mt-2 space-y-2.5">
      {sections(text).map((sec, i) => (
        <div key={i}>
          {sec.label && <div className="label-muted mb-1 !text-[0.6rem]">{sec.label}</div>}
          {sec.items.length > 1 ? (
            <ul className="list-[square] space-y-1 pl-4 marker:text-[var(--blue)]">
              {sec.items.map((it, j) => (
                <li key={j}>{it}</li>
              ))}
            </ul>
          ) : (
            <p>{sec.items[0]}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function Row({ label, brief, detail, accent }: { label: string; brief?: string; detail: string; accent?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-4 py-3">
      <div className={`${accent ? "label" : "label-muted"} !text-[0.62rem]`}>{label}</div>
      <p className="mt-1 text-[0.9rem] leading-snug">{brief?.trim() || firstSentence(detail)}</p>
      <button className="ui mt-1.5 text-[0.68rem] uppercase tracking-[0.1em]" style={{ color: "var(--ink-mute)" }} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide details ↑" : "Details ↓"}
      </button>
      {open && (
        <div className="text-[0.8rem] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
          <Detail text={detail} />
        </div>
      )}
    </div>
  );
}

export function StatesCard({ states }: { states: KnowledgeStates }) {
  return (
    <div className="card">
      <Row label="Where you started" brief={states.currentBrief} detail={states.current} />
      <div style={{ borderTop: "1px solid var(--rule-soft)" }}>
        <Row label="Where you're going" brief={states.goalBrief} detail={states.goal} accent />
      </div>
    </div>
  );
}
