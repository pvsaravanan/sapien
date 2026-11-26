import { body, handle } from "@/src/server/http";
import { getSecrets, getSettings, saveSecrets, saveSettings } from "@/src/server/store";
import { DEFAULT_SETTINGS, MODELS, EFFORTS } from "@/src/server/defaults";
import { InputError } from "@/src/server/orchestrator";
import type { Settings } from "@/src/core/types";
import { PROVIDERS } from "@/src/server/providers";


export async function GET(req: Request) {
  return handle(req, () => {
    const keys = getSecrets();
    return { settings: getSettings(), defaults: DEFAULT_SETTINGS, secrets: { brave: !!keys.brave, tavily: !!keys.tavily } };
  });
}

export async function PUT(req: Request) {
  return handle(req, async () => {
    const b = await body<Partial<Settings> & { secrets?: { brave?: string | null; tavily?: string | null } }>(req);
    const cur = getSettings();
    const next: Settings = { ...cur };
    if (b.models) for (const [k, v] of Object.entries(b.models)) {
      if (!(k in cur.models) || !MODELS.includes(v as never)) throw new InputError(`Invalid model for ${k}`);
      (next.models as Record<string, string>)[k] = v;
    }
    if (b.effort) {
      next.effort = {};
      for (const [k, v] of Object.entries(b.effort)) {
        if (!(k in cur.models)) throw new InputError(`Unknown role ${k}`);
        if (v && !EFFORTS.includes(v as never)) throw new InputError(`Invalid effort for ${k}`);
        if (v) (next.effort as Record<string, string>)[k] = v;
      }
    }
    if (b.workerConcurrency !== undefined) {
      if (!Number.isInteger(b.workerConcurrency) || b.workerConcurrency < 1) throw new InputError("Concurrency must be a positive whole number.");
      next.workerConcurrency = b.workerConcurrency;
    }
    if (b.extractionThresholdChars !== undefined) {
      if (!Number.isInteger(b.extractionThresholdChars) || b.extractionThresholdChars < 500) throw new InputError("Threshold must be at least 500.");
      next.extractionThresholdChars = b.extractionThresholdChars;
    }
    if (b.compactionThresholdChars !== undefined) {
      if (!Number.isInteger(b.compactionThresholdChars) || b.compactionThresholdChars < 20000) throw new InputError("Summarising threshold must be at least 20,000 characters.");
      next.compactionThresholdChars = b.compactionThresholdChars;
    }
    if (b.graphEnabled !== undefined) next.graphEnabled = !!b.graphEnabled;
    if (b.graphSemantic !== undefined) next.graphSemantic = !!b.graphSemantic;
    if (b.dictationCleanup !== undefined) next.dictationCleanup = !!b.dictationCleanup;
    if (b.quizMode !== undefined) {
      if (!["choice", "recall", "mixed"].includes(b.quizMode)) throw new InputError("Invalid quiz mode.");
      next.quizMode = b.quizMode;
    }
    if (b.workers) next.workers = { research: !!b.workers.research, visual: !!b.workers.visual, demo: !!b.workers.demo };
    if (b.claudePath !== undefined) next.claudePath = String(b.claudePath).trim() || "claude";
    if (b.provider !== undefined) {
      if (!(b.provider in PROVIDERS)) throw new InputError("Unknown provider.");
      next.provider = b.provider;
    }
    if (b.providers) {
      const providers = { ...cur.providers };
      for (const [id, cfg] of Object.entries(b.providers)) {
        if (!(id in providers)) throw new InputError(`Unknown provider ${id}.`);
        const models: Record<string, string> = {};
        for (const [role, m] of Object.entries(cfg?.models ?? {})) {
          if (role !== "default" && !(role in cur.models)) throw new InputError(`Unknown role ${role}.`);
          const v = String(m ?? "").trim();
          if (v.length > 120 || /\s/.test(v)) throw new InputError(`Invalid model name for ${role}.`);
          if (v) models[role] = v;
        }
        const fallbackModels = (Array.isArray(cfg?.fallbackModels) ? cfg.fallbackModels : [])
          .map((m) => String(m).trim())
          .filter(Boolean)
          .slice(0, 6);
        if (fallbackModels.some((m) => m.length > 120 || /\s/.test(m))) throw new InputError("Invalid fallback model name.");
        providers[id as keyof typeof providers] = {
          path: String(cfg?.path ?? "").trim() || PROVIDERS[id as keyof typeof PROVIDERS].defaultPath,
          models,
          fallbackModels,
          node: String(cfg?.node ?? "").trim().slice(0, 500),
        };
      }
      next.providers = providers;
    }
    if (b.fallbackProvider !== undefined) {
      if (b.fallbackProvider && !(b.fallbackProvider in PROVIDERS)) throw new InputError("Unknown fallback provider.");
      next.fallbackProvider = b.fallbackProvider;
    }
    if (b.research) {
      const engine = b.research.engine ?? cur.research.engine;
      const search = b.research.search ?? cur.research.search;
      if (!["auto", "sapien", "off"].includes(engine)) throw new InputError("Invalid research engine.");
      if (!["wikipedia", "brave", "tavily"].includes(search)) throw new InputError("Invalid search backend.");
      next.research = { engine, search };
    }
    if (b.secrets) {
      // Write-only: an empty string or null clears a key; undefined leaves it unchanged.
      const keys = getSecrets();
      for (const k of ["brave", "tavily"] as const) {
        const v = b.secrets[k];
        if (v === undefined) continue;
        if (v === null || !String(v).trim()) delete keys[k];
        else if (String(v).length > 300) throw new InputError("API key is too long.");
        else keys[k] = String(v).trim();
      }
      saveSecrets(keys);
    }
    saveSettings(next);
    const keys = getSecrets();
    return { settings: next, secrets: { brave: !!keys.brave, tavily: !!keys.tavily } };
  });
}
