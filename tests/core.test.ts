import assert from "node:assert/strict";
import { test } from "node:test";
import { candidatesFor, mergeFindings, removeSource, simplifyChains } from "../src/core/graph";
import { heal } from "../src/core/heal";
import { layoutPlan, planProblems, planStatus } from "../src/core/plan";
import { sanitizeSvg, wrapDemoHtml } from "../src/core/sanitize";
import { renderTranscript } from "../src/core/transcript";
import type { Graph, Session, SessionEvent } from "../src/core/types";

test("heal flattens a stringified array packed into one element", () => {
  const out = heal({ options: ['["a","b","c"]'], correct: 1 }) as { options: string[] };
  assert.deepEqual(out.options, ["a", "b", "c"]);
  // Ordinary strings that merely look bracketed are left alone.
  assert.deepEqual(heal({ options: ["[0, 1)", "b"] }), { options: ["[0, 1)", "b"] });
});

test("planProblems rejects cycles, bad ids and dangling edges", () => {
  const nodes = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
  assert.deepEqual(planProblems(nodes, [{ from: "a", to: "b" }]), []);
  assert.match(planProblems(nodes, [{ from: "a", to: "b" }, { from: "b", to: "a" }]).join(), /acyclic/);
  assert.match(planProblems([{ id: "Bad Id", title: "x" }], []).join(), /kebab/);
  assert.match(planProblems(nodes, [{ from: "a", to: "zzz" }]).join(), /unknown node/);
});

test("layoutPlan places dependents below prerequisites", () => {
  const { nodes } = layoutPlan({ nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }], version: 1 });
  const layer = Object.fromEntries(nodes.map((n) => [n.id, n.layer]));
  assert.deepEqual(layer, { a: 0, b: 1, c: 2 });
});

const q = (id: string, nodeId: string, answered = true): SessionEvent => ({
  id, at: "", type: "question", agent: "teacher",
  interaction: { kind: "choice", role: "check", nodeId, question: "?", options: ["x", "y"], correct: [0] },
  ...(answered ? { answer: { kind: "choice", selected: [0] } } : {}),
});

test("planStatus derives current and visited from tagged questions", () => {
  const st = planStatus([q("1", "a"), q("2", "a"), q("3", "b", false)]);
  assert.equal(st.current, "b");
  assert.deepEqual([...st.visited], ["a"]);
});

test("helper transcript hides open answer keys but agents see them", () => {
  const s = { events: [q("1", "a", false)], side: [] } as unknown as Session;
  assert.doesNotMatch(renderTranscript(s, { audience: "helper" }), /Correct:/);
  assert.match(renderTranscript(s, { audience: "agent" }), /Correct: A/);
});

test("sanitizeSvg strips script, handlers and external references", () => {
  const svg = sanitizeSvg('junk <svg viewBox="0 0 10 10"><script>alert(1)</script><rect onclick="x()" width="5"/><image href="https://evil/x.png"/><use href="#a"/></svg> tail')!;
  assert.doesNotMatch(svg, /script|onclick|evil/);
  assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /href="#a"/);
  assert.equal(sanitizeSvg("no svg here"), null);
});

test("wrapDemoHtml injects a CSP that blocks network access", () => {
  assert.match(wrapDemoHtml("<p>hi</p>"), /connect-src 'none'/);
  assert.match(wrapDemoHtml("<html><head><title>t</title></head><body></body></html>"), /<head><meta http-equiv="Content-Security-Policy"/);
});

