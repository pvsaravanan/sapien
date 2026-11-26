import { z } from "zod";
import { figureProblems, MAX_MARKS, type FigureDraft, type FileView } from "../core/figure";
import { candidatesFor, type Findings, type IdentityLinks } from "../core/graph";
import { planProblems } from "../core/plan";
import { sanitizeSvg } from "../core/sanitize";
import type { DemoResult, Graph, JobKind, Plan, Proposition, ResearchResult, Session, Settings, Usage, VisualResult } from "../core/types";
import type { ContentBlock } from "../server/files";
import { runAgent } from "../server/runtime";
import { gatherSources } from "../server/research";
import { PROVIDERS } from "../core/provider-info";
import * as P from "./prompts";

export interface Ctx {
  settings: Settings;
  usage?: Usage;
  signal?: AbortSignal;
  /** Learner files, sent ahead of the prompt as content blocks. */
  files?: ContentBlock[];
  /** What the agent can see of each learner file (index = LEARNER FILE number - 1). */
  fileViews?: FileView[];
  /** Streaming JSON of the answer as it is written. */
  onPartial?: (partialJson: string) => void;
}

const optionList = z.array(z.string().min(1)).min(2).max(6);
const explanationField = z
  .string()
  .optional()
  .describe("Multiple choice only, shown after answering: the core reasoning for the correct answer (Markdown, short; see EXPLAINING ANSWERS)");
const committedAnswerField = z
  .string()
  .optional()
  .describe("Free recall only: the model answer, shown to the learner after grading. Formatted Markdown written to them (see MODEL ANSWERS); no grading criteria");
const gradingNotesField = z
  .string()
  .optional()
  .describe("Free recall only, for the grader (never shown): what must be present for correct, what makes it partial, what wording does not matter");
const optionNotesField = z
  .array(z.string())
  .optional()
  .describe("Multiple choice only: one short sentence per option, same order as options. Correct option: why it is right. Wrong option: the mistake that leads to it");
const dispatchItem = z.object({
  kind: z.enum(["research", "visual", "demo"]),
  title: z.string().min(1).describe("Short card title"),
  brief: z.string().min(1).describe("Everything the worker needs; it sees nothing else of the lesson"),
});
export type Dispatch = z.infer<typeof dispatchItem>;

const unit = z.number().describe("Fraction 0–1 of the full page/image (0 = left/top edge, 1 = right/bottom edge)");
const figureSchema = z
  .object({
    file: z.number().int().describe("LEARNER FILE number of an image or PDF"),
    page: z.number().int().optional().describe("PDF page, 1-based (required for PDFs)"),
    crop: z
      .object({ x: unit, y: unit, w: unit, h: unit })
      .optional()
      .describe("Region to show (left, top, width, height), with some margin; null shows the whole page/image"),
    marks: z
      .array(
        z.object({
          kind: z.enum(["arrow", "box", "circle", "label"]),
          x: unit.describe("arrow: tail x · box/circle: left · label: centre x"),
          y: unit.describe("arrow: tail y · box/circle: top · label: centre y"),
          x2: unit.optional().describe("arrow only: head x (the point it points at)"),
          y2: unit.optional().describe("arrow only: head y"),
          w: unit.optional().describe("box/circle only: width"),
          h: unit.optional().describe("box/circle only: height"),
          text: z.string().optional().describe("A few words; required for label"),
        }),
      )
      .max(MAX_MARKS),
    caption: z.string().optional().describe("One sentence: what to look at"),
  })
  .optional()
  .describe("Show part of the learner's own image or PDF page, with marks drawn on it");

const checkFigure = (ctx: Ctx, f: FigureDraft | undefined) => (f ? figureProblems(f, ctx.fileViews ?? []) : []);

/** "note"/"none" exist only for delivery turns (a background result just arrived). */
export type DeliveryMode = "restricted" | "free" | undefined;

/** restricted: a question is still open, so only note/none may be used.
 *  free: nothing is pending; any action, plus note/none. */
function deliveryProblems(action: string, message: string, delivery: DeliveryMode): string[] | null {
  if (action === "note" || action === "none") {
    if (!delivery) return ['"note" and "none" are only available when a background result has just arrived. Choose another action.'];
    if (action === "note" && !message.trim()) return ["note needs a message."];
    return [];
  }
  if (delivery === "restricted") return ['The learner is still answering your open question. Use "note" (brief comment on the new result) or "none".'];
  return null;
}

