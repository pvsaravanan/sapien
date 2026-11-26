import {
  runGrader,
  runHelper,
  runPlanner,
  runPractitioner,
  runProber,
  runScribe,
  runTeacher,
  runSummarizer,
  runWorker,
  sessionTopicHeader,
  type Ctx,
  type DeliveryMode,
  type Dispatch,
  type PractitionerOutput,
  type ProberOutput,
  type TeacherOutput,
} from "../agents/agents";
import { partialStringField } from "../core/partial";
import { searchGraph } from "../core/graph";
import { relatedProps } from "./embeddings";
import { planStatus } from "../core/plan";
import {
  activeProblem,
  pendingQuestion,
  pendingSideNotes,
  renderEvent,
  renderTranscript,
} from "../core/transcript";
import type {
  Answer,
  AgentRole,
  Attachment,
  Grade,
  Interaction,
  Job,
  JobKind,
  Session,
  SessionEvent,
  SessionKind,
  Settings,
  Thinking,
  Usage,
  Proposition,
  ModelAlias,
  Effort,
} from "../core/types";
import { withWorkerSlot } from "./engine";
import { maybeExtract } from "./extraction";
import { fileBlocks, filesFor, getFile } from "./files";
import { toFigure, type FigureDraft, type FileView } from "../core/figure";
import { splitRubric } from "../core/answer-format";
import { PROVIDERS } from "../core/provider-info";
import { getGraph, getJob, getSession, getSettings, listJobs, listSessions, saveJob, saveSession } from "./store";

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

type NewEvent = SessionEvent extends infer E ? (E extends SessionEvent ? Omit<E, "id" | "at"> : never) : never;
export function makeEvent(e: NewEvent): SessionEvent {
  return { id: newId(), at: now(), ...e } as SessionEvent;
}

export class InputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Synchronous read-modify-write. All session writes go through here so a running
 *  turn and a finishing background job never overwrite each other. */
export function mutate(id: string, fn: (s: Session) => void): Session {
  const s = getSession(id);
  if (!s) throw new InputError("Session not found", 404);
  fn(s);
  saveSession(s);
  return s;
}

function emptyUsage(): Usage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

// ─── process-wide state (survives Next's per-route module copies) ──────────

/** What the browser shows while an agent is working: streamed text and/or a status. */
export interface LiveState {
  agent: AgentRole;
  text: string;
  status?: string;
}
type TurnKind = "normal" | "delivery";

const g = globalThis as unknown as {
  __sapien?: {
    running: Set<string>;
    booted: boolean;
    aborts: Map<string, AbortController>;
    live?: Map<string, LiveState>;
    turnKind?: Map<string, TurnKind>;
  };
};
type ProcessState = NonNullable<typeof g.__sapien>;
const state: ProcessState = (g.__sapien ??= { running: new Set(), booted: false, aborts: new Map() });
const live = (state.live ??= new Map());
const turnKind = (state.turnKind ??= new Map());

export function getLive(id: string): LiveState | null {
  return live.get(id) ?? null;
}
export function getTurnKind(id: string): TurnKind | null {
  return turnKind.get(id) ?? null;
}

/** On first use after a (re)start: release stale locks and resume unfinished jobs. */
export function boot() {
  if (state.booted) return;
  state.booted = true;
  for (const s of listSessions()) {
    if (s.status === "running") {
      mutate(s.id, (x) => {
        x.status = "idle";
        x.lastError = "The server restarted during this turn. Press Retry to continue.";
      });
    }
  }
  for (const j of listJobs()) if (j.status === "running") void executeJob(j.id);
}

// ─── session lifecycle ──────────────────────────────────────────────────────

export function createSession(input: {
  kind: SessionKind;
  topic: string;
  seedNodeIds?: string[];
  model?: ModelAlias;
  effort?: Effort;
  attachmentIds?: string[];
}): Session {
  boot();
  const topic = input.topic.trim();
  const files = validFiles(input.attachmentIds);
  if (!topic && !files.length && !(input.kind === "practice" && input.seedNodeIds?.length)) throw new InputError("Describe what you want to learn.");
  const graph = getGraph();
  const seeds = (input.seedNodeIds ?? []).filter((id) => graph.propositions.some((p) => p.id === id));
  const seedTitle = seeds.length
    ? `Practice: ${seeds
        .slice(0, 3)
        .map((id) => graph.propositions.find((p) => p.id === id)!.name)
        .join(", ")}`
    : "";
  const title = topic || seedTitle;
  const s: Session = {
    id: newId(),
    kind: input.kind,
    title: (title || getFile(files[0])?.name || "New lesson").slice(0, 80),
    topic: topic || (files.length ? `The attached material (${files.map((f) => getFile(f)?.name).join(", ")})` : title),
    createdAt: now(),
    updatedAt: now(),
    phase: input.kind === "teach" ? "probing" : "practice",
    events: [
      makeEvent({
        type: "learner_message",
        text: topic || (files.length ? "Teach me from the attached material." : "I'd like to practice the selected material."),
        attachments: files.length ? files : undefined,
      }),
    ],
    attachments: files.length ? files : undefined,
    usage: emptyUsage(),
    extractedThrough: 0,
    seedNodeIds: seeds.length ? seeds : undefined,
    side: [],
    status: "idle",
    model: input.model,
    effort: input.effort,
  };
  saveSession(s);
  startTurn(s.id);
  return getSession(s.id)!;
}

