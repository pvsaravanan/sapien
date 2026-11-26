import { figureText } from "./figure";
import type { Answer, Interaction, Job, Session, SessionEvent, Thinking } from "./types";

export const letter = (i: number) => String.fromCharCode(65 + i);

function thinkingText(t?: Thinking): string {
  if (!t) return "";
  const parts: string[] = [];
  if (typeof t.confidence === "number") parts.push(`confidence: ${Math.round(t.confidence)}%`);
  else if (t.confidence) parts.push(`confidence: ${t.confidence}`); // legacy records
  if (t.reasoning?.trim()) parts.push(`their thinking: "${t.reasoning.trim()}"`);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

function interactionText(i: Interaction, revealKey: boolean): string {
  if (i.kind === "ask") {
    const opts = i.options?.length ? `\nOptions: ${i.options.map((o, n) => `${letter(n)}) ${o}`).join("  ")}` : "";
    return `[ungraded question] ${i.question}${opts}`;
  }
  const tag = `[${i.role}${i.nodeId ? ` · node ${i.nodeId}` : ""}]`;
  if (i.kind === "choice") {
    const opts = i.options.map((o, n) => `  ${letter(n)}) ${o}${revealKey && i.optionNotes?.[n] ? ` [note: ${i.optionNotes[n]}]` : ""}`).join("\n");
    const key = revealKey ? `\nCorrect: ${i.correct.map(letter).join(", ")}${i.explanation ? `\nExplanation shown after answering: ${i.explanation}` : ""}` : "";
    return `${tag} multiple choice: ${i.question}\n${opts}${key}`;
  }
  return `${tag} explain in own words: ${i.question}${revealKey ? `\nCommitted answer: ${i.committedAnswer}${i.gradingNotes ? `\nGrading notes: ${i.gradingNotes}` : ""}` : ""}`;
}

function answerText(i: Interaction, a: Answer): string {
  if (a.dontKnow) return `Learner chose "I don't know"${thinkingText(a.thinking)}`;
  if (a.kind === "choice" || (a.selected && a.selected.length)) {
    const sel = (a.selected ?? []).map((n) => `${letter(n)}) ${i.kind !== "recall" ? (i.options?.[n] ?? "?") : "?"}`).join(", ");
    const text = "text" in a && a.text?.trim() ? ` and wrote: "${a.text.trim()}"` : "";
    return `Learner selected ${sel || "nothing"}${text}${thinkingText(a.thinking)}`;
  }
  return `Learner answered: "${(a.text ?? "").trim()}"${thinkingText(a.thinking)}`;
}

export interface TranscriptOptions {
  /** "agent": the session's own agents (see their committed answers).
   *  "helper": side-question helper (open answer keys and active solutions hidden). */
  audience: "agent" | "helper";
  jobs?: Job[];
  /** Only render events from this index on (older context omitted). */
  fromIndex?: number;
  /** Prefix results no agent has seen yet with [NEW]. */
  markUndelivered?: boolean;
  /** Display names for attached files. */
  fileName?: (id: string) => string | undefined;
}

function attachedText(ids: string[] | undefined, opts: TranscriptOptions): string {
  if (!ids?.length) return "";
  return ` [attached: ${ids.map((id) => opts.fileName?.(id) ?? id).join(", ")}]`;
}


function jobResultText(jobId: string, opts: TranscriptOptions): string {
  const job = opts.jobs?.find((j) => j.id === jobId);
      if (!job) return `[background job ${jobId} finished]`;
      if (job.status === "failed") return `[background ${job.kind} "${job.title}" failed: ${job.error ?? "unknown error"}]`;
      const r = job.result as Record<string, unknown> | undefined;
      if (job.kind === "research" && r) {
        const sources = (r.sources as { title: string; url: string }[]).map((s) => `  - ${s.title} <${s.url}>`).join("\n");
        return `[research result for "${job.title}" — visible to the learner]\n${r.answer}\nSources:\n${sources}`;
      }
      if (job.kind === "visual" && r) return `[visual "${job.title}" is now displayed to the learner. Caption: ${r.caption}]`;
      if (job.kind === "demo" && r) return `[interactive demo "${job.title}" is now displayed to the learner. How to use it: ${r.instructions}]`;
      return `[background job "${job.title}" finished]`;
}