/** Shared checks for a graded question payload. */
function questionProblems(
  kind: "choice" | "recall",
  v: { question?: string; options?: string[]; correct?: number[]; committedAnswer?: string; explanation?: string; optionNotes?: string[] },
): string[] {
  const out: string[] = [];
  if (!v.question?.trim()) out.push("question is required.");
  if (kind === "choice") {
    if (!v.options || v.options.length < 2) out.push("options needs 2–6 entries.");
    if (!v.correct?.length) out.push("correct needs at least one zero-based option index.");
    for (const c of v.correct ?? []) if (!v.options || c < 0 || c >= v.options.length) out.push(`correct index ${c} is out of range.`);
    if (v.options && new Set(v.options.map((o) => o.trim().toLowerCase())).size !== v.options.length) out.push("options must be distinct.");
    if (v.options?.some((o) => /^i don'?t know$/i.test(o.trim()))) out.push(`do not add an "I don't know" option; it is automatic.`);
    if (!v.explanation?.trim()) out.push("explanation is required for multiple choice.");
    if (!v.optionNotes || v.optionNotes.length !== v.options?.length || v.optionNotes.some((n) => !n.trim()))
      out.push(`optionNotes needs exactly one non-empty note per option (${v.options?.length ?? 0}), in the same order as options.`);
  } else if (!v.committedAnswer?.trim()) out.push("committedAnswer is required for a free-recall question.");
  return out;
}

// ─── prober ─────────────────────────────────────────────────────────────────

const proberSchema = z.object({
  message: z.string().describe("Markdown shown to the learner before any question. May be empty."),
  action: z.enum(["probe_choice", "probe_recall", "ask", "finish", "note", "none"]),
  question: z.string().optional(),
  options: optionList.optional(),
  correct: z.array(z.number().int()).optional().describe("Zero-based indexes of the correct options"),
  explanation: explanationField,
  optionNotes: optionNotesField,
  committedAnswer: committedAnswerField,
  gradingNotes: gradingNotesField,
  states: z
    .object({
      current: z.string(),
      goal: z.string(),
      currentBrief: z.string().optional().describe("One sentence to the learner (second person, under 25 words): where they are starting from"),
      goalBrief: z.string().optional().describe("One sentence to the learner (second person, under 25 words): what will feel obvious at the end"),
    })
    .optional()
    .describe("Required when action is finish"),
  research: z.string().optional().describe("Optional research question to verify in the background"),
  title: z.string().optional().describe("First response only: a short title for this session, 1–4 words, e.g. 'Gradient descent'"),
});
export type ProberOutput = z.infer<typeof proberSchema>;

export function runProber(ctx: Ctx, prompt: string, opts: { delivery?: DeliveryMode } = {}) {
  return runAgent({
    role: "prober",
    system: P.PROBER,
    prompt,
    schema: proberSchema,
    ...ctx,
    check: (v) => {
      const d = deliveryProblems(v.action, v.message, opts.delivery);
      if (d) return d;
      if (v.action === "probe_choice") return questionProblems("choice", v);
      if (v.action === "probe_recall") return questionProblems("recall", v);
      if (v.action === "ask") return v.question?.trim() ? [] : ["question is required for ask."];
      return v.states?.current.trim() && v.states.goal.trim() ? [] : ["states.current and states.goal are required to finish."];
    },
  });
}

// ─── planner ────────────────────────────────────────────────────────────────

const plannerSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), title: z.string(), summary: z.string() })).min(1),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
  intro: z.string(),
});

export function runPlanner(ctx: Ctx, prompt: string) {
  return runAgent({
    role: "planner",
    system: P.PLANNER,
    prompt,
    schema: plannerSchema,
    ...ctx,
    check: (v) => planProblems(v.nodes, v.edges),
  });
}

// ─── teacher ────────────────────────────────────────────────────────────────

const teacherSchema = z.object({
  message: z.string().describe("The teaching step (Markdown). May be empty only for a pure follow-up question."),
  action: z.enum(["check_choice", "check_recall", "ask", "replan", "complete", "note", "none"]),
  role: z.enum(["predict", "check"]).optional(),
  nodeId: z.string().optional().describe("Exact plan node id this check belongs to"),
  question: z.string().optional(),
  options: optionList.optional(),
  correct: z.array(z.number().int()).optional(),
  explanation: explanationField,
  optionNotes: optionNotesField,
  committedAnswer: committedAnswerField,
  gradingNotes: gradingNotesField,
  replanReason: z.string().optional().describe("For replan: your brief to the planner (not shown to the learner)"),
  summary: z
    .string()
    .optional()
    .describe("For complete. Shown to the learner: 3–6 Markdown bullets in the second person (see FINISHING)"),
  figure: figureSchema,
  dispatch: z.array(dispatchItem).max(3).optional(),
});
export type TeacherOutput = z.infer<typeof teacherSchema>;