export type LearnerInput =
  | { type: "message"; text: string; thinking?: Thinking; attachmentIds?: string[] }
  | { type: "answer"; eventId: string; answer: Answer }
  | { type: "attempt"; text: string; thinking?: Thinking; attachmentIds?: string[] }
  | { type: "next_problem" }
  | { type: "retry" };

/** Validate and persist learner input, then start the agent turn. */
export function submitInput(id: string, input: LearnerInput): Session {
  boot();
  if (state.running.has(id)) throw new InputError("The agent is still working on this session.", 409);
  const s = mutate(id, (s) => {
    s.lastError = undefined;
    switch (input.type) {
      case "message": {
        const files = attachTo(s, input.attachmentIds);
        if (!input.text.trim() && !files.length) throw new InputError("Message is empty.");
        s.events.push(
          makeEvent({
            type: "learner_message",
            text: input.text.trim() || "I've attached a file.",
            thinking: input.thinking,
            attachments: files.length ? files : undefined,
          }),
        );
        if (s.phase === "complete") s.phase = "teaching";
        break;
      }
      case "answer": {
        const ev = s.events.find((e) => e.id === input.eventId);
        if (!ev || ev.type !== "question") throw new InputError("Question not found.", 404);
        if (ev.answer) throw new InputError("That question was already answered.", 409);
        if (pendingQuestion(s)?.id !== ev.id) throw new InputError("That question is no longer current.", 409);
        ev.answer = normalizeAnswer(ev.interaction, input.answer);
        ev.answeredAt = now();
        ev.grade = gradeChoice(ev.interaction, ev.answer);
        break;
      }
      case "attempt": {
        const p = activeProblem(s);
        if (!p) throw new InputError("There is no active problem.", 409);
        const files = attachTo(s, input.attachmentIds);
        if (!input.text.trim() && !files.length) throw new InputError("Attempt is empty.");
        s.events.push(
          makeEvent({
            type: "attempt",
            problemEventId: p.id,
            text: input.text.trim() || "My working is in the attached file.",
            thinking: input.thinking,
            attachments: files.length ? files : undefined,
          }),
        );
        break;
      }
      case "next_problem": {
        if (s.kind !== "practice") throw new InputError("Not a practice session.");
        if (activeProblem(s)) throw new InputError("Finish or give up on the current problem first.", 409);
        s.events.push(makeEvent({ type: "next_problem" }));
        break;
      }
      case "retry":
        break;
    }
  });
  startTurn(s.id);
  return getSession(id)!;
}

const MAX_FILES = 20;

function validFiles(ids: string[] | undefined): string[] {
  const out = [...new Set((ids ?? []).map(String))].filter((id) => !!getFile(id));
  if ((ids?.length ?? 0) > 0 && out.length !== new Set(ids).size) throw new InputError("One of the attached files could not be found. Upload it again.");
  return out;
}

/** Add files to the session (deduplicated, capped) and return the ids for the event. */
function attachTo(s: Session, ids: string[] | undefined): string[] {
  const files = validFiles(ids);
  const all = [...new Set([...(s.attachments ?? []), ...files])];
  if (all.length > MAX_FILES) throw new InputError(`A session can hold at most ${MAX_FILES} files.`);
  if (files.length) s.attachments = all;
  return files;
}

function normalizeAnswer(i: Interaction, a: Answer): Answer {
  const c = a.thinking?.confidence;
  const thinking = a.thinking
    ? {
        confidence: typeof c === "number" && Number.isFinite(c) ? Math.min(100, Math.max(0, Math.round(c))) : undefined,
        reasoning: a.thinking.reasoning?.slice(0, 8000),
      }
    : undefined;
  if (a.dontKnow) return { kind: i.kind === "choice" ? "choice" : (i.kind as "recall" | "ask"), selected: [], dontKnow: true, thinking } as Answer;
  if (i.kind === "choice") {
    const max = i.options.length;
    const selected = [...new Set(a.selected ?? [])].filter((n) => Number.isInteger(n) && n >= 0 && n < max).sort();
    if (!selected.length) throw new InputError("Select an answer, or choose “I don't know”.");
    return { kind: "choice", selected, thinking };
  }
  const text = ("text" in a ? a.text : "")?.trim().slice(0, 20000) ?? "";
  const selected = i.kind === "ask" ? (a.selected ?? []).filter((n) => n >= 0 && n < (i.options?.length ?? 0)) : [];
  if (!text && !selected.length) throw new InputError("Write an answer, or choose “I don't know”.");
  return { kind: i.kind, text, selected, thinking };
}

