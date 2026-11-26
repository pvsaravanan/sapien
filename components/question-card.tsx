"use client";

import { useMemo, useState } from "react";
import type { Answer, SessionEvent, Thinking } from "@/src/core/types";
import { formatModelAnswer } from "@/src/core/answer-format";
import { DictateButton } from "./dictation";
import { Markdown } from "./markdown";

type QuestionEvent = Extract<SessionEvent, { type: "question" }>;

/** Deterministic per-question shuffle so the order is stable across reloads. */
export function shuffledOrder(seed: string, n: number): number[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const ROLE_LABEL = { probe: "Where are you?", predict: "Prediction", check: "Check" } as const;

const VERDICT: Record<string, { label: string; color: string }> = {
  correct: { label: "Correct", color: "var(--good)" },
  partial: { label: "Partly right", color: "var(--warn)" },
  incorrect: { label: "Not quite", color: "var(--bad)" },
  dontKnow: { label: "Gap noted", color: "var(--muted)" },
};

/** Confidence slider (0–100%). Untouched = not reported. */
export function ConfidenceRow({ value, onChange }: { value: number | undefined; onChange: (v: number) => void }) {
  const v = value ?? 50;
  return (
    <div className="flex items-center gap-5 px-5 py-4">
      <span className="label">Confidence</span>
      <div className="relative flex-1">
        <input type="range" min={0} max={100} step={5} value={v} onChange={(e) => onChange(Number(e.target.value))} className="conf" style={{ ["--pct" as string]: `${value === undefined ? 0 : v}%` }} aria-label="Confidence" />
        <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-between px-[1px]">
          {[0, 25, 50, 75, 100].map((t) => <span key={t} className="h-2 w-px" style={{ background: t === 0 || t === 100 ? "transparent" : "#3b4469" }} />)}
        </div>
      </div>
      <span className="ui w-12 text-right text-sm tabular-nums" style={{ color: value === undefined ? "var(--faint)" : "var(--accent)" }}>{value === undefined ? "—" : `${v}%`}</span>
    </div>
  );
}

/** The bordered "your thinking" box with submit footer. */
export function ThinkingBox({
  label = "Your thinking",
  placeholder = "Why this answer? Whatever comes to mind.",
  value,
  onChange,
  onSubmit,
  canSubmit,
  submitLabel = "Submit answer",
  extra,
  autoFocus,
}: {
  label?: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  canSubmit: boolean;
  submitLabel?: string;
  extra?: React.ReactNode;
  autoFocus?: boolean;
}) {
  return (
    <div className="m-3 border" style={{ borderColor: "var(--line-strong)", background: "var(--bg)" }}>
      <div className="label px-4 pt-3">{label}</div>
      <textarea
        autoFocus={autoFocus}
        className="block min-h-24 w-full resize-y bg-transparent px-4 py-2 text-[1.02rem] outline-none placeholder:text-[var(--faint)]"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSubmit) onSubmit();
          }
        }}
      />
      <div className="flex items-center gap-3 px-3 pb-3">
        <DictateButton value={value} onChange={onChange} />
        <span className="ui faint hidden text-xs sm:inline">↵ submits · ⇧↵ newline</span>
        <span className="flex-1" />
        {extra}
        <button className="btn btn-primary" disabled={!canSubmit} onClick={onSubmit}>{submitLabel}</button>
      </div>
    </div>
  );
}