export function runTeacher(ctx: Ctx, prompt: string, plan: Plan | undefined, opts: { delivery?: DeliveryMode } = {}) {
  const mode = ctx.settings.quizMode;
  return runAgent({
    role: "teacher",
    system: P.teacherPrompt(mode),
    prompt,
    schema: teacherSchema,
    ...ctx,
    check: (v) => {
      const d = deliveryProblems(v.action, v.message, opts.delivery);
      if (d) return d;
      const out: string[] = [];
      if (v.action === "check_choice" || v.action === "check_recall") {
        out.push(...questionProblems(v.action === "check_choice" ? "choice" : "recall", v));
        if (!v.role) out.push('role ("predict" or "check") is required.');
        if (!v.nodeId || !plan?.nodes.some((n) => n.id === v.nodeId))
          out.push(`nodeId must be one of: ${plan?.nodes.map((n) => n.id).join(", ") ?? "(no plan)"}.`);
        if (mode === "choice" && v.action === "check_recall") out.push("Free-recall checks are disabled; use check_choice.");
        if (mode === "recall" && v.action === "check_choice") out.push("Multiple-choice checks are disabled; use check_recall.");
      }
      if (v.action === "ask" && !v.question?.trim()) out.push("question is required for ask.");
      if (v.action === "replan" && !v.replanReason?.trim()) out.push("replanReason is required.");
      if (v.action === "complete" && !v.summary?.trim()) out.push("summary is required to complete.");
      const enabled = ctx.settings.workers;
      for (const d of v.dispatch ?? []) if (!enabled[d.kind]) out.push(`The ${d.kind} worker is disabled; remove it from dispatch.`);
      out.push(...checkFigure(ctx, v.figure));
      return out;
    },
  });
}

// ─── grader ─────────────────────────────────────────────────────────────────

const graderSchema = z.object({
  verdict: z.enum(["correct", "partial", "incorrect"]),
  feedback: z.string(),
});

