import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Session, SessionEvent } from "../src/core/types";

// Isolated data dir; must be set before the store module loads.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapien-cache-"));
process.env.SAPIEN_DATA_DIR = dir;

let orch: typeof import("../src/server/orchestrator");
let store: typeof import("../src/server/store");
let engine: typeof import("../src/server/engine");

before(async () => {
  engine = await import("../src/server/engine");
  store = await import("../src/server/store");
  orch = await import("../src/server/orchestrator");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("promptBlocks splits blocks and keeps exactly one cache point", () => {
  const { BLOCK, CACHE_POINT, promptBlocks, plainPrompt } = engine;
  const p = `head${BLOCK}one${CACHE_POINT}${BLOCK}two${CACHE_POINT}${BLOCK}tail`;
  assert.deepEqual(promptBlocks(p), [
    { text: "head", cache: false },
    { text: "one", cache: false },
    { text: "two", cache: true },
    { text: "tail", cache: false },
  ]);
  assert.equal(plainPrompt(p), "headonetwotail");
  // An empty block before a cache point moves the point to the previous block.
  assert.deepEqual(promptBlocks(`head${BLOCK}${CACHE_POINT}${BLOCK}tail`), [
    { text: "head", cache: true },
    { text: "tail", cache: false },
  ]);
});

const ev = (id: string, e: Record<string, unknown>) => ({ id, at: "", ...e }) as SessionEvent;

test("each turn's cached prefix is an exact prefix of the next turn's prompt", () => {
  const { promptBlocks } = engine;
  const base: Session = {
    id: "cache0000000000a",
    kind: "teach",
    title: "SQL",
    topic: "SQL",
    createdAt: "",
    updatedAt: "",
    phase: "teaching",
    states: { current: "Beginner.", goal: "Read queries." },
    plan: { version: 1, nodes: [{ id: "a", title: "A", summary: "s" }, { id: "b", title: "B", summary: "s" }], edges: [{ from: "a", to: "b" }] },
    events: [
      ev("e1", { type: "learner_message", text: "I want to learn SQL." }),
      ev("e2", { type: "agent_message", agent: "teacher", text: "Step one." }),
      ev("e3", { type: "question", agent: "teacher", interaction: { kind: "choice", role: "check", nodeId: "a", question: "Q1?", options: ["x", "y"], correct: [0] }, answer: { kind: "choice", selected: [0] } }),
    ],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    extractedThrough: 0,
    side: [],
    status: "idle",
  };
  store.saveSession(base);
  const settings = { ...store.getSettings(), graphEnabled: false };
  const cachedPart = (prompt: string) => {
    const blocks = promptBlocks(prompt);
    const i = blocks.findIndex((b) => b.cache);
    assert.ok(i > 0, "a cache point is set after the transcript");
    return blocks.slice(0, i + 1).map((b) => b.text);
  };

  const before = orch.buildContext(base, settings, "TEACH");
  // The next turn: a new teaching step and a question on the next node (progress changes).
  const next: Session = {
    ...base,
    events: [
      ...base.events,
      ev("e4", { type: "agent_message", agent: "teacher", text: "Step two." }),
      ev("e5", { type: "question", agent: "teacher", interaction: { kind: "choice", role: "check", nodeId: "b", question: "Q2?", options: ["x", "y"], correct: [1] }, answer: { kind: "choice", selected: [1] } }),
    ],
  };
  const after = orch.buildContext(next, settings, "TEACH");

  const a = cachedPart(before);
  const b = promptBlocks(after).map((x) => x.text);
  assert.deepEqual(b.slice(0, a.length), a, "previous cached blocks are unchanged");
  // Per-turn state lives after the cache point.
  assert.match(promptBlocks(after).at(-1)!.text, /PLAN PROGRESS\nCurrent step: b \(B\)\nVisited: a/);
  assert.match(promptBlocks(after).at(-1)!.text, /YOUR TASK NOW\nTEACH$/);
  assert.doesNotMatch(a.join(""), /\[CURRENT\]|\[visited\]/);
});