function OptionRow({
  children,
  selected,
  multi,
  state,
  disabled,
  dashed,
  note,
  onClick,
}: {
  children: React.ReactNode;
  selected: boolean;
  multi?: boolean;
  state?: "correct" | "wrong";
  disabled: boolean;
  dashed?: boolean;
  /** After answering: why this option is right, or the mistake behind it. */
  note?: string;
  onClick: () => void;
}) {
  const border = state === "correct" ? "var(--good)" : state === "wrong" ? "var(--bad)" : selected ? "var(--accent)" : "var(--line-strong)";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-4 px-4 py-3 text-left transition-colors enabled:hover:bg-[var(--hover)] disabled:cursor-default"
      style={{ border: `1px ${dashed ? "dashed" : "solid"} ${border}`, background: selected ? "var(--accent-soft)" : "var(--bg)" }}
    >
      <span
        className={`mt-1 flex h-[16px] w-[16px] shrink-0 items-center justify-center border ${multi ? "" : "rounded-full"}`}
        style={{ borderColor: selected ? "var(--accent)" : "#4a5580" }}
      >
        {selected && <span className={`h-2 w-2 ${multi ? "" : "rounded-full"}`} style={{ background: "var(--accent)" }} />}
      </span>
      <span className="min-w-0 flex-1">
        {children}
        {note && (
          <span className="option-note" data-state={state ?? (selected ? "chosen" : "other")}>
            <Markdown className="md-tight">{note}</Markdown>
          </span>
        )}
      </span>
      {state === "correct" && <span style={{ color: "var(--good)" }}>✓</span>}
      {state === "wrong" && <span style={{ color: "var(--bad)" }}>✗</span>}
    </button>
  );
}