/** Multiple choice is graded on submission; recall waits for the grader. */
function gradeChoice(i: Interaction, a: Answer): Grade | undefined {
  if (i.kind === "ask") return undefined;
  if (a.dontKnow) return { verdict: "dontKnow" };
  if (i.kind !== "choice") return undefined;
  const sel = new Set(a.selected ?? []);
  const correct = new Set(i.correct);
  const hits = [...sel].filter((x) => correct.has(x)).length;
  if (hits === correct.size && sel.size === correct.size) return { verdict: "correct" };
  if (hits > 0 && hits === sel.size) return { verdict: "partial" };
  return { verdict: "incorrect" };
}

export function abortTurn(id: string) {
  state.aborts.get(id)?.abort();
}

export function isRunning(id: string) {
  return state.running.has(id);
}

// ─── the turn ───────────────────────────────────────────────────────────────

function startTurn(id: string, kind: TurnKind = "normal") {
  if (state.running.has(id)) return;
  state.running.add(id);
  turnKind.set(id, kind);
  const controller = new AbortController();
  state.aborts.set(id, controller);
  mutate(id, (s) => (s.status = "running"));
  void runTurn(id, controller.signal, kind);
}

const INTERACTIVE: AgentRole[] = ["prober", "planner", "teacher", "practitioner"];

/** Apply a session's model/effort override to the interactive agents. */
export function settingsFor(s: Pick<Session, "model" | "effort">, base = getSettings()): Settings {
  if (!s.model && !s.effort) return base;
  const models = { ...base.models };
  const effort = { ...base.effort };
  for (const r of INTERACTIVE) {
    if (s.model) models[r] = s.model;
    if (s.effort) effort[r] = s.effort;
  }
  return { ...base, models, effort };
}

async function runTurn(id: string, signal: AbortSignal, kind: TurnKind) {
  const settings = settingsFor(getSession(id)!);
  try {
    if (kind === "normal") await maybeCompact(id, settings, signal);
    // Agents chain within one turn: prober → planner → teacher, or teacher → planner → teacher.
    let more = kind === "delivery" ? await deliveryStep(id, settings, signal) : true;
    for (let step = 0; more && step < 5; step++) {
      if (signal.aborted) throw new Error("Stopped.");
      more = await step1(id, settings, signal);
    }
  } catch (err) {
    if (kind === "delivery" && !signal.aborted) {
      // A failed comment on a background result is not worth an error banner.
      console.warn(`[sapien] delivery turn failed for ${id}:`, err instanceof Error ? err.message : err);
      if (getSession(id)) mutate(id, (s) => markDelivered(s, null));
    } else {
      const message = signal.aborted ? "Stopped by the learner." : err instanceof Error ? err.message : String(err);
      // The session may have been deleted while its turn was running.
      if (getSession(id))
        mutate(id, (s) => {
          s.lastError = message;
          s.events.push(makeEvent({ type: "error", message }));
        });
    }
  } finally {
    state.running.delete(id);
    state.aborts.delete(id);
    live.delete(id);
    turnKind.delete(id);
    if (getSession(id)) {
      mutate(id, (s) => (s.status = "idle"));
      void maybeExtract(id).catch(() => {});
      // Results that arrived while this turn ran get their own delivery turn.
      setTimeout(() => maybeDeliver(id), 0);
    }
  }
}

/** Ids of job_result events the agents have not been shown yet. */
function undelivered(s: Session): Set<string> {
  return new Set(s.events.filter((e) => e.type === "job_result" && !e.delivered).map((e) => e.id));
}

/** Mark results as seen by an agent. `ids` null = all. */
function markDelivered(s: Session, ids: Set<string> | null) {
  for (const e of s.events) if (e.type === "job_result" && (!ids || ids.has(e.id))) e.delivered = true;
}

/** Wake the session's agent when a background result is waiting and nothing else is happening. */
function maybeDeliver(id: string) {
  const s = getSession(id);
  if (!s || state.running.has(id) || s.lastError) return;
  if (!undelivered(s).size) return;
  if (s.kind === "teach" && s.phase === "planning") return;
  startTurn(id, "delivery");
}

/** Per-call agent context: settings, usage, abort, learner files, live streaming. */
async function agentCtx(id: string, s: Session, settings: Settings, usage: Usage, signal: AbortSignal, agent: AgentRole, field: string | null, status?: string): Promise<Ctx> {
  live.set(id, { agent, text: "", status });
  const { blocks, omitted } = await filesFor(s.attachments ?? [], settings);
  const textPdf = PROVIDERS[settings.provider].pdf === "text";
  const fileViews: FileView[] = (s.attachments ?? [])
    .map(getFile)
    .filter((m): m is Attachment => !!m)
    .map((m) => ({ id: m.id, name: m.name, kind: m.kind, pages: m.pages, sent: !omitted.includes(m.name), textOnly: m.kind === "pdf" && textPdf }));
  return {
    settings,
    usage,
    signal,
    files: blocks.length ? blocks : undefined,
    fileViews,
    onPartial: field
      ? (json) => {
          const text = partialStringField(json, field);
          if (text !== null) live.set(id, { agent, text, status });
        }
      : undefined,
  };
}

