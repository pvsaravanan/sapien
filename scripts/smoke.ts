// Live smoke test: one real CLI call per interactive agent schema.
// Usage: npx tsx scripts/smoke.ts [model]
import { runProber, runTeacher } from "../src/agents/agents";
import { DEFAULT_SETTINGS } from "../src/server/defaults";
import type { Usage } from "../src/core/types";

const model = (process.argv[2] ?? "haiku") as "haiku";
const settings = { ...DEFAULT_SETTINGS, models: Object.fromEntries(Object.keys(DEFAULT_SETTINGS.models).map((k) => [k, model])) as typeof DEFAULT_SETTINGS.models, effort: { teacher: "low" as const } };
const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
const t0 = Date.now();
const probe = await runProber({ settings, usage }, "SESSION TOPIC: why the sky is blue\n\nTRANSCRIPT\nLEARNER: why is the sky blue? I know light is a wave.\n\nYOUR TASK NOW\nDecide your next move as the prober.");
console.log("PROBER", Math.round((Date.now() - t0) / 1000) + "s", JSON.stringify(probe).slice(0, 400));
const plan = { nodes: [{ id: "wavelength", title: "Wavelength and colour" }, { id: "scattering", title: "Rayleigh scattering" }], edges: [{ from: "wavelength", to: "scattering" }], version: 1 };
const t1 = Date.now();
const teach = await runTeacher({ settings, usage }, `SESSION TOPIC: why the sky is blue\n\nCURRENT PLAN\n- wavelength: Wavelength and colour\n- scattering: Rayleigh scattering\n\nTRANSCRIPT\nLEARNER: why is the sky blue?\n\nYOUR TASK NOW\nOpen the lesson with the first step.`, plan);
console.log("TEACHER", Math.round((Date.now() - t1) / 1000) + "s", JSON.stringify(teach).slice(0, 600));
console.log("usage", usage);