export function QuestionCard({
  event,
  interactive,
  stale,
  submitDisabled = false,
  onAnswer,
}: {
  event: QuestionEvent;
  interactive: boolean;
  stale: boolean;
  /** Keep the inputs editable but hold submission (e.g. while a result is being added). */
  submitDisabled?: boolean;
  onAnswer: (a: Answer) => void;
}) {
  const i = event.interaction;
  const options = i.kind === "recall" ? [] : (i.options ?? []);
  const order = useMemo(() => shuffledOrder(event.id, options.length), [event.id, options.length]);
  const multi = i.kind === "choice" && (i.multi ?? i.correct.length > 1);
  const [selected, setSelected] = useState<number[]>([]);
  const [dontKnow, setDontKnow] = useState(false);
  const [text, setText] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [confidence, setConfidence] = useState<number | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const graded = i.kind !== "ask";
  const a = event.answer;

  const toggle = (n: number) => {
    setDontKnow(false);
    setSelected((s) => (multi ? (s.includes(n) ? s.filter((x) => x !== n) : [...s, n]) : [n]));
  };
  const thinking = (): Thinking | undefined =>
    reasoning.trim() || confidence !== undefined ? { reasoning: reasoning.trim() || undefined, confidence } : undefined;
  const canSubmit = !sending && !submitDisabled && (dontKnow || (i.kind === "choice" ? selected.length > 0 : text.trim().length > 0 || selected.length > 0));
  const submit = () => {
    if (!canSubmit) return;
    setSending(true);
    const t = thinking();
    if (dontKnow) onAnswer({ kind: i.kind === "choice" ? "choice" : (i.kind as "recall"), selected: [], dontKnow: true, thinking: t });
    else if (i.kind === "choice") onAnswer({ kind: "choice", selected, thinking: t });
    else onAnswer({ kind: i.kind, text, selected, thinking: t });
  };

  const verdict = event.grade ? VERDICT[event.grade.verdict] : null;
  const shownSelected = a?.selected ?? selected;
  const label = i.kind === "ask" ? "Question" : ROLE_LABEL[i.role];

  return (
    <div className={`overflow-hidden ${interactive ? "card-feature" : "card"}`} style={{ opacity: stale ? 0.55 : 1 }}>
      <div className="px-5 pb-2 pt-4">
        <div className="mb-1.5 flex items-center gap-3">
          <span className="label">{label}{i.kind !== "ask" && i.nodeId ? <span className="faint"> · {i.nodeId}</span> : null}</span>
          {verdict && <span className="ui text-xs" style={{ color: verdict.color }}>{verdict.label}</span>}
          {stale && <span className="ui faint text-xs">skipped</span>}
        </div>
        <Markdown className="md-flush">{i.question}</Markdown>
      </div>

      {options.length > 0 && (
        <div className="space-y-2.5 px-5 py-3">
          {order.map((n) => {
            const isSel = shownSelected.includes(n);
            const state = a && i.kind === "choice" ? (i.correct.includes(n) ? "correct" : isSel ? "wrong" : undefined) : undefined;
            return (
              <OptionRow
                key={n}
                selected={isSel}
                multi={multi}
                state={state}
                disabled={!interactive}
                note={a && i.kind === "choice" ? i.optionNotes?.[n] : undefined}
                onClick={() => toggle(n)}
              >
                <Markdown className="md-tight">{options[n]}</Markdown>
              </OptionRow>
            );
          })}
          {graded && (interactive || a?.dontKnow) && (
            <OptionRow dashed selected={interactive ? dontKnow : !!a?.dontKnow} disabled={!interactive} onClick={() => (setDontKnow((d) => !d), setSelected([]))}>
              <span className="ui muted">I don&apos;t know</span>
            </OptionRow>
          )}
          {interactive && multi && <p className="ui faint pt-1 text-xs">Select all that apply.</p>}
        </div>
      )}

      {interactive && i.kind !== "choice" && (
        <div className="px-5 py-3">
          <textarea
            autoFocus
            className="field min-h-28 text-[1.02rem]"
            placeholder={i.kind === "recall" ? "Explain in your own words…" : "Your answer…"}
            value={text}
            onChange={(e) => (setText(e.target.value), setDontKnow(false))}
          />
          <div className="mt-2 flex justify-end">
            <DictateButton value={text} onChange={(v) => (setText(v), setDontKnow(false))} />
          </div>
          {graded && (
            <div className="mt-2.5">
              <OptionRow dashed selected={dontKnow} disabled={false} onClick={() => setDontKnow((d) => !d)}>
                <span className="ui muted">I don&apos;t know</span>
              </OptionRow>
            </div>
          )}
        </div>
      )}

      {interactive && (
        <>
          {graded && (
            <div className="border-t" style={{ borderColor: "var(--line)" }}>
              <ConfidenceRow value={confidence} onChange={setConfidence} />
            </div>
          )}
          <div className="border-t" style={{ borderColor: "var(--line)" }}>
            {graded ? (
              <ThinkingBox value={reasoning} onChange={setReasoning} onSubmit={submit} canSubmit={canSubmit} autoFocus={i.kind === "choice"} />
            ) : (
              <div className="flex justify-end p-3">
                <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>Submit answer</button>
              </div>
            )}
          </div>
        </>
      )}

      {a && (
        <div className="dashed space-y-3 px-5 py-4 text-[0.98rem]">
          {"text" in a && a.text && (
            <div>
              <div className="label mb-1">Your answer</div>
              <div className="whitespace-pre-wrap">{a.text}</div>
            </div>
          )}
          {(a.thinking?.reasoning || typeof a.thinking?.confidence === "number") && (
            <div className="muted text-sm">
              {typeof a.thinking?.confidence === "number" && <span className="ui mr-2 text-xs">{a.thinking.confidence}% confident</span>}
              {a.thinking?.reasoning && <span className="italic">“{a.thinking.reasoning}”</span>}
            </div>
          )}
          {event.grade?.feedback && <Markdown>{event.grade.feedback}</Markdown>}
          {i.kind === "choice" && i.explanation && (
            <div className="answer-explain">
              <div className="label mb-2">Why</div>
              <Markdown className="md-flush">{i.explanation}</Markdown>
            </div>
          )}
          {i.kind === "recall" && i.committedAnswer && (
            <details>
              <summary className="label cursor-pointer">Model answer</summary>
              <Markdown className="mt-1">{formatModelAnswer(i.committedAnswer)}</Markdown>
            </details>
          )}
          {i.kind === "recall" && !event.grade && <p className="ui faint text-xs">Grading…</p>}
        </div>
      )}
    </div>
  );
}