function committer(id: string, usage: Usage, seen: Set<string>) {
  return (fn: (s: Session) => void) =>
    mutate(id, (x) => {
      fn(x);
      x.usage.calls += usage.calls;
      x.usage.inputTokens += usage.inputTokens;
      x.usage.outputTokens += usage.outputTokens;
      x.usage.costUsd += usage.costUsd;
      Object.assign(usage, emptyUsage());
      for (const m of x.side) m.deliveredToAgent = true;
      markDelivered(x, seen);
      live.delete(id);
    });
}

function practiceState(s: Session) {
  const active = activeProblem(s);
  const lastProblem = [...s.events].reverse().find((e) => e.type === "problem");
  const awaitingNext = !active && !!lastProblem && !s.events.slice(s.events.indexOf(lastProblem)).some((e) => e.type === "next_problem");
  return { active: !!active, awaitingNext };
}

/** One agent action. Returns true when another agent should act immediately. */
async function step1(id: string, settings: Settings, signal: AbortSignal): Promise<boolean> {
  const s = getSession(id)!;
  const usage = emptyUsage();
  const commit = committer(id, usage, undelivered(s));

  if (s.kind === "practice") {
    const st = practiceState(s);
    const ctx = await agentCtx(id, s, settings, usage, signal, "practitioner", "message");
    const out = await runPractitioner(ctx, await contextFor(s, settings, practiceInstruction(st.active, st.awaitingNext)), st);
    commit((x) => applyPractitioner(x, out, ctx.fileViews));
    return false;
  }

  if (s.phase === "probing") {
    const ctx = await agentCtx(id, s, settings, usage, signal, "prober", "message");
    const out = await runProber(ctx, await contextFor(s, settings, PROBE_INSTRUCTION));
    let more = false;
    commit((x) => (more = applyProber(x, out, settings)));
    return more;
  }

  if (s.phase === "planning") {
    await replan(id, s, await agentCtx(id, s, settings, usage, signal, "planner", "intro", "Planning your path…"), settings, undefined);
    return true;
  }

  // teaching / complete: grade a pending free-recall answer first.
  const last = [...s.events].reverse().find((e) => e.type === "question");
  if (last?.type === "question" && last.answer && !last.grade && last.interaction.kind === "recall") {
    live.set(id, { agent: "grader", text: "", status: "Reading your answer…" });
    const g = await runGrader(
      { settings, usage, signal },
      last.interaction.question,
      last.interaction.committedAnswer,
      last.answer.dontKnow ? "(I don't know)" : (("text" in last.answer ? last.answer.text : "") ?? ""),
      last.answer.thinking?.reasoning,
      last.interaction.gradingNotes,
    );
    mutate(id, (x) => {
      const ev = x.events.find((e) => e.id === last.id);
      if (ev?.type === "question") ev.grade = g;
      x.usage.calls += usage.calls;
      x.usage.inputTokens += usage.inputTokens;
      x.usage.outputTokens += usage.outputTokens;
      x.usage.costUsd += usage.costUsd;
    });
    Object.assign(usage, emptyUsage());
    return true;
  }

  const ctx = await agentCtx(id, s, settings, usage, signal, "teacher", "message");
  const out = await runTeacher(ctx, await contextFor(s, settings, TEACH_INSTRUCTION), s.plan);
  let replanReason: string | undefined;
  commit((x) => (replanReason = applyTeacher(x, out, ctx.fileViews)));
  if (replanReason) {
    await replan(id, getSession(id)!, await agentCtx(id, s, settings, usage, signal, "planner", "intro", "Redrawing the lesson map…"), settings, replanReason);
    return true;
  }
  return false;
}

/** A background result arrived: let the current agent comment on it (or stay quiet)
 *  without disturbing an open question. Returns true if normal steps should follow. */