export function renderEvent(e: SessionEvent, opts: TranscriptOptions): string | null {
  const helper = opts.audience === "helper";
  switch (e.type) {
    case "learner_message":
      return `LEARNER: ${e.text}${attachedText(e.attachments, opts)}${thinkingText(e.thinking)}`;
    case "agent_message":
      return `${e.agent.toUpperCase()}: ${e.text}${e.figure ? `\n${figureText(e.figure, opts.fileName?.(e.figure.fileId))}` : ""}`;
    case "question": {
      const answered = !!e.answer;
      const body = interactionText(e.interaction, answered || !helper);
      const lines = [`${e.agent.toUpperCase()} asked ${body}`];
      if (e.answer) lines.push(answerText(e.interaction, e.answer));
      else lines.push("(awaiting the learner's answer)");
      if (e.grade) lines.push(`Grade: ${e.grade.verdict}${e.grade.feedback ? ` — ${e.grade.feedback}` : ""}`);
      return lines.join("\n");
    }
    case "states":
      return `PROBE SUMMARY\nCurrent understanding: ${e.states.current}\nGoal: ${e.states.goal}`;
    case "plan":
      return `PLAN v${e.plan.version}${e.reason ? ` (${e.reason})` : ""}\n${e.plan.nodes
        .map((n) => `- ${n.id}: ${n.title}${n.summary ? ` — ${n.summary}` : ""}`)
        .join("\n")}\nDependencies: ${e.plan.edges.map((x) => `${x.from}→${x.to}`).join(", ") || "none"}`;
    case "job":
      return `[background ${e.kind} dispatched: "${e.title}" (job ${e.jobId})]`;
    case "job_result": {
      const fresh = opts.markUndelivered && !e.delivered ? "[NEW] " : "";
      const body = jobResultText(e.jobId, opts);
      return fresh ? body.replace(/^\[/, `[NEW · `) : body;
    }

    case "problem": {
      const solved = e.status === "concluded";
      const sol = solved || !helper ? `\nCommitted solution${solved ? "" : " (hidden from learner)"}: ${e.problem.solution}` : "";
      const end = solved ? `\nConcluded: ${e.outcome}${e.verdict ? ` — ${e.verdict}` : ""}` : "";
      return `PROBLEM (event ${e.id}): ${e.problem.statement}${sol}${end}`;
    }
    case "attempt":
      return `LEARNER ATTEMPT: ${e.text}${attachedText(e.attachments, opts)}${thinkingText(e.thinking)}`;
    case "next_problem":
      return "[learner asked for the next problem]";
    case "complete":
      return `[session marked complete: ${e.summary}]`;
    case "error":
      return null;
  }
}

export function renderTranscript(session: Session, opts: TranscriptOptions): string {
  const events = session.events.slice(opts.fromIndex ?? 0);
  return events
    .map((e) => renderEvent(e, opts))
    .filter((x): x is string => !!x)
    .join("\n\n");
}

/** Side-question exchanges the main agents have not yet seen. */
export function pendingSideNotes(session: Session): string {
  const fresh = session.side.filter((m) => !m.deliveredToAgent);
  if (!fresh.length) return "";
  return (
    "SIDE QUESTIONS the learner asked a helper since your last turn (context only — not answers to your questions):\n" +
    fresh.map((m) => `${m.from === "learner" ? "Learner" : "Helper"}: ${m.text}`).join("\n")
  );
}

/** The pending (unanswered) question, if any. */
export function pendingQuestion(session: Session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const e = session.events[i];
    if (e.type === "question") return e.answer ? null : e;
  }
  return null;
}

export function activeProblem(session: Session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const e = session.events[i];
    if (e.type === "problem") return e.status === "active" ? e : null;
  }
  return null;
}

/** One-line status for session lists. */
export function statusLine(s: Session, running: boolean): string {
  if (running || s.status === "running") return s.phase === "planning" ? "Planning" : "Thinking";
  if (s.lastError) return "Needs retry";
  if (s.phase === "complete") return "Complete";
  if (s.kind === "practice") {
    if (activeProblem(s)) return "Problem in progress";
    return s.events.some((e) => e.type === "problem") ? "Waiting for you" : "Starting";
  }
  if (pendingQuestion(s)) return "Waiting for your answer";
  return "Waiting for you";
}
