import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Graph, Proposition } from "../src/core/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapien-sem-"));
process.env.SAPIEN_DATA_DIR = dir;

let emb: typeof import("../src/server/embeddings");
let graphCore: typeof import("../src/core/graph");

/** Fake embedder: words map to concept axes, so paraphrases land close together. */
const CONCEPTS: Record<string, number> = {
  light: 0, c: 0, photon: 0,
  speed: 1, fast: 1, velocity: 1,
  constant: 2, same: 2, change: 2, invariant: 2, "doesn't": 2,
  sky: 3, blue: 3, scatter: 3, scattering: 3,
  hash: 4, table: 4, bucket: 4, buckets: 4,
};
let calls = 0;
let embedded = 0;
async function fakeEmbed(texts: string[]): Promise<Float32Array[]> {
  calls++;
  embedded += texts.length;
  return texts.map((t) => {
    const v = new Float32Array(6);
    for (const w of t.toLowerCase().match(/[a-z']+/g) ?? []) if (w in CONCEPTS) v[CONCEPTS[w]] += 1;
    v[5] = 0.05;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
}

const prop = (id: string, name: string, statement: string): Proposition => ({ id, name, statement, aliases: [], createdAt: "", provenance: [{ source: "s" }] });
const graph: Graph = {
  propositions: [
    prop("light-constant", "Speed of light is the same for all colours", "Light travels at one speed, c, whatever its colour."),
    prop("rayleigh", "Rayleigh scattering", "Short wavelengths scatter more, which is why the sky is blue."),
    prop("hashing", "Hash tables", "Keys are placed into buckets by a hash function."),
  ],
  chains: [],
};

before(async () => {
  emb = await import("../src/server/embeddings");
  graphCore = await import("../src/core/graph");
  emb.setEmbedder(fakeEmbed);
});
after(() => {
  emb.setEmbedder(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the index embeds only new or changed claims and drops deleted ones", async () => {
  embedded = 0;
  const v1 = await emb.ensureIndex(graph);
  assert.equal(v1.size, 3);
  assert.equal(embedded, 3);
  embedded = 0;
  await emb.ensureIndex(graph);
  assert.equal(embedded, 0, "unchanged claims are not re-embedded");
  const edited: Graph = { ...graph, propositions: [{ ...graph.propositions[0], statement: "c is invariant." }, graph.propositions[1]] };
  const v2 = await emb.ensureIndex(edited);
  assert.equal(embedded, 1, "only the edited claim is re-embedded");
  assert.equal(v2.size, 2, "the deleted claim is dropped");
  assert.ok(fs.existsSync(path.join(dir, "graph", "embeddings.json")));
  await emb.ensureIndex(graph);
});

test("meaning-based ranking finds a paraphrase that word matching misses", async () => {
  const q = "c doesn't change";
  assert.equal(graphCore.searchGraph(graph, q, 5).length, 0, "no shared words with any claim");
  const ranked = await emb.semanticRank(graph, q, 3);
  assert.equal(ranked[0].prop.id, "light-constant");
  assert.ok(ranked[0].semantic > ranked[1].semantic);
  const related = await emb.relatedProps(graph, q, 5, true);
  assert.equal(related[0]?.id, "light-constant");
  assert.deepEqual(await emb.relatedProps(graph, q, 5, false), [], "disabled = word matching only");
});

test("audit candidates include paraphrased duplicates", async () => {
  const finding = { name: "Photon velocity invariant", statement: "The speed of light does not change." };
  const lexical = graphCore.candidatesFor(finding, graph);
  const semantic = await emb.auditCandidates(finding, graph, true);
  assert.ok(semantic.some((p) => p.id === "light-constant"));
  assert.ok(semantic.length >= lexical.length);
  assert.ok(!semantic.some((p) => p.id === "hashing"), "unrelated claims stay out");
});

test("agent context never waits for the model: words are used until it is ready", async () => {
  emb.setEmbedder(null);
  // Simulate a model that is still downloading.
  const g = globalThis as unknown as { __sapienSemantic: { state: string; embedder?: Promise<unknown> } };
  g.__sapienSemantic.state = "downloading";
  g.__sapienSemantic.embedder = new Promise(() => {});
  const t = Date.now();
  const related = await emb.relatedProps(graph, "why is the sky blue", 5, true);
  assert.ok(Date.now() - t < 200, "returned immediately");
  assert.equal(related[0]?.id, "rayleigh", "word matching result");
  g.__sapienSemantic.embedder = undefined;
  emb.setEmbedder(fakeEmbed);
});
