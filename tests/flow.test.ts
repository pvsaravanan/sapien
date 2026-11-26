import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { EngineRequest, EngineResult } from "../src/server/engine";

// Isolated data dir; must be set before the store module loads.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapien-test-"));
process.env.SAPIEN_DATA_DIR = dir;

type Orch = typeof import("../src/server/orchestrator");
let orch: Orch;
let store: typeof import("../src/server/store");
const calls: string[] = [];
const scripts: Record<string, unknown[]> = {};

function roleOf(req: EngineRequest): string {
  const m = /ROLE: ([A-Z -]+)/.exec(req.system);
  return m ? m[1].trim() : "UNKNOWN";
}

async function fakeEngine(req: EngineRequest): Promise<EngineResult> {
  const role = roleOf(req);
  calls.push(role);
  const queue = scripts[role];
  if (!queue?.length) throw new Error(`No scripted output for ${role}`);
  return { output: queue.shift(), usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } };
}

async function idle(id: string) {
  for (let i = 0; i < 200 && orch.isRunning(id); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(orch.isRunning(id), false, "turn did not finish");
}

before(async () => {
  const runtime = await import("../src/server/runtime");
  runtime.setEngine(fakeEngine);
  orch = await import("../src/server/orchestrator");
  store = await import("../src/server/store");
  store.saveSettings({ ...store.getSettings(), graphEnabled: true, graphSemantic: false, extractionThresholdChars: 100000, workers: { research: true, visual: true, demo: true } });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("teach flow: probe → plan → teach (with retry on invalid output) → grade → complete → extract", async () => {
  scripts["PROBER"] = [
    { message: "Let's see where you are.", action: "probe_choice", question: "What is $2+2$?", options: ["3", "4", "5"], correct: [1], explanation: "Basic addition.", optionNotes: ["Off by one.", "2 + 2 = 4.", "Off by one."] },
    { message: "Thanks — I have what I need.", action: "finish", states: { current: "Knows addition.", goal: "Understand multiplication as repeated addition." } },
  ];
  scripts["PLANNER"] = [
    { nodes: [{ id: "repeated-addition", title: "Repeated addition", summary: "s" }, { id: "multiplication", title: "Multiplication", summary: "s" }], edges: [{ from: "repeated-addition", to: "multiplication" }], intro: "We go from addition to multiplication." },
  ];
  scripts["TEACHER"] = [
    // Invalid: nodeId not in plan → runtime retries with feedback.
    { message: "Adding 3 four times…", action: "check_recall", role: "check", nodeId: "nope", question: "Why is 3×4 = 12?", committedAnswer: "Because 3×4 means four 3s: 3+3+3+3 = 12." },
    { message: "Adding 3 four times…", action: "check_recall", role: "check", nodeId: "repeated-addition", question: "Why is 3×4 = 12?", committedAnswer: "Because 3×4 means four 3s: 3+3+3+3 = 12.", dispatch: [{ kind: "visual", title: "Array of dots", brief: "A 3 by 4 grid of dots" }] },
    // Delivery turn when the visual arrives (question still open): nothing to add.
    { message: "", action: "none" },
    { message: "Exactly.", action: "complete", summary: "Multiplication follows from repeated addition." },
  ];
  scripts["GRADER"] = [{ verdict: "correct", feedback: "Yes — four groups of three." }];
  scripts["VISUAL MAKER"] = [{ svg: '<svg viewBox="0 0 10 10" width="100"><circle cx="5" cy="5" r="2"/></svg>', caption: "Twelve dots." }];
  scripts["KNOWLEDGE EXTRACTOR"] = [
    { propositions: [{ key: "p1", name: "Multiplication as repeated addition", statement: "a×b means adding a, b times." }, { key: "p2", name: "3×4 = 12", statement: "Three times four equals twelve." }], chains: [{ premises: ["p1"], conclusion: "p2" }] },
  ];

  const s0 = orch.createSession({ kind: "teach", topic: "multiplication" });
  await idle(s0.id);
  let s = store.getSession(s0.id)!;
  const probe = s.events.find((e) => e.type === "question")!;
  assert.equal(s.phase, "probing");

  // Answering a choice question grades it immediately, then runs prober → planner → teacher.
  orch.submitInput(s.id, { type: "answer", eventId: probe.id, answer: { kind: "choice", selected: [1], thinking: { confidence: 80 } } });
  await idle(s.id);
  s = store.getSession(s.id)!;
  assert.equal(s.lastError, undefined, s.lastError);
  assert.equal((s.events.find((e) => e.id === probe.id) as { grade?: { verdict: string } }).grade?.verdict, "correct");
  assert.equal(s.phase, "teaching");
  assert.equal(s.plan?.nodes.length, 2);
  assert.ok(s.states);
  const check = [...s.events].reverse().find((e) => e.type === "question")!;
  assert.equal(check.type === "question" && check.interaction.kind === "recall" && check.interaction.nodeId, "repeated-addition");
  assert.deepEqual(calls.filter((c) => c === "TEACHER").length, 2, "teacher retried once after invalid nodeId");

  // Wait for the background visual job and its delivery marker.
  for (let i = 0; i < 100 && !store.getSession(s.id)!.events.some((e) => e.type === "job_result"); i++) await new Promise((r) => setTimeout(r, 10));
  const jobs = store.listJobs(s.id);
  assert.equal(jobs[0].status, "done");
  // The finished job wakes the teacher once (delivery turn), then the session is idle again.
  for (let i = 0; i < 200 && !store.getSession(s.id)!.events.some((e) => e.type === "job_result" && e.delivered); i++) await new Promise((r) => setTimeout(r, 10));
  await idle(s.id);
  assert.ok(store.getSession(s.id)!.events.some((e) => e.type === "job_result" && e.delivered), "result delivered to the teacher");

  // Free recall → grader → teacher completes; completion triggers extraction.
  assert.throws(() => orch.submitInput(s.id, { type: "answer", eventId: probe.id, answer: { kind: "choice", selected: [1] } }), /already answered|no longer current/);
  orch.submitInput(s.id, { type: "answer", eventId: check.id, answer: { kind: "recall", text: "four threes" } });
  await idle(s.id);
  s = store.getSession(s.id)!;
  assert.equal(s.phase, "complete");
  const graded = s.events.find((e) => e.id === check.id) as { grade?: { verdict: string } };
  assert.equal(graded.grade?.verdict, "correct");
  for (let i = 0; i < 100 && store.getSession(s.id)!.extractedThrough === 0; i++) await new Promise((r) => setTimeout(r, 10));
  const graph = store.getGraph();
  assert.equal(graph.propositions.length, 2);
  assert.equal(graph.chains.length, 1);
  assert.ok(store.getSession(s.id)!.usage.calls >= 8);
});

test("practice flow: pose → attempt → conclude → wait → next", async () => {
  scripts["PRACTITIONER"] = [
    { message: "", action: "pose", statement: "A box holds 6 rows of 7 eggs. How many eggs?", solution: "6×7 = 42" },
    { message: "Right!", action: "conclude", outcome: "solved", verdict: "Recognised the array structure immediately." },
    { message: "Here's another.", action: "pose", statement: "8 teams of 5 players?", solution: "40" },
  ];
  const s0 = orch.createSession({ kind: "practice", topic: "multiplication word problems" });
  await idle(s0.id);
  let s = store.getSession(s0.id)!;
  const problem = s.events.find((e) => e.type === "problem")!;
  assert.equal(problem.type === "problem" && problem.status, "active");
  assert.throws(() => orch.submitInput(s.id, { type: "next_problem" }), /current problem/);
  orch.submitInput(s.id, { type: "attempt", text: "42" });
  await idle(s.id);
  s = store.getSession(s.id)!;
  assert.equal((s.events.find((e) => e.id === problem.id) as { status: string }).status, "concluded");
  orch.submitInput(s.id, { type: "next_problem" });
  await idle(s.id);
  s = store.getSession(s.id)!;
  assert.equal(s.events.filter((e) => e.type === "problem").length, 2);
});

test("redaction hides keys of unanswered questions from the browser", async () => {
  const { redact } = await import("../src/server/views");
  const s = store.listSessions().find((x) => x.kind === "practice")!;
  const r = redact(s);
  const active = r.events.filter((e) => e.type === "problem" && e.status === "active");
  assert.ok(active.every((e) => e.type === "problem" && e.problem.solution === ""));
});
