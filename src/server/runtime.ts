import { z } from "zod";
import { heal } from "../core/heal";
import type { AgentRole, ModelAlias, Settings, Usage } from "../core/types";
import { type Engine, EngineError } from "./engine";
import { engineFor as providerEngine, modelFor } from "./providers";
import type { ContentBlock } from "./files";

const g = globalThis as unknown as { __sapienEngine?: Engine | null };

/** Tests (and alternative providers) can replace the engine. */
export function setEngine(engine: Engine | null) {
  g.__sapienEngine = engine;
}

function engineOf(settings: Settings): Engine {
  return g.__sapienEngine ?? providerEngine(settings);
}

export interface AgentCall<T> {
  role: AgentRole;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  settings: Settings;
  /** Semantic checks beyond the schema; returned strings are fed back to the model. */
  check?: (value: T) => string[];
  tools?: string[];
  usage?: Usage;
  signal?: AbortSignal;
  timeoutMs?: number;
  files?: ContentBlock[];
  onPartial?: (partialJson: string) => void;
}

export function addUsage(into: Usage | undefined, u: { inputTokens: number; outputTokens: number; costUsd: number }) {
  if (!into) return;
  into.calls += 1;
  into.inputTokens += u.inputTokens;
  into.outputTokens += u.outputTokens;
  into.costUsd += u.costUsd;
}

/** On the wire every property is required; optional ones become nullable. Models
 *  reliably skip optional fields they should have filled (e.g. the correct option of
 *  a quiz); a required-but-nullable field forces a decision. Nulls are stripped by
 *  heal() before validation, so the zod schemas keep their optional semantics. */
export function requireAll(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(requireAll);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = requireAll(v);
  const props = out.properties as Record<string, unknown> | undefined;
  if (out.type === "object" && props) {
    const required = new Set((out.required as string[] | undefined) ?? []);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) props[key] = { anyOf: [props[key], { type: "null" }] };
    }
    out.required = Object.keys(props);
  }
  return out;
}

const jsonSchemaCache = new WeakMap<z.ZodType, object>();
export function jsonSchemaOf(schema: z.ZodType): object {
  let js = jsonSchemaCache.get(schema);
  if (!js) {
    const raw = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
    delete raw.$schema;
    js = requireAll(raw) as object;
    jsonSchemaCache.set(schema, js);
  }
  return js;
}

/** Next models to try when one declines a request; strongest first. */
const FALLBACK: Record<ModelAlias, ModelAlias[]> = {
  fable: ["opus", "sonnet", "haiku"],
  opus: ["sonnet", "haiku"],
  sonnet: ["opus", "haiku"],
  haiku: ["sonnet"],
};

/** The models to try for a role, in order: the configured one, then fallbacks for refusals.
 *  Claude Code has a built-in alias chain; other CLIs use their configured fallback list. */
export function modelChain(settings: Settings, role: AgentRole): (string | undefined)[] {
  if (settings.provider === "claude") {
    const first = settings.models[role];
    return [first, ...(FALLBACK[first] ?? [])];
  }
  const cfg = settings.providers[settings.provider];
  const extra = (cfg?.fallbackModels ?? []).map((m) => m.trim()).filter(Boolean);
  const first = modelFor(settings, role);
  return [first, ...extra.filter((m) => m !== first)];
}

/** Run one agent step. If the model's safety filter declines it (often a false positive),
 *  retry the same step on the next model in the chain, then once on the fallback provider. */
export async function runAgent<T>(call: AgentCall<T>): Promise<T> {
  const chain = modelChain(call.settings, call.role);
  for (let i = 0; i < chain.length; i++) {
    try {
      return await runAgentOnce(call, chain[i]);
    } catch (err) {
      if (!(err instanceof EngineError) || err.kind !== "refusal" || call.signal?.aborted) throw err;
      if (i < chain.length - 1) {
        if (process.env.NODE_ENV !== "test") console.warn(`[sapien] ${call.role}: ${chain[i] ?? "default model"} declined the request; retrying with ${chain[i + 1] ?? "default model"}`);
        continue;
      }
      const alt = call.settings.fallbackProvider;
      if (alt && alt !== call.settings.provider) {
        if (process.env.NODE_ENV !== "test") console.warn(`[sapien] ${call.role}: ${call.settings.provider} declined; trying fallback provider ${alt}`);
        return runAgent({ ...call, settings: { ...call.settings, provider: alt, fallbackProvider: "" } });
      }
      const tried = chain.map((m) => m ?? "default model").join(", ");
      throw new EngineError(
        `The model's safety filter declined this ${call.role} step (${tried}). This is usually a false positive. Press Retry, add fallback models or a fallback provider in Settings, or choose a different model for this session.`,
        "refusal",
      );
    }
  }
  throw new EngineError("unreachable");
}

/** One model, with one corrective retry on invalid output. */
async function runAgentOnce<T>(call: AgentCall<T>, model: string | undefined): Promise<T> {
  const engine = engineOf(call.settings);
  const schema = jsonSchemaOf(call.schema);
  let prompt = call.prompt;
  let lastProblems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await engine({
      model,
      effort: call.settings.effort[call.role],
      system: call.system,
      prompt,
      schema,
      tools: call.tools,
      signal: call.signal,
      timeoutMs: call.timeoutMs,
      files: call.files,
      onPartial: call.onPartial,
    });
    addUsage(call.usage, result.usage);
    const parsed = call.schema.safeParse(heal(result.output));
    lastProblems = parsed.success
      ? (call.check?.(parsed.data) ?? [])
      : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    if (parsed.success && lastProblems.length === 0) return parsed.data;
    if (process.env.NODE_ENV !== "test") console.warn(`[sapien] ${call.role} output rejected (attempt ${attempt + 1}): ${lastProblems.join("; ")}`);
    prompt =
      `${call.prompt}\n\n---\nYOUR PREVIOUS RESPONSE WAS REJECTED. Fix these problems and respond again:\n` +
      lastProblems.map((p) => `- ${p}`).join("\n") +
      `\nPrevious response: ${JSON.stringify(result.output).slice(0, 4000)}`;
  }
  throw new EngineError(`The ${call.role} produced invalid output twice: ${lastProblems.join("; ")}`);
}