export function runGrader(ctx: Ctx, question: string, committedAnswer: string, answer: string, thinking?: string, gradingNotes?: string) {
  return runAgent({
    role: "grader",
    system: P.GRADER,
    schema: graderSchema,
    ...ctx,
    prompt: `QUESTION:\n${question}\n\nCOMMITTED ANSWER:\n${committedAnswer}${gradingNotes?.trim() ? `\n\nGRADING NOTES (from the teacher, written before the learner answered):\n${gradingNotes}` : ""}\n\nLEARNER'S ANSWER:\n${answer}${
      thinking ? `\n\nLEARNER'S STATED THINKING:\n${thinking}` : ""
    }`,
  });
}

// ─── practitioner ───────────────────────────────────────────────────────────

const practitionerSchema = z.object({
  message: z.string().describe("Markdown to the learner: problem framing, feedback, hint, or wrap-up"),
  action: z.enum(["pose", "feedback", "conclude", "reply", "ask", "note", "none"]).describe("reply = plain answer to a learner message, no state change"),
  statement: z.string().optional().describe("The problem, for pose"),
  solution: z.string().optional().describe("Full worked solution, committed now, hidden until conclude"),
  nodeIds: z.array(z.string()).optional().describe("Graph proposition ids the problem exercises, if known"),
  outcome: z.enum(["solved", "solvedWithHints", "notSolved", "skipped"]).optional(),
  verdict: z.string().optional().describe("One-sentence diagnosis, for conclude"),
  question: z.string().optional().describe("For ask"),
  title: z.string().optional().describe("First response only: a short title for this practice session, 1–4 words"),
  figure: figureSchema,
});
export type PractitionerOutput = z.infer<typeof practitionerSchema>;

export function runPractitioner(ctx: Ctx, prompt: string, state: { active: boolean; awaitingNext: boolean; delivery?: DeliveryMode }) {
  return runAgent({
    role: "practitioner",
    system: P.PRACTITIONER,
    prompt,
    schema: practitionerSchema,
    ...ctx,
    check: (v) => {
      const d = deliveryProblems(v.action, v.message, state.delivery);
      if (d) return d;
      const out: string[] = [];
      if (v.action === "pose") {
        if (state.active) out.push("A problem is already active; give feedback or conclude it first.");
        if (state.awaitingNext) out.push("Wait for the learner to ask for the next problem; use feedback or ask instead.");
        if (!v.statement?.trim() || !v.solution?.trim()) out.push("pose needs statement and solution.");
      }
      if ((v.action === "feedback" || v.action === "conclude") && !state.active) out.push(`No problem is active; ${v.action} is not possible.`);
      if (v.action === "conclude" && (!v.outcome || !v.verdict?.trim())) out.push("conclude needs outcome and verdict.");
      if (v.action === "ask" && !v.question?.trim()) out.push("question is required for ask.");
      if ((v.action === "feedback" || v.action === "reply") && !v.message.trim()) out.push(`${v.action} needs a message.`);
      out.push(...checkFigure(ctx, v.figure));
      return out;
    },
  });
}

// ─── extraction pipeline agents ─────────────────────────────────────────────

const extractorSchema = z.object({
  propositions: z.array(
    z.object({ key: z.string(), name: z.string(), statement: z.string(), aliases: z.array(z.string()).optional() }),
  ),
  chains: z.array(z.object({ premises: z.array(z.string()).min(1), conclusion: z.string() })),
});

export function runExtractor(ctx: Ctx, text: string): Promise<Findings> {
  return runAgent({
    role: "extractor",
    system: P.EXTRACTOR,
    schema: extractorSchema,
    ...ctx,
    prompt: text.trim() ? `SOURCE TEXT:\n"""\n${text}\n"""` : "SOURCE: the learner file attached above. Extract the knowledge it asserts.",
    check: (v) => {
      const keys = new Set(v.propositions.map((p) => p.key));
      const out: string[] = [];
      if (keys.size !== v.propositions.length) out.push("Proposition keys must be unique.");
      for (const c of v.chains)
        for (const k of [...c.premises, c.conclusion]) if (!keys.has(k)) out.push(`Chain uses undefined key "${k}".`);
      return out;
    },
  });
}

const auditorSchema = z.object({
  links: z.array(z.object({ key: z.string(), existingId: z.string() })),
});

export async function runAuditor(
  ctx: Ctx,
  findings: Findings,
  graph: Graph,
  candidates: (f: Findings["propositions"][number], graph: Graph) => Promise<Proposition[]> | Proposition[] = (f, gr) => candidatesFor(f, gr),
): Promise<IdentityLinks> {
  const blocks: string[] = [];
  const allowed = new Map<string, Set<string>>();
  for (const f of findings.propositions) {
    const cands = await candidates(f, graph);
    if (!cands.length) continue;
    allowed.set(f.key, new Set(cands.map((c) => c.id)));
    blocks.push(
      `NEW ${f.key}: ${f.name} — ${f.statement}\n` + cands.map((c) => `  existing ${c.id}: ${c.name} — ${c.statement}`).join("\n"),
    );
  }
  if (!blocks.length) return {};
  const out = await runAgent({ role: "auditor", system: P.AUDITOR, schema: auditorSchema, ...ctx, prompt: blocks.join("\n\n") });
  const links: IdentityLinks = {};
  for (const l of out.links) if (allowed.get(l.key)?.has(l.existingId)) links[l.key] = l.existingId;
  return links;
}

// ─── background workers ─────────────────────────────────────────────────────

const researchSchema = z.object({
  answer: z.string(),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
});
const visualSchema = z.object({ svg: z.string(), caption: z.string() });
const demoSchema = z.object({ html: z.string(), instructions: z.string() });

export function runWorker(ctx: Ctx, kind: JobKind, title: string, brief: string, topic: string): Promise<ResearchResult | VisualResult | DemoResult> {
  const prompt = `LESSON TOPIC: ${topic}\nTITLE: ${title}\nBRIEF:\n${brief}`;
  const timeoutMs = 15 * 60_000;
  if (kind === "research") return runResearch(ctx, title, brief, prompt, timeoutMs);
  if (kind === "visual") {
    return runAgent({
      role: "visual",
      system: P.VISUAL_MAKER,
      schema: visualSchema,
      prompt,
      timeoutMs,
      ...ctx,
      check: (v) => (sanitizeSvg(v.svg) ? (v.svg.length > 300_000 ? ["SVG is too large; simplify."] : []) : ["svg must contain a complete <svg>…</svg> element."]),
    });
  }
  return runAgent({
    role: "demo",
    system: P.DEMO_MAKER,
    schema: demoSchema,
    prompt,
    timeoutMs,
    ...ctx,
    check: (v) => (v.html.length > 400_000 ? ["HTML is too large; simplify."] : /<script[^>]+src=/i.test(v.html) ? ["Do not load external scripts."] : []),
  });
}

/** Research uses the CLI's own live search where it has one (Claude Code, Gemini CLI);
 *  otherwise Sapien searches, fetches the pages, and the agent answers from them. */
async function runResearch(ctx: Ctx, title: string, brief: string, prompt: string, timeoutMs: number): Promise<ResearchResult> {
  const cfg = ctx.settings.research;
  const native = cfg.engine === "auto" && PROVIDERS[ctx.settings.provider].webSearch;
  if (cfg.engine === "off") return runAgent({ role: "research", system: P.RESEARCHER_OFFLINE, schema: researchSchema, prompt, timeoutMs, ...ctx });
  if (native) {
    // Claude Code needs its web tools granted; Gemini CLI's search is built in.
    const tools = ctx.settings.provider === "claude" ? ["WebSearch", "WebFetch"] : undefined;
    return runAgent({ role: "research", system: P.RESEARCHER, schema: researchSchema, tools, prompt, timeoutMs, ...ctx });
  }
  const { sources, backend, note } = await gatherSources(title, brief, cfg);
  const allowed = new Set(sources.map((s) => s.url));
  const block = sources.length
    ? sources.map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.text}`).join("\n\n---\n\n")
    : `(No sources were found${note ? `: ${note}` : ""}.)`;
  const out = await runAgent({
    role: "research",
    system: P.RESEARCHER_FROM_SOURCES,
    schema: researchSchema,
    prompt: `${prompt}\n\nSOURCES (searched with ${backend}${note ? `; ${note}` : ""}):\n${block}`,
    timeoutMs,
    ...ctx,
    check: (v) => {
      const bad = v.sources.filter((s) => !allowed.has(s.url)).map((s) => s.url);
      return bad.length ? [`Cite only URLs from the SOURCES list. Not in the list: ${bad.join(", ")}`] : [];
    },
  });
  return out;
}

