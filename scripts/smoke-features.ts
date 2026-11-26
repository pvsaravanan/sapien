// Live smoke test for delivery turns and summarising. Read-only on the given data dir.
// Usage: SAPIEN_DATA_DIR=... npx tsx scripts/smoke-features.ts <sessionId> [model]
import { runSummarizer, runTeacher } from "../src/agents/agents";
import { renderTranscript } from "../src/core/transcript";
import { DEFAULT_SETTINGS } from "../src/server/defaults";
import { getSession, listJobs } from "../src/server/store";

async function main() {
  const [id, model = "sonnet"] = process.argv.slice(2);
  const s = getSession(id);
  if (!s) throw new Error("session not found");
  const settings = { ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models, teacher: model as "sonnet", summarizer: model as "sonnet" } };
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const transcript = renderTranscript(s, { audience: "agent", jobs: listJobs(id) });

  // 1. Delivery: a research result contradicting nothing, arriving while a question is open.
  const plan = s.plan!;
  const prompt = `CURRENT PLAN\n${plan.nodes.map((n) => `- ${n.id}: ${n.title}`).join("\n")}\n\nTRANSCRIPT\n${transcript.slice(-12000)}\n\n[NEW · research result for "Why not violet?" — visible to the learner]\nThe sky looks blue rather than violet because sunlight contains less violet than blue, some violet is absorbed high in the atmosphere, and human cone sensitivity peaks away from violet.\n\nYOUR TASK NOW\nA background result marked [NEW] has just arrived. You were called only for that. If it adds something the learner should notice now, use action note with one to three sentences. Otherwise use action none.`;
  let t = Date.now();
  const d = await runTeacher({ settings, usage }, prompt, plan, { delivery: "restricted" });
  console.log(`DELIVERY (${Math.round((Date.now() - t) / 1000)}s): action=${d.action} message=${JSON.stringify(d.message).slice(0, 300)}`);

  // 2. Summarise the whole session so far.
  t = Date.now();
  const summary = await runSummarizer({ settings, usage }, undefined, transcript);
  console.log(`SUMMARY (${Math.round((Date.now() - t) / 1000)}s, ${summary.length} chars from ${transcript.length} chars):\n${summary.slice(0, 1400)}`);
  console.log("calls", usage.calls);
}
main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
