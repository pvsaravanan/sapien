// Sapien domain model. Pure types — no IO. Everything the server persists and
// the browser renders is described here.

export type SessionKind = "teach" | "practice";

/** Teaching sessions move probing → planning → teaching → complete.
 *  Practice sessions stay in "practice" until the learner ends them. */
export type Phase = "probing" | "planning" | "teaching" | "complete" | "practice";

export type AgentRole =
  | "prober"
  | "planner"
  | "teacher"
  | "grader"
  | "practitioner"
  | "extractor"
  | "auditor"
  | "research"
  | "visual"
  | "demo"
  | "helper"
  | "summarizer"
  | "scribe";

/** What the learner says about their own reasoning, attached to any answer.
 *  confidence: 0–100 (%). */
export interface Thinking {
  confidence?: number;
  reasoning?: string;
}

/** Why a graded question is being asked. */
export type QuestionRole = "probe" | "predict" | "check";

export interface ChoiceInteraction {
  kind: "choice";
  role: QuestionRole;
  nodeId?: string;
  question: string;
  options: string[];
  /** Zero-based indexes into `options`. More than one ⇒ multi-select. */
  correct: number[];
  /** More than one correct option (kept when the key is redacted). */
  multi?: boolean;
  /** The core reasoning behind the answer, shown after answering. */
  explanation?: string;
  /** One line per option (same order): why it is right, or the mistake that leads to it. */
  optionNotes?: string[];
}

export interface RecallInteraction {
  kind: "recall";
  role: QuestionRole;
  nodeId?: string;
  question: string;
  /** Full model answer committed before the learner sees the question; shown to the
   *  learner after grading as the "Model answer". */
  committedAnswer: string;
  /** What counts as correct, for the grader only. Never sent to the browser. */
  gradingNotes?: string;
}

/** Ungraded: preferences, goals, open-ended input. */
export interface AskInteraction {
  kind: "ask";
  question: string;
  options?: string[];
}

export type Interaction = ChoiceInteraction | RecallInteraction | AskInteraction;

export interface ChoiceAnswer {
  kind: "choice";
  selected: number[];
  dontKnow?: boolean;
  thinking?: Thinking;
}
export interface TextAnswer {
  kind: "recall" | "ask";
  text?: string;
  selected?: number[];
  dontKnow?: boolean;
  thinking?: Thinking;
}
export type Answer = ChoiceAnswer | TextAnswer;

export type Verdict = "correct" | "partial" | "incorrect" | "dontKnow";
export interface Grade {
  verdict: Verdict;
  feedback?: string;
}

export interface PlanNode {
  id: string;
  title: string;
  summary?: string;
}
export interface PlanEdge {
  /** Prerequisite. */
  from: string;
  /** Depends on `from`. */
  to: string;
}
export interface Plan {
  nodes: PlanNode[];
  edges: PlanEdge[];
  version: number;
}

export interface KnowledgeStates {
  /** What the learner already holds, and where it ends (detailed, for the agents). */
  current: string;
  /** The concrete target understanding (detailed, for the agents). */
  goal: string;
  /** One short sentence for the learner, in the second person. */
  currentBrief?: string;
  goalBrief?: string;
}

export type JobKind = "research" | "visual" | "demo";

export interface Problem {
  statement: string;
  /** Committed before posing; hidden from the learner until concluded. */
  solution: string;
  nodeIds?: string[];
}

export type ProblemOutcome = "solved" | "solvedWithHints" | "notSolved" | "skipped";

interface EventBase {
  id: string;
  at: string;
}

/** A mark drawn over a learner figure. Coordinates are fractions (0–1) of the full
 *  page or image: 0,0 top-left, 1,1 bottom-right.
 *  arrow: tail (x,y) → head (x2,y2), text at the tail. box/circle: region x,y,w,h.
 *  label: text centred at (x,y). */
export interface FigureMark {
  kind: "arrow" | "box" | "circle" | "label";
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  w?: number;
  h?: number;
  text?: string;
}

/** One of the learner's own images (or a PDF page), optionally cropped, with marks. */
export interface Figure {
  fileId: string;
  /** PDF page, 1-based. */
  page?: number;
  /** Region shown, as fractions of the full page/image. Missing = whole. */
  crop?: { x: number; y: number; w: number; h: number };
  marks: FigureMark[];
  caption?: string;
}

export type SessionEvent = EventBase &
  (
    | { type: "learner_message"; text: string; thinking?: Thinking; attachments?: string[] }
    | { type: "agent_message"; agent: AgentRole; text: string; figure?: Figure }
    | {
        type: "question";
        agent: AgentRole;
        interaction: Interaction;
        answer?: Answer;
        grade?: Grade;
        answeredAt?: string;
      }
    | { type: "states"; states: KnowledgeStates }
    | { type: "plan"; plan: Plan; reason?: string }
    | { type: "job"; jobId: string; kind: JobKind; title: string }
    | { type: "job_result"; jobId: string; delivered?: boolean }
    | {
        type: "problem";
        problem: Problem;
        status: "active" | "concluded";
        outcome?: ProblemOutcome;
        verdict?: string;
      }
    | { type: "attempt"; problemEventId: string; text: string; thinking?: Thinking; attachments?: string[] }
    | { type: "next_problem" }
    | { type: "complete"; summary: string }
    | { type: "error"; message: string }
  );

