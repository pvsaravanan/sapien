import { z } from "zod";
import { body, handle } from "@/src/server/http";
import { InputError } from "@/src/server/orchestrator";
import { runAgent } from "@/src/server/runtime";
import { getSettings } from "@/src/server/store";
import { PROVIDERS } from "@/src/server/providers";
import type { ProviderId, Usage } from "@/src/core/types";

/** One tiny structured request through a provider, to confirm install, login and output parsing. */
export async function POST(req: Request) {
  return handle(req, async () => {
    const b = await body<{ provider?: ProviderId }>(req);
    const base = getSettings();
    const provider = b.provider ?? base.provider;
    if (!(provider in PROVIDERS)) throw new InputError("Unknown provider.");
    const settings = { ...base, provider, fallbackProvider: "" as const };
    const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const t = Date.now();
    try {
      const out = await runAgent({
        role: "helper",
        system: "ROLE: CONNECTION CHECK\nYou are verifying that structured replies work. Reply only with the requested JSON.",
        prompt: 'Reply with {"ok": true, "model": "<the model name you are, if you know it>"}.',
        schema: z.object({ ok: z.boolean(), model: z.string().optional() }),
        settings,
        usage,
        timeoutMs: 180_000,
      });
      return { ok: out.ok === true, ms: Date.now() - t, model: out.model ?? null, provider: PROVIDERS[provider].name, usage };
    } catch (err) {
      return { ok: false, ms: Date.now() - t, provider: PROVIDERS[provider].name, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
