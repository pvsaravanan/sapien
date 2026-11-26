import type { Effort, ModelAlias, Settings } from "../core/types";

/** Interactive agents get the strongest model; bookkeeping roles get cheaper ones.
 *  All are Claude Code CLI aliases, resolved by the CLI to current versions. */
export const DEFAULT_SETTINGS: Settings = {
  provider: "claude",
  providers: {
    codex: { path: "codex", models: {} },
    gemini: { path: "gemini", models: {} },
    copilot: { path: "copilot", models: {} },
    opencode: { path: "opencode", models: {} },
    commandcode: { path: "cmd", models: {} },
  },
  claudePath: process.env.SAPIEN_CLAUDE_PATH ?? "claude",
  fallbackProvider: "",
  research: { engine: "auto", search: "wikipedia" },
  models: {
    prober: "opus",
    planner: "opus",
    teacher: "opus",
    practitioner: "opus",
    grader: "sonnet",
    extractor: "sonnet",
    auditor: "sonnet",
    research: "sonnet",
    visual: "sonnet",
    demo: "sonnet",
    helper: "sonnet",
    summarizer: "sonnet",
    scribe: "haiku",
  },
  effort: {
    planner: "high",
    teacher: "medium",
    prober: "medium",
    practitioner: "medium",
    scribe: "low",
  },
  workerConcurrency: 4,
  extractionThresholdChars: 6000,
  compactionThresholdChars: 120_000,
  graphEnabled: true,
  graphSemantic: true,
  quizMode: "mixed",
  workers: { research: true, visual: true, demo: true },
  dictationCleanup: true,
};

export const MODELS: ModelAlias[] = ["opus", "sonnet", "haiku", "fable"];
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