export type SessionEventType = SessionEvent["type"];

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** As reported by the CLI; subscription billing may differ. */
  costUsd: number;
}

export interface SideMessage {
  id: string;
  at: string;
  from: "learner" | "helper";
  text: string;
  /** Index into events at ask time — lets the teacher see when it was asked. */
  deliveredToAgent?: boolean;
}

export interface Session {
  id: string;
  kind: SessionKind;
  title: string;
  topic: string;
  createdAt: string;
  updatedAt: string;
  phase: Phase;
  states?: KnowledgeStates;
  plan?: Plan;
  events: SessionEvent[];
  usage: Usage;
  /** Number of events whose teacher prose has been folded into the graph. */
  extractedThrough: number;
  /** Graph node ids chosen as practice material. */
  seedNodeIds?: string[];
  side: SideMessage[];
  status: "idle" | "running";
  lastError?: string;
  /** Per-session override for the interactive agents (prober, planner, teacher, practitioner). */
  model?: ModelAlias;
  effort?: Effort;
  /** True once an agent (or the learner) has named the session. */
  titleSet?: boolean;
  /** Ids of files the learner attached (see Attachment). */
  attachments?: string[];
  /** Summary standing in for events[0, throughIndex) in agent context. */
  compaction?: Compaction;
}

export interface Compaction {
  throughIndex: number;
  summary: string;
  at: string;
  /** How many times the history has been summarised. */
  count: number;
}

export type AttachmentKind = "pdf" | "image" | "text";

/** A learner file stored under data/files/<id>/. Sent to agents as a content block. */
export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  createdAt: string;
  /** Rough page count for PDFs (best effort). */
  pages?: number;
}

export type JobStatus = "running" | "done" | "failed";

export interface ResearchResult {
  answer: string;
  sources: { title: string; url: string }[];
}
export interface VisualResult {
  svg: string;
  caption: string;
}
export interface DemoResult {
  html: string;
  instructions: string;
}

export interface Job {
  id: string;
  sessionId: string;
  kind: JobKind;
  title: string;
  /** The brief the dispatching agent wrote. */
  brief: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  result?: ResearchResult | VisualResult | DemoResult;
  error?: string;
}

// ─── knowledge graph ────────────────────────────────────────────────────────

export interface Provenance {
  /** Session id, or "notes:<sourceId>" for imported notes. */
  source: string;
  eventId?: string;
}

/** One objective claim. Not a measure of the learner. */
export interface Proposition {
  id: string;
  name: string;
  statement: string;
  aliases: string[];
  createdAt: string;
  provenance: Provenance[];
}

/** Premises that jointly entail a conclusion. */
export interface Chain {
  id: string;
  premises: string[];
  conclusion: string;
  createdAt: string;
  provenance: Provenance[];
}

export interface Graph {
  propositions: Proposition[];
  chains: Chain[];
}

export interface NotesSource {
  id: string;
  name: string;
  importedAt: string;
  chars: number;
}

// ─── settings ───────────────────────────────────────────────────────────────

export type ModelAlias = "opus" | "sonnet" | "haiku" | "fable";

/** Coding-agent CLIs Sapien can drive for inference. */
export type ProviderId = "claude" | "codex" | "gemini" | "copilot" | "opencode" | "commandcode";

export interface ProviderConfig {
  /** Executable (name on PATH, absolute path, or e.g. "gh copilot"). */
  path: string;
  /** Model per agent role; empty or missing = the CLI's own default. "default" applies to all roles. */
  models: Partial<Record<AgentRole | "default", string>>;
  /** Models to try, in order, when a request is declined by the model's safety filter. */
  fallbackModels?: string[];
  /** Node.js binary to run JavaScript CLIs with (auto-detected when empty). */
  node?: string;
}

export interface ResearchSettings {
  /** auto: the CLI's own web search where it has one, otherwise Sapien's search.
   *  sapien: always Sapien's search. off: answer from model knowledge only. */
  engine: "auto" | "sapien" | "off";
  /** Search backend for Sapien's search; Brave and Tavily need an API key. */
  search: "wikipedia" | "brave" | "tavily";
}
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Settings {
  /** Which CLI runs the agents. */
  provider: ProviderId;
  /** Per-provider executable and models (Claude uses claudePath/models below). */
  providers: Record<Exclude<ProviderId, "claude">, ProviderConfig>;
  claudePath: string;
  /** Provider to try once when the selected one declines a request ("" = none). */
  fallbackProvider: ProviderId | "";
  research: ResearchSettings;
  models: Record<AgentRole, ModelAlias>;
  effort: Partial<Record<AgentRole, Effort>>;
  /** Max concurrent background CLI processes (workers, extraction). */
  workerConcurrency: number;
  /** Auto-extract once this many characters of teacher prose are uncovered. */
  extractionThresholdChars: number;
  /** Summarise older history once the agent transcript exceeds this many characters. */
  compactionThresholdChars: number;
  graphEnabled: boolean;
  /** Find related claims by meaning (local embedding model) instead of shared words only. */
  graphSemantic: boolean;
  quizMode: "choice" | "recall" | "mixed";
  workers: Record<JobKind, boolean>;
  /** After dictation, have the scribe fix punctuation and misheard words. */
  dictationCleanup: boolean;
}