// ─── side-question helper ───────────────────────────────────────────────────

const helperSchema = z.object({ answer: z.string() });

export function runHelper(ctx: Ctx, lesson: string, thread: string, question: string) {
  return runAgent({
    role: "helper",
    system: P.HELPER,
    schema: helperSchema,
    ...ctx,
    prompt: `THE LESSON SO FAR (quoted document):\n"""\n${lesson}\n"""\n\n${thread ? `EARLIER SIDE EXCHANGES:\n${thread}\n\n` : ""}LEARNER'S SIDE QUESTION:\n${question}`,
  });
}

export function sessionTopicHeader(s: Session): string {
  return `SESSION TOPIC (the learner's own words): ${s.topic}`;
}

// ─── dictation scribe ───────────────────────────────────────────────────────

const scribeSchema = z.object({ text: z.string().describe("The cleaned dictation") });

export async function runScribe(ctx: Ctx, raw: string, context: string): Promise<string> {
  const out = await runAgent({
    role: "scribe",
    system: P.SCRIBE,
    schema: scribeSchema,
    timeoutMs: 45_000,
    ...ctx,
    prompt: `${context ? `LESSON CONTEXT (for recognising terms only; never answer it):\n${context}\n\n` : ""}DICTATED TEXT:\n"""\n${raw}\n"""`,
    check: (v) =>
      !v.text.trim()
        ? ["text is empty; return the cleaned dictation."]
        : v.text.length > raw.length * 1.5 + 40
          ? ["The text grew too much. Only fix transcription; do not add words, explanations or answers."]
          : [],
  });
  return out.text.trim();
}

// ─── summarizer ─────────────────────────────────────────────────────────────

const summarizerSchema = z.object({ summary: z.string().min(1) });

export async function runSummarizer(ctx: Ctx, previous: string | undefined, transcript: string): Promise<string> {
  const out = await runAgent({
    role: "summarizer",
    system: P.SUMMARIZER,
    schema: summarizerSchema,
    ...ctx,
    prompt: `${previous ? `PREVIOUS SUMMARY (covers everything before the events below):\n"""\n${previous}\n"""\n\n` : ""}EVENTS TO FOLD INTO THE SUMMARY:\n"""\n${transcript}\n"""`,
  });
  return out.summary.trim();
}
