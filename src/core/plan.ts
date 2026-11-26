import type { Plan, PlanEdge, PlanNode, SessionEvent } from "./types";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Structural problems with a proposed plan; empty means valid. */
export function planProblems(nodes: PlanNode[], edges: PlanEdge[]): string[] {
  const problems: string[] = [];
  if (nodes.length === 0) problems.push("The plan needs at least one node.");
  if (nodes.length > 40) problems.push("Keep the plan to at most 40 nodes; it is a coarse map, not every step.");
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!ID_RE.test(n.id)) problems.push(`Node id "${n.id}" must be lowercase kebab-case (a-z, 0-9, -).`);
    if (ids.has(n.id)) problems.push(`Duplicate node id "${n.id}".`);
    ids.add(n.id);
    if (!n.title.trim()) problems.push(`Node "${n.id}" needs a title.`);
  }
  const seen = new Set<string>();
  for (const e of edges) {
    if (!ids.has(e.from)) problems.push(`Edge references unknown node "${e.from}".`);
    if (!ids.has(e.to)) problems.push(`Edge references unknown node "${e.to}".`);
    if (e.from === e.to) problems.push(`Edge "${e.from}" → itself is a cycle.`);
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) problems.push(`Duplicate edge ${key}.`);
    seen.add(key);
  }
  if (problems.length === 0 && hasCycle(nodes, edges)) {
    problems.push("The plan must be acyclic: prerequisites cannot depend on what they lead to.");
  }
  return problems;
}

function hasCycle(nodes: PlanNode[], edges: PlanEdge[]): boolean {
  return topoOrder(nodes, edges) === null;
}

/** Kahn's algorithm; null when a cycle exists. Ties keep the authored node order. */
export function topoOrder(nodes: PlanNode[], edges: PlanEdge[]): string[] | null {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    out.get(e.from)!.push(e.to);
  }
  const order: string[] = [];
  const ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of out.get(id)!) {
      const d = indeg.get(next)! - 1;
      indeg.set(next, d);
      if (d === 0) ready.push(next);
    }
  }
  return order.length === nodes.length ? order : null;
}

export interface PlanStatus {
  current: string | null;
  visited: Set<string>;
}

/** Positions derive from which plan nodes the teacher's questions were tagged with —
 *  not from grades. The latest tagged question is "current". */
export function planStatus(events: SessionEvent[]): PlanStatus {
  const visited = new Set<string>();
  let current: string | null = null;
  for (const e of events) {
    if (e.type !== "question" || e.interaction.kind === "ask") continue;
    const nodeId = e.interaction.nodeId;
    if (!nodeId) continue;
    if (current && current !== nodeId) visited.add(current);
    current = nodeId;
  }
  return { current, visited };
}

export interface PlanVersion {
  plan: Plan;
  /** Index of the event that drew this map. */
  start: number;
  /** Index where the next map replaced it (events.length for the current one). */
  end: number;
}

/** Every map the session has had, oldest first, with the event span it was live for. */
export function planVersions(events: SessionEvent[]): PlanVersion[] {
  const out: PlanVersion[] = [];
  events.forEach((e, i) => {
    if (e.type !== "plan") return;
    if (out.length) out[out.length - 1].end = i;
    out.push({ plan: e.plan, start: i, end: events.length });
  });
  return out;
}

/** Progress on a map as it stood when it was replaced (or now, for the current one). */
export function versionStatus(events: SessionEvent[], v: PlanVersion): PlanStatus {
  return planStatus(events.slice(0, v.end));
}

export interface LaidOutNode extends PlanNode {
  x: number;
  y: number;
  layer: number;
}

/** Longest-path layering: a node sits one layer below its deepest prerequisite. */
export function layoutPlan(plan: Plan, colWidth = 210, rowHeight = 92): { nodes: LaidOutNode[]; width: number; height: number } {
  const order = topoOrder(plan.nodes, plan.edges) ?? plan.nodes.map((n) => n.id);
  const layer = new Map<string, number>();
  for (const id of order) {
    const parents = plan.edges.filter((e) => e.to === id).map((e) => layer.get(e.from) ?? 0);
    layer.set(id, parents.length ? Math.max(...parents) + 1 : 0);
  }
  const byLayer = new Map<number, string[]>();
  for (const id of order) {
    const l = layer.get(id)!;
    byLayer.set(l, [...(byLayer.get(l) ?? []), id]);
  }
  const widest = Math.max(1, ...[...byLayer.values()].map((v) => v.length));
  const width = widest * colWidth;
  const nodeById = new Map(plan.nodes.map((n) => [n.id, n]));
  const nodes: LaidOutNode[] = [];
  for (const [l, ids] of byLayer) {
    const offset = (width - ids.length * colWidth) / 2;
    ids.forEach((id, i) => {
      nodes.push({ ...nodeById.get(id)!, layer: l, x: offset + i * colWidth + colWidth / 2, y: l * rowHeight + rowHeight / 2 });
    });
  }
  return { nodes, width, height: byLayer.size * rowHeight };
}