async function deliveryStep(id: string, settings: Settings, signal: AbortSignal): Promise<boolean> {
  const s = getSession(id)!;
  const seen = undelivered(s);
  if (!seen.size) return false;
  const usage = emptyUsage();
  const commit = committer(id, usage, seen);
  const instruction = DELIVERY_INSTRUCTION;

  if (s.kind === "practice") {
    const st = practiceState(s);
    const mode: DeliveryMode = st.active || pendingQuestion(s) ? "restricted" : "free";
    const ctx = await agentCtx(id, s, settings, usage, signal, "practitioner", "message");
    const out = await runPractitioner(ctx, await contextFor(s, settings, instruction), { ...st, delivery: mode });
    commit((x) => applyPractitioner(x, out, ctx.fileViews));
    return false;
  }
  const mode: DeliveryMode = pendingQuestion(s) ? "restricted" : "free";
  if (s.phase === "probing") {
    const ctx = await agentCtx(id, s, settings, usage, signal, "prober", "message");
    const out = await runProber(ctx, await contextFor(s, settings, instruction), { delivery: mode });
    let more = false;
    commit((x) => (more = applyProber(x, out, settings)));
    return more;
  }
  if (s.phase === "teaching" || s.phase === "complete") {
    const ctx = await agentCtx(id, s, settings, usage, signal, "teacher", "message");
    const out = await runTeacher(ctx, await contextFor(s, settings, instruction), s.plan, { delivery: mode });
    let replanReason: string | undefined;
    commit((x) => (replanReason = applyTeacher(x, out, ctx.fileViews)));
    if (replanReason) {
      await replan(id, getSession(id)!, await agentCtx(id, s, settings, usage, signal, "planner", "intro", "Redrawing the lesson map…"), settings, replanReason);
      return true;
    }
    return false;
  }
  mutate(id, (x) => markDelivered(x, seen));
  return false;
}

// ─── applying agent output ──────────────────────────────────────────────────

function pushMessage(x: Session, agent: AgentRole, text: string, figure?: FigureDraft, files?: FileView[]) {
  const fig = figure && files ? toFigure(figure, files) : undefined;
  if (text.trim() || fig) x.events.push(makeEvent({ type: "agent_message", agent, text: text.trim(), ...(fig ? { figure: fig } : {}) }));
}

function applyPractitioner(x: Session, out: PractitionerOutput, files?: FileView[]) {
  if (out.action === "none") return;
  applyTitle(x, out.title);
  pushMessage(x, "practitioner", out.message, out.figure, files);
  if (out.action === "pose") {
    x.events.push(makeEvent({ type: "problem", problem: { statement: out.statement!, solution: out.solution!, nodeIds: out.nodeIds }, status: "active" }));
  } else if (out.action === "conclude") {
    const p = activeProblem(x);
    if (p && p.type === "problem") {
      p.status = "concluded";
      p.outcome = out.outcome;
      p.verdict = out.verdict;
    }
  } else if (out.action === "ask") {
    x.events.push(makeEvent({ type: "question", agent: "practitioner", interaction: { kind: "ask", question: out.question! } }));
  }
}

/** Returns true when the probe finished (planning should follow). */
function applyProber(x: Session, out: ProberOutput, settings: Settings): boolean {
  if (out.action === "none") return false;
  applyTitle(x, out.title);
  pushMessage(x, "prober", out.message);
  if (out.research?.trim() && settings.workers.research) dispatchJob(x, { kind: "research", title: out.research.slice(0, 80), brief: out.research });
  if (out.action === "finish") {
    x.states = out.states!;
    x.events.push(makeEvent({ type: "states", states: out.states! }));
    x.phase = "planning";
    return true;
  }
  if (out.action !== "note") x.events.push(makeEvent({ type: "question", agent: "prober", interaction: toInteraction(out, "probe") }));
  return false;
}

/** Returns a replan reason when the teacher asked for a new map. */
function applyTeacher(x: Session, out: TeacherOutput, files?: FileView[]): string | undefined {
  if (out.action === "none") return undefined;
  pushMessage(x, "teacher", out.message, out.figure, files);
  for (const d of out.dispatch ?? []) dispatchJob(x, d);
  if (out.action === "check_choice" || out.action === "check_recall" || out.action === "ask") {
    x.events.push(makeEvent({ type: "question", agent: "teacher", interaction: toInteraction(out, out.role ?? "check") }));
    if (x.phase === "complete") x.phase = "teaching";
  } else if (out.action === "complete") {
    x.events.push(makeEvent({ type: "complete", summary: out.summary! }));
    x.phase = "complete";
  } else if (out.action === "replan") {
    return out.replanReason;
  }
  return undefined;
}

// ─── summarising long sessions ──────────────────────────────────────────────

/** Fold older history into a running summary once the verbatim transcript is long.
 *  The most recent stretch (about a third of the threshold) always stays verbatim. */
