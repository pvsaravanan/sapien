import assert from "node:assert/strict";
import { test } from "node:test";
import { planVersions, versionStatus } from "../src/core/plan";
import type { Plan, SessionEvent } from "../src/core/types";

const plan = (version: number, ids: string[]): Plan => ({ version, nodes: ids.map((id) => ({ id, title: id })), edges: [] });
const q = (id: string, nodeId: string): SessionEvent => ({
  id, at: "", type: "question", agent: "teacher",
  interaction: { kind: "choice", role: "check", nodeId, question: "?", options: ["a", "b"], correct: [0] },
});

test("each map version is kept with the progress it had when replaced", () => {
  const events: SessionEvent[] = [
    { id: "p1", at: "", type: "plan", plan: plan(1, ["a", "b", "c"]) },
    q("q1", "a"),
    q("q2", "b"),
    { id: "p2", at: "", type: "plan", plan: plan(2, ["b", "d"]), reason: "goal changed" },
    q("q3", "d"),
  ];
  const v = planVersions(events);
  assert.deepEqual(v.map((x) => [x.plan.version, x.start, x.end]), [[1, 0, 3], [2, 3, 5]]);
  const old = versionStatus(events, v[0]);
  assert.equal(old.current, "b");
  assert.deepEqual([...old.visited], ["a"]);
  const now = versionStatus(events, v[1]);
  assert.equal(now.current, "d");
  assert.deepEqual([...now.visited].sort(), ["a", "b"]);
});

test("a session without maps has no versions", () => {
  assert.deepEqual(planVersions([]), []);
});
