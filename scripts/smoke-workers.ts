// Live smoke test of the three background workers. Usage: npx tsx scripts/smoke-workers.ts [model]
import { runWorker } from "../src/agents/agents";
import { sanitizeSvg } from "../src/core/sanitize";
import { DEFAULT_SETTINGS } from "../src/server/defaults";

const model = (process.argv[2] ?? "haiku") as "haiku";
const settings = { ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models, research: model, visual: model, demo: model } };
const jobs = [
  ["visual", "Rayleigh scattering", "Diagram: sunlight from the left hits a small air molecule; short blue arrows scatter in many directions, long red arrow continues mostly straight. Label 'blue scatters ~5.5x more than red'."],
  ["demo", "Scattering vs wavelength", "Slider for wavelength 380–700 nm; show relative scattered intensity ∝ 1/λ^4 as a bar and number, bar coloured by the wavelength's colour."],
  ["research", "Why not violet", "Why does the sky look blue rather than violet even though violet scatters more? Give the main factors."],
] as const;
await Promise.all(jobs.map(async ([kind, title, brief]) => {
  const t = Date.now();
  try {
    const r = await runWorker({ settings }, kind, title, brief, "why the sky is blue") as Record<string, any>;
    const info = kind === "visual" ? `svg ${r.svg.length}B sanitized=${!!sanitizeSvg(r.svg)}` : kind === "demo" ? `html ${r.html.length}B` : `${r.sources.length} sources: ${r.answer.slice(0, 120)}`;
    console.log(kind, Math.round((Date.now() - t) / 1000) + "s", info);
  } catch (e) { console.log(kind, "FAILED", (e as Error).message); }
}));