async function maybeCompact(id: string, settings: Settings, signal: AbortSignal) {
  const s = getSession(id)!;
  const from = s.compaction?.throughIndex ?? 0;
  const jobs = listJobs(id);
  const opts = { audience: "agent" as const, jobs, fileName: (fid: string) => getFile(fid)?.name };
  const tail = renderTranscript(s, { ...opts, fromIndex: from });
  if (tail.length < settings.compactionThresholdChars) return;
  const keep = settings.compactionThresholdChars * 0.35;
  let acc = 0;
  let cut = from;
  for (let i = s.events.length - 1; i > from; i--) {
    acc += (renderEvent(s.events[i], opts)?.length ?? 0) + 2;
    if (acc > keep) {
      cut = i + 1;
      break;
    }
  }
  cut = Math.min(cut, s.events.length - 6);
  if (cut <= from) return;
  const chunk = s.events
    .slice(from, cut)
    .map((e) => renderEvent(e, opts))
    .filter((x): x is string => !!x)
    .join("\n\n");
  const usage = emptyUsage();
  live.set(id, { agent: "summarizer", text: "", status: "Condensing earlier parts of the lesson…" });
  try {
    const summary = await runSummarizer({ settings, usage, signal }, s.compaction?.summary, chunk);
    mutate(id, (x) => {
      x.compaction = { throughIndex: cut, summary, at: now(), count: (x.compaction?.count ?? 0) + 1 };
      x.usage.calls += usage.calls;
      x.usage.inputTokens += usage.inputTokens;
      x.usage.outputTokens += usage.outputTokens;
      x.usage.costUsd += usage.costUsd;
    });
  } catch (err) {
    if (signal.aborted) throw err;
    // The length guard in buildContext still applies; the lesson can continue.
    console.warn(`[sapien] summarising ${id} failed:`, err instanceof Error ? err.message : err);
  } finally {
    live.delete(id);
  }
}

