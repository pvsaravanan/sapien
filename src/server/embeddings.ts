import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { candidatesFor, searchGraph, similarity } from "../core/graph";
import type { Graph, Proposition } from "../core/types";
import { DATA_DIR } from "./store";

/** Local semantic search for the knowledge graph.
 *  A small sentence-embedding model (all-MiniLM-L6-v2, 384 dimensions, ~23 MB quantized)
 *  runs on this machine via transformers.js: no API key, no per-search cost, and graph
 *  text never leaves the computer. The model is downloaded once into data/models
 *  (Node first; falls back to `curl`, which trusts the system keychain, for networks
 *  that intercept TLS), then loaded with remote access disabled. */

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];
const MODELS_DIR = path.join(DATA_DIR, "models");
const INDEX_FILE = path.join(DATA_DIR, "graph", "embeddings.json");

export type SemanticState = "idle" | "downloading" | "loading" | "ready" | "error";
type Embedder = (texts: string[]) => Promise<Float32Array[]>;

const g = globalThis as unknown as {
  __sapienSemantic?: { state: SemanticState; error?: string; embedder?: Promise<Embedder>; override?: Embedder | null; indexing?: Promise<unknown> };
};
const sem = (g.__sapienSemantic ??= { state: "idle" });

/** Tests can supply a deterministic embedder. */
export function setEmbedder(e: Embedder | null) {
  sem.override = e;
  sem.state = e ? "ready" : "idle";
  sem.embedder = undefined;
}

export function semanticStatus(): { state: SemanticState; error?: string; model: string; downloaded: boolean } {
  return { state: sem.override ? "ready" : sem.state, error: sem.error, model: MODEL_ID, downloaded: modelPresent() };
}

function modelDir() {
  return path.join(MODELS_DIR, MODEL_ID);
}
function modelPresent() {
  return MODEL_FILES.every((f) => {
    try {
      return fs.statSync(path.join(modelDir(), f)).size > 0;
    } catch {
      return false;
    }
  });
}

function curl(url: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-sL", "--fail", "--max-time", "300", "-o", out, url], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`curl exited ${code} ${err.trim()}`))));
  });
}

async function download() {
  for (const f of MODEL_FILES) {
    const dest = path.join(modelDir(), f);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const url = `https://huggingface.co/${MODEL_ID}/resolve/main/${f}`;
    const tmp = `${dest}.part`;
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    } catch {
      // Corporate proxies often re-sign TLS with a root Node does not trust; curl uses the system store.
      await curl(url, tmp);
    }
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error(`Downloaded ${f} is empty`);
    fs.renameSync(tmp, dest);
  }
}

/** Load (downloading once if needed) the embedding model. */
export function getEmbedder(): Promise<Embedder> {
  if (sem.override) return Promise.resolve(sem.override);
  if (sem.embedder) return sem.embedder;
  sem.embedder = (async () => {
    try {
      if (!modelPresent()) {
        sem.state = "downloading";
        await download();
      }
      sem.state = "loading";
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      env.localModelPath = MODELS_DIR;
      const fe = await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
      sem.state = "ready";
      sem.error = undefined;
      return async (texts: string[]) => {
        const out: Float32Array[] = [];
        for (let i = 0; i < texts.length; i += 32) {
          const t = await fe(texts.slice(i, i + 32), { pooling: "mean", normalize: true });
          const [n, d] = t.dims as [number, number];
          const data = t.data as Float32Array;
          for (let r = 0; r < n; r++) out.push(data.slice(r * d, (r + 1) * d));
        }
        return out;
      };
    } catch (err) {
      sem.state = "error";
      sem.error = err instanceof Error ? err.message : String(err);
      sem.embedder = undefined; // allow a later retry
      throw err;
    }
  })();
  return sem.embedder;
}

// ─── vector index over propositions ─────────────────────────────────────────

interface IndexFile {
  model: string;
  items: Record<string, { h: string; v: string }>;
}

const propText = (p: Proposition) => [p.name, p.statement, ...(p.aliases ?? [])].join(". ");
const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const toB64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const fromB64 = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

function readIndex(): IndexFile {
  try {
    const f = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")) as IndexFile;
    return f.model === MODEL_ID ? f : { model: MODEL_ID, items: {} };
  } catch {
    return { model: MODEL_ID, items: {} };
  }
}

/** Vectors for every proposition, embedding only new or changed ones. */
export async function ensureIndex(graph: Graph): Promise<Map<string, Float32Array>> {
  const embed = await getEmbedder();
  const index = readIndex();
  const want = new Map(graph.propositions.map((p) => [p.id, { p, h: hash(propText(p)) }]));
  const stale = [...want.values()].filter(({ p, h }) => index.items[p.id]?.h !== h);
  if (stale.length) {
    const vecs = await embed(stale.map(({ p }) => propText(p)));
    stale.forEach(({ p, h }, i) => (index.items[p.id] = { h, v: toB64(vecs[i]) }));
  }
  let pruned = false;
  for (const id of Object.keys(index.items))
    if (!want.has(id)) {
      delete index.items[id];
      pruned = true;
    }
  if (stale.length || pruned) {
    fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
    const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, INDEX_FILE);
  }
  return new Map(Object.entries(index.items).map(([id, it]) => [id, fromB64(it.v)]));
}

/** Refresh the index in the background (e.g. after extraction). */
export function refreshIndex(graph: Graph) {
  sem.indexing = ensureIndex(graph).catch(() => {});
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export interface Ranked {
  prop: Proposition;
  score: number;
  semantic: number;
  lexical: number;
}

/** Hybrid ranking: 80% meaning (cosine similarity), 20% shared words. */
export async function semanticRank(graph: Graph, query: string, k = 15): Promise<Ranked[]> {
  if (!query.trim() || !graph.propositions.length) return [];
  const [vectors, [q]] = await Promise.all([ensureIndex(graph), getEmbedder().then((e) => e([query]))]);
  return graph.propositions
    .map((prop) => {
      const v = vectors.get(prop.id);
      const semantic = v ? dot(q, v) : 0;
      const lexical = similarity(query, propText(prop));
      return { prop, semantic, lexical, score: 0.8 * semantic + 0.2 * lexical };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Related propositions for agent context; word matching if the model is unavailable. */
export async function relatedProps(graph: Graph, query: string, k = 15, enabled = true): Promise<Proposition[]> {
  if (!enabled) return searchGraph(graph, query, k);
  // Never make a lesson turn wait for the one-time download: use words now, load in the background.
  if (!sem.override && sem.state !== "ready") {
    void getEmbedder().catch(() => {});
    return searchGraph(graph, query, k);
  }
  try {
    return (await semanticRank(graph, query, k)).filter((r) => r.score > 0.22).map((r) => r.prop);
  } catch {
    return searchGraph(graph, query, k);
  }
}

/** Identity-audit candidates: meaning and word matches combined, so paraphrased
 *  duplicates ("light speed constant" / "speed of light is the same for all colours") meet. */
export async function auditCandidates(
  finding: { name: string; statement: string; aliases?: string[] },
  graph: Graph,
  enabled = true,
  k = 6,
): Promise<Proposition[]> {
  const lexical = candidatesFor(finding, graph, k);
  if (!enabled) return lexical;
  try {
    const ranked = await semanticRank(graph, [finding.name, finding.statement, ...(finding.aliases ?? [])].join(". "), k);
    const semantic = ranked.filter((r) => r.semantic >= 0.5).map((r) => r.prop);
    return [...new Map([...semantic, ...lexical].map((p) => [p.id, p])).values()].slice(0, k);
  } catch {
    return lexical;
  }
}
