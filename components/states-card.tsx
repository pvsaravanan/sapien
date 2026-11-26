"use client";

import { useState } from "react";
import { parseStates, type StateItem, type StateSection, type StateStatus } from "@/src/core/states";
import type { KnowledgeStates } from "@/src/core/types";
import { Markdown } from "./markdown";

const TONE: Record<StateStatus, string> = {
  held: "var(--good)",
  partial: "var(--warn)",
  missing: "var(--bad)",
  new: "var(--ink-mute)",
  other: "var(--blue)",
};

/** The notes are written for the agents about "they"; the card speaks to the learner. */
const PRONOUNS: [RegExp, string][] = [
  [/\bthey're\b/g, "you're"], [/\bThey're\b/g, "You're"],
  [/\bthey've\b/g, "you've"], [/\bThey've\b/g, "You've"],
  [/\bthemselves\b/g, "yourself"], [/\bthem\b/g, "you"],
  [/\btheir\b/g, "your"], [/\bTheir\b/g, "Your"],
  [/\bthey\b/g, "you"], [/\bThey\b/g, "You"],
];
const toYou = (t: string) => PRONOUNS.reduce((s, [re, to]) => s.replace(re, to), t);
const display = (t: string) => {
  const s = toYou(t);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const SHOWN = 4;

function Items({ items, tone, evidence, check }: { items: StateItem[]; tone: string; evidence: boolean; check?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <>
      <ul className="states-list">
        {shown.map((it, i) => (
          <li key={i} style={{ ["--tone" as string]: tone }} data-check={check || undefined}>
            <Markdown className="md-tight">{display(it.text)}</Markdown>
            {evidence && it.detail && <Markdown className="md-tight states-evidence">{display(it.detail)}</Markdown>}
          </li>
        ))}
      </ul>
      {items.length > SHOWN && (
        <button type="button" className="ui states-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `+${items.length - SHOWN} more`}
        </button>
      )}
    </>
  );
}

function Group({ section, evidence }: { section: StateSection; evidence: boolean }) {
  const tone = TONE[section.status];
  return (
    <div className="states-group">
      <div className="states-group-head ui">
        <span className="states-dot" style={{ background: section.status === "new" ? "transparent" : tone, borderColor: tone }} aria-hidden="true" />
        <span>{section.label}</span>
        <span className="states-count">{section.items.length}</span>
      </div>
      <Items items={section.items} tone={tone} evidence={evidence} />
    </div>
  );
}

function Block({ label, brief, text, goal }: { label: string; brief?: string; text: string; goal?: boolean }) {
  const [evidence, setEvidence] = useState(false);
  const p = parseStates(text);
  const hasEvidence = [...p.items, ...p.sections.flatMap((s) => s.items)].some((i) => i.detail);
  const summary = brief?.trim();
  return (
    <section className="px-4 py-3.5">
      <h3 className={`${goal ? "label" : "label-muted"} !text-[0.62rem]`}>{label}</h3>
      {summary && <p className="mt-1.5 text-[0.92rem] leading-snug">{summary}</p>}
      {p.lead && <p className={summary ? "states-lead mt-1.5" : "mt-1.5 text-[0.92rem] leading-snug"}>{display(p.lead)}</p>}
      {p.items.length > 0 && (
        <div className="mt-3">
          {goal && <div className="states-group-head ui mb-1">By the end, these should feel obvious</div>}
          <Items items={p.items} tone={goal ? "var(--blue)" : TONE.other} evidence={evidence} check={goal} />
        </div>
      )}
      {p.sections.map((s, i) => (
        <Group key={i} section={s} evidence={evidence} />
      ))}
      {hasEvidence && (
        <button type="button" className="ui states-more mt-2.5" aria-expanded={evidence} onClick={() => setEvidence((v) => !v)}>
          {evidence ? "Hide evidence" : "Show evidence"}
        </button>
      )}
    </section>
  );
}

/** "Where you started" / "Where you're going": the prober's two knowledge states,
 *  as status groups and a goal checklist. */
export function StatesCard({ states }: { states: KnowledgeStates }) {
  return (
    <div className="card">
      <Block label="Where you started" brief={states.currentBrief} text={states.current} />
      <div style={{ borderTop: "1px solid var(--rule-soft)" }}>
        <Block label="Where you're going" brief={states.goalBrief} text={states.goal} goal />
      </div>
    </div>
  );
}