/** Replace the provisional title (the raw topic) once with the agent's short title. */
function applyTitle(s: Session, title: string | undefined) {
  const t = title?.trim().replace(/^["']|["']$/g, "");
  if (!t || s.titleSet) return;
  s.title = t.slice(0, 60);
  s.titleSet = true;
}

async function replan(id: string, s: Session, ctx: Ctx, settings: Settings, reason: string | undefined) {
  const instruction = reason
    ? `The teacher asked for a new plan. Reason: ${reason}\nRedraw the map from the learner's CURRENT understanding (as shown in the transcript) to the goal, keeping ids of nodes that still apply.`
    : "Plan the lesson from the probe summary above.";
  const out = await runPlanner(ctx, await contextFor(s, settings, instruction));
  mutate(id, (x) => {
    const version = (x.plan?.version ?? 0) + 1;
    const plan = {
      nodes: out.nodes.map((n) => ({ id: n.id, title: n.title, summary: n.summary })),
      edges: out.edges,
      version,
    };
    x.plan = plan;
    x.events.push(makeEvent({ type: "plan", plan, reason }));
    if (out.intro.trim()) x.events.push(makeEvent({ type: "agent_message", agent: "planner", text: out.intro.trim() }));
    x.phase = "teaching";
    const u = ctx.usage!;
    x.usage.calls += u.calls;
    x.usage.inputTokens += u.inputTokens;
    x.usage.outputTokens += u.outputTokens;
    x.usage.costUsd += u.costUsd;
  });
  Object.assign(ctx.usage!, emptyUsage());
  live.delete(id);
}

function toInteraction(
  o: { action: string; question?: string; options?: string[]; correct?: number[]; explanation?: string; optionNotes?: string[]; committedAnswer?: string; gradingNotes?: string; nodeId?: string },
  role: "probe" | "predict" | "check",
): Interaction {
  if (o.action === "ask") return { kind: "ask", question: o.question!, options: o.options };
  if (o.action.endsWith("_choice"))
  {
    const correct = [...new Set(o.correct!)];
    return { kind: "choice", role, nodeId: o.nodeId, question: o.question!, options: o.options!, correct, multi: correct.length > 1, explanation: o.explanation, optionNotes: o.optionNotes };
  }
  // Safety net: grading criteria written into the model answer move to the grader-only notes.
  const { answer, notes } = splitRubric(o.committedAnswer!);
  const gradingNotes = [o.gradingNotes?.trim(), notes].filter(Boolean).join(" ") || undefined;
  return { kind: "recall", role, nodeId: o.nodeId, question: o.question!, committedAnswer: answer || o.committedAnswer!, gradingNotes };
}

// ─── context assembly ───────────────────────────────────────────────────────

const PROBE_INSTRUCTION =
  "Decide your next move as the prober: one probing question (or an ungraded clarifying question), or finish with both knowledge states.";
const TEACH_INSTRUCTION =
  "Decide your next move as the teacher. If the plan was just made, open the lesson with the first step. Otherwise respond to the learner's latest answer or message, then continue with the next single step and its check.";
function practiceInstruction(active: boolean, awaitingNext: boolean) {
  if (active) return "A problem is active. Respond to the learner's latest attempt or message: feedback (with a hint if needed), reply, or conclude.";
  if (awaitingNext)
    return "The last problem is concluded and the learner has not asked for the next one. If they wrote something, answer it with action reply. Do not pose a new problem yet.";
  return "Pose the next practice problem, adapted to everything you have seen so far.";
}

const DELIVERY_INSTRUCTION =
  "A background result marked [NEW] has just arrived. You were called only for that. If it adds something the learner should notice now (or corrects something said earlier), use action note with one to three sentences. Otherwise use action none.";

const TRANSCRIPT_LIMIT = 250_000;

/** Context with graph knowledge found by meaning (falls back to word matching). */
export async function contextFor(s: Session, settings: Settings, instruction: string): Promise<string> {
  let related: Proposition[] | undefined;
  if (settings.graphEnabled) {
    const graph = getGraph();
    related = await relatedProps(graph, `${s.topic} ${s.states?.goal ?? ""}`, 15, settings.graphSemantic);
  }
  return buildContext(s, settings, instruction, related);
}

export function buildContext(s: Session, settings: Settings, instruction: string, relatedOverride?: Proposition[]): string {
  const jobs = listJobs(s.id);
  const parts: string[] = [sessionTopicHeader(s)];
  if (s.states) parts.push(`KNOWLEDGE STATES (from the probe)\nCurrent: ${s.states.current}\nGoal: ${s.states.goal}`);
  if (s.plan) {
    const st = planStatus(s.events);
    parts.push(
      `CURRENT PLAN (v${s.plan.version})\n` +
        s.plan.nodes
          .map((n) => `- ${n.id}${st.current === n.id ? " [CURRENT]" : st.visited.has(n.id) ? " [visited]" : ""}: ${n.title} — ${n.summary ?? ""}`)
          .join("\n") +
        `\nPrerequisite edges: ${s.plan.edges.map((e) => `${e.from}→${e.to}`).join(", ") || "none"}`,
    );
  }
  if (settings.graphEnabled) {
    const graph = getGraph();
    const seeds = (s.seedNodeIds ?? []).map((id) => graph.propositions.find((p) => p.id === id)).filter((p) => !!p);
    const related = (relatedOverride ?? searchGraph(graph, `${s.topic} ${s.states?.goal ?? ""}`, 15)).filter((p) => !seeds.some((x) => x.id === p.id));
    if (seeds.length)
      parts.push(
        `PRACTICE MATERIAL (chosen by the learner from their knowledge graph)\n${seeds.map((p) => `- [${p.id}] ${p.name}: ${p.statement}`).join("\n")}`,
      );
    if (related.length)
      parts.push(
        `FROM THE LEARNER'S KNOWLEDGE GRAPH (taught in earlier sessions or imported notes; claims they have met before, not proof they hold them)\n${related.map((p) => `- [${p.id}] ${p.name}: ${p.statement}`).join("\n")}`,
      );
  }
  const files = (s.attachments ?? []).map(getFile).filter((f) => !!f);
  if (files.length) {
    const { omitted } = fileBlocks(s.attachments ?? []);
    parts.push(
      `LEARNER FILES (attached above, in this order)\n${files.map((f, i) => `${i + 1}. ${f.name} (${f.kind}${f.pages ? `, ~${f.pages} pages` : ""})`).join("\n")}` +
        (omitted.length ? `\nNot sent with this request (too large to send together): ${omitted.join(", ")}. Ask the learner to say which file matters if you need it.` : ""),
    );
  }
  const base = s.compaction?.throughIndex ?? 0;
  if (s.compaction) parts.push(`SUMMARY OF THE EARLIER SESSION (the events before the transcript below, condensed)\n${s.compaction.summary}`);
  const opts = { audience: "agent" as const, jobs, markUndelivered: true, fileName: (fid: string) => getFile(fid)?.name };
  let from = base;
  let transcript = renderTranscript(s, { ...opts, fromIndex: from });
  while (transcript.length > TRANSCRIPT_LIMIT && from < s.events.length - 10) {
    from += Math.ceil((s.events.length - from) / 10);
    transcript = `[${from - base} earlier events omitted for length]\n\n` + renderTranscript(s, { ...opts, fromIndex: from });
  }
  parts.push(`TRANSCRIPT${s.compaction ? " (continuing after the summary)" : ""}\n${transcript}`);
  const side = pendingSideNotes(s);
  if (side) parts.push(side);
  parts.push(`YOUR TASK NOW\n${instruction}`);
  return parts.join("\n\n=====\n\n");
}

// ─── background jobs ────────────────────────────────────────────────────────

function dispatchJob(s: Session, d: Dispatch) {
  const job: Job = {
    id: newId(),
    sessionId: s.id,
    kind: d.kind as JobKind,
    title: d.title.slice(0, 120),
    brief: d.brief,
    status: "running",
    createdAt: now(),
  };
  saveJob(job);
  s.events.push(makeEvent({ type: "job", jobId: job.id, kind: job.kind, title: job.title }));
  // Run after the current mutate() has saved the dispatch event.
  setTimeout(() => void executeJob(job.id), 0);
}

const jobsInFlight = ((globalThis as unknown as { __sapienJobs?: Map<string, AbortController> }).__sapienJobs ??= new Map());

export function abortJob(jobId: string) {
  jobsInFlight.get(jobId)?.abort();
}

async function executeJob(jobId: string) {
  if (jobsInFlight.has(jobId)) return;
  const controller = new AbortController();
  jobsInFlight.set(jobId, controller);
  const settings = getSettings();
  const usage = emptyUsage();
  try {
    const job = getJob(jobId);
    const s = job && getSession(job.sessionId);
    if (!job || !s) return;
    try {
      const result = await withWorkerSlot(settings.workerConcurrency, () =>
        controller.signal.aborted ? Promise.reject(new Error("Stopped.")) : runWorker({ settings, usage, signal: controller.signal }, job.kind, job.title, job.brief, s.topic),
      );
      saveJob({ ...job, status: "done", result, finishedAt: now() });
    } catch (err) {
      const error = controller.signal.aborted ? "Stopped by the learner." : err instanceof Error ? err.message : String(err);
      saveJob({ ...job, status: "failed", error, finishedAt: now() });
    }
    if (!getSession(job.sessionId)) return; // deleted meanwhile
    mutate(job.sessionId, (x) => {
      x.events.push(makeEvent({ type: "job_result", jobId, delivered: false }));
      x.usage.calls += usage.calls;
      x.usage.inputTokens += usage.inputTokens;
      x.usage.outputTokens += usage.outputTokens;
      x.usage.costUsd += usage.costUsd;
    });
    setTimeout(() => maybeDeliver(job.sessionId), 0);
  } finally {
    jobsInFlight.delete(jobId);
  }
}

// ─── side questions ─────────────────────────────────────────────────────────

export async function askSide(id: string, question: string): Promise<Session> {
  const q = question.trim();
  if (!q) throw new InputError("Question is empty.");
  const settings = getSettings();
  const s = mutate(id, (x) => x.side.push({ id: newId(), at: now(), from: "learner", text: q }));
  const usage = emptyUsage();
  const recent = renderTranscript(s, { audience: "helper", jobs: listJobs(id), fromIndex: s.compaction?.throughIndex ?? 0, fileName: (fid) => getFile(fid)?.name }).slice(-120_000);
  const lesson = s.compaction ? `[Summary of the earlier lesson]\n${s.compaction.summary}\n\n[Recent lesson]\n${recent}` : recent;
  const { blocks } = await filesFor(s.attachments ?? [], settings);
  const thread = s.side
    .slice(0, -1)
    .slice(-20)
    .map((m) => `${m.from === "learner" ? "Learner" : "Helper"}: ${m.text}`)
    .join("\n");
  try {
    const out = await runHelper({ settings, usage, files: blocks.length ? blocks : undefined }, lesson, thread, q);
    return mutate(id, (x) => {
      x.side.push({ id: newId(), at: now(), from: "helper", text: out.answer });
      x.usage.calls += usage.calls;
      x.usage.inputTokens += usage.inputTokens;
      x.usage.outputTokens += usage.outputTokens;
      x.usage.costUsd += usage.costUsd;
    });
  } catch (err) {
    return mutate(id, (x) =>
      x.side.push({ id: newId(), at: now(), from: "helper", text: `⚠️ ${err instanceof Error ? err.message : String(err)}` }),
    );
  }
}

/** Clean up dictated text with the scribe. Context comes from the session in the
 *  helper's view, so open answer keys can never leak into (or "correct") what the
 *  learner said. Returns the raw text unchanged when clean-up is off. */
export async function cleanDictation(text: string, sessionId?: string, topic?: string): Promise<{ text: string; cleaned: boolean }> {
  const raw = text.trim();
  if (!raw) throw new InputError("Nothing to clean up.");
  if (raw.length > 8000) throw new InputError("Dictation is too long to clean up at once.");
  const settings = getSettings();
  if (!settings.dictationCleanup) return { text: raw, cleaned: false };
  const s = sessionId ? getSession(sessionId) : null;
  const parts: string[] = [];
  if (s) {
    parts.push(`Topic: ${s.title}${s.topic && s.topic !== s.title ? ` (${s.topic})` : ""}`);
    if (s.plan) parts.push(`Lesson map: ${s.plan.nodes.map((n) => n.title).join("; ")}`);
    const recent = renderTranscript(s, { audience: "helper", fromIndex: Math.max(0, s.events.length - 4), fileName: (fid) => getFile(fid)?.name });
    if (recent) parts.push(`Most recent part of the lesson:\n${recent.slice(-2500)}`);
  } else if (topic?.trim()) parts.push(`The learner is starting a lesson. What they typed so far: ${topic.trim().slice(0, 300)}`);
  const usage = emptyUsage();
  const out = await runScribe({ settings, usage }, raw, parts.join("\n\n"));
  if (s)
    mutate(s.id, (x) => {
      x.usage.calls += usage.calls;
      x.usage.inputTokens += usage.inputTokens;
      x.usage.outputTokens += usage.outputTokens;
      x.usage.costUsd += usage.costUsd;
    });
  return { text: out, cleaned: true };
}

export type { AgentRole };