test("mergeFindings links identities, adds new claims, dedupes and simplifies chains", () => {
  const g0: Graph = {
    propositions: [{ id: "chain-rule", name: "Chain rule", statement: "The derivative of f(g(x)) is f'(g(x))g'(x).", aliases: [], createdAt: "", provenance: [{ source: "s0" }] }],
    chains: [],
  };
  const findings = {
    propositions: [
      { key: "p1", name: "Composite derivative rule", statement: "d/dx f(g(x)) = f'(g(x)) g'(x)" },
      { key: "p2", name: "Derivative of sin", statement: "The derivative of sin x is cos x." },
      { key: "p3", name: "Derivative of sin(2x)", statement: "The derivative of sin(2x) is 2cos(2x)." },
      { key: "p4", name: "Linear inner function", statement: "The derivative of 2x is 2." },
    ],
    chains: [
      { premises: ["p1", "p2", "p4"], conclusion: "p3" },
      { premises: ["p1", "p2"], conclusion: "p3" },
      { premises: ["p9"], conclusion: "p3" },
    ],
  };
  const { graph, stats } = mergeFindings(g0, findings, { p1: "chain-rule" }, { source: "s1" });
  assert.equal(stats.linked, 1);
  assert.equal(stats.added, 3);
  const rule = graph.propositions.find((p) => p.id === "chain-rule")!;
  assert.deepEqual(rule.provenance.map((p) => p.source), ["s0", "s1"]);
  assert.ok(rule.aliases.includes("Composite derivative rule"));
  // The superset chain is redundant; the dangling one is dropped.
  assert.equal(graph.chains.length, 1);
  assert.equal(graph.chains[0].premises.length, 2);
  // Removing s1 keeps the claim s0 supports and drops everything only s1 asserted.
  const after = removeSource(graph, "s1");
  assert.deepEqual(after.propositions.map((p) => p.id), ["chain-rule"]);
  assert.equal(after.chains.length, 0);
});

test("simplifyChains keeps distinct arguments", () => {
  const c = (id: string, premises: string[]) => ({ id, premises, conclusion: "z", createdAt: "", provenance: [] });
  assert.equal(simplifyChains([c("1", ["a", "b"]), c("2", ["c"])]).length, 2);
});

test("candidatesFor finds lexically similar propositions", () => {
  const g: Graph = { propositions: [
    { id: "a", name: "Rayleigh scattering", statement: "Shorter wavelengths scatter more strongly off air molecules.", aliases: [], createdAt: "", provenance: [] },
    { id: "b", name: "Photosynthesis", statement: "Plants convert light to chemical energy.", aliases: [], createdAt: "", provenance: [] },
  ], chains: [] };
  const c = candidatesFor({ name: "Scattering of short wavelengths", statement: "Air molecules scatter short wavelengths more." }, g);
  assert.deepEqual(c.map((p) => p.id), ["a"]);
});

test("requireAll makes optional wire fields required-but-nullable; heal strips nulls back out", async () => {
  const { z } = await import("zod");
  const { jsonSchemaOf } = await import("../src/server/runtime");
  const schema = z.object({ action: z.enum(["a", "b"]), correct: z.array(z.number()).optional(), nested: z.object({ x: z.string().optional() }).optional() });
  const js = jsonSchemaOf(schema) as { required: string[]; properties: Record<string, { anyOf?: unknown[] }> };
  assert.deepEqual(js.required.sort(), ["action", "correct", "nested"]);
  assert.ok(js.properties.correct.anyOf?.some((s) => (s as { type?: string }).type === "null"));
  assert.ok(schema.safeParse(heal({ action: "a", correct: null, nested: { x: null } })).success);
});

test("runAgent falls back to another model when one declines the request", async () => {
  const { z } = await import("zod");
  const { runAgent, setEngine } = await import("../src/server/runtime");
  const { EngineError } = await import("../src/server/engine");
  const { DEFAULT_SETTINGS } = await import("../src/server/defaults");
  const tried: string[] = [];
  setEngine(async (req) => {
    tried.push(req.model ?? "default");
    if (req.model === "opus") throw new EngineError("API Error: Opus's safeguards flagged this message", "refusal");
    return { output: { ok: "yes" }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
  });
  const out = await runAgent({ role: "planner", system: "s", prompt: "p", schema: z.object({ ok: z.string() }), settings: DEFAULT_SETTINGS });
  assert.deepEqual(out, { ok: "yes" });
  assert.deepEqual(tried, ["opus", "sonnet"]);
  // A non-refusal error is not retried on other models.
  tried.length = 0;
  setEngine(async (req) => {
    tried.push(req.model ?? "default");
    throw new EngineError("network down");
  });
  await assert.rejects(runAgent({ role: "planner", system: "s", prompt: "p", schema: z.object({ ok: z.string() }), settings: DEFAULT_SETTINGS }), /network down/);
  assert.deepEqual(tried, ["opus"]);
  setEngine(null);
});
