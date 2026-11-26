import { slugify } from "./heal";
import type { Chain, Graph, Proposition, Provenance } from "./types";

/** What the extractor proposes, with keys local to one extraction run. */
export interface Findings {
  propositions: { key: string; name: string; statement: string; aliases?: string[] }[];
  chains: { premises: string[]; conclusion: string }[];
}

/** Auditor verdict: finding key → id of an existing proposition stating the same claim. */
export type IdentityLinks = Record<string, string>;

const STOP = new Set(
  "the a an and or of to in on for with by is are was were be been being as at from that this these those it its into than then which who whom whose what when where why how not no can may might must will would should could does do did has have had their there they them his her our your you we i".split(
    " ",
  ),
);

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length >= 3 && !STOP.has(w)) out.add(w.endsWith("s") && w.length > 4 ? w.slice(0, -1) : w);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.sqrt(a.size * b.size);
}

/** Word-overlap similarity of two texts (0–1). */
export function similarity(a: string, b: string): number {
  return overlap(tokens(a), tokens(b));
}

const propText = (p: { name: string; statement: string; aliases?: string[] }) =>
  `${p.name} ${p.statement} ${(p.aliases ?? []).join(" ")}`;

/** Lexical top-K existing propositions that might state the same claim. */
export function candidatesFor(
  finding: { name: string; statement: string; aliases?: string[] },
  graph: Graph,
  k = 6,
): Proposition[] {
  const ft = tokens(propText(finding));
  return graph.propositions
    .map((p) => ({ p, s: overlap(ft, tokens(propText(p))) }))
    .filter((x) => x.s > 0.15)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.p);
}

/** Lexical relevance search over the graph, for seeding agent context. */
export function searchGraph(graph: Graph, query: string, k = 12): Proposition[] {
  const q = tokens(query);
  return graph.propositions
    .map((p) => ({ p, s: overlap(q, tokens(propText(p))) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.p);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function unionProv(into: Provenance[], add: Provenance[]): Provenance[] {
  const key = (p: Provenance) => `${p.source}#${p.eventId ?? ""}`;
  const seen = new Set(into.map(key));
  const out = [...into];
  for (const p of add) if (!seen.has(key(p))) (seen.add(key(p)), out.push(p));
  return out;
}

export interface MergeStats {
  added: number;
  linked: number;
  chainsAdded: number;
  chainsDropped: number;
}

/** Deterministic merge. Returns a new graph; never mutates the input. */
export function mergeFindings(
  graph: Graph,
  findings: Findings,
  links: IdentityLinks,
  provenance: Provenance,
  now = new Date().toISOString(),
): { graph: Graph; stats: MergeStats; resolved: Record<string, string> } {
  const props = graph.propositions.map((p) => ({ ...p, aliases: [...p.aliases], provenance: [...p.provenance] }));
  const byId = new Map(props.map((p) => [p.id, p]));
  const byName = new Map<string, Proposition>();
  for (const p of props) for (const n of [p.name, ...p.aliases]) byName.set(norm(n), p);
  const resolved: Record<string, string> = {};
  const stats: MergeStats = { added: 0, linked: 0, chainsAdded: 0, chainsDropped: 0 };

  for (const f of findings.propositions) {
    if (!f.name?.trim() || !f.statement?.trim()) continue;
    const target = (links[f.key] && byId.get(links[f.key])) || byName.get(norm(f.name));
    if (target) {
      target.provenance = unionProv(target.provenance, [provenance]);
      for (const alias of [f.name, ...(f.aliases ?? [])]) {
        if (norm(alias) !== norm(target.name) && !target.aliases.some((a) => norm(a) === norm(alias))) {
          target.aliases.push(alias);
          byName.set(norm(alias), target);
        }
      }
      resolved[f.key] = target.id;
      stats.linked++;
      continue;
    }
    let id = slugify(f.name);
    for (let i = 2; byId.has(id); i++) id = `${slugify(f.name)}-${i}`;
    const p: Proposition = {
      id,
      name: f.name.trim(),
      statement: f.statement.trim(),
      aliases: (f.aliases ?? []).filter((a) => norm(a) !== norm(f.name)),
      createdAt: now,
      provenance: [provenance],
    };
    props.push(p);
    byId.set(id, p);
    byName.set(norm(p.name), p);
    resolved[f.key] = id;
    stats.added++;
  }

  let chains: Chain[] = graph.chains.map((c) => ({ ...c, provenance: [...c.provenance] }));
  for (const fc of findings.chains) {
    const conclusion = resolved[fc.conclusion];
    const premises = [...new Set(fc.premises.map((k) => resolved[k]))].filter((x): x is string => !!x).sort();
    if (!conclusion || premises.length === 0 || fc.premises.some((k) => !resolved[k]) || premises.includes(conclusion)) {
      stats.chainsDropped++;
      continue;
    }
    const same = chains.find((c) => c.conclusion === conclusion && sameSet(c.premises, premises));
    if (same) {
      same.provenance = unionProv(same.provenance, [provenance]);
      continue;
    }
    chains.push({ id: `chain-${crypto.randomUUID().slice(0, 8)}`, premises, conclusion, createdAt: now, provenance: [provenance] });
    stats.chainsAdded++;
  }
  const before = chains.length;
  chains = simplifyChains(chains);
  stats.chainsAdded -= Math.max(0, before - chains.length);

  return { graph: { propositions: props, chains }, stats, resolved };
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** An argument whose premises strictly contain another argument's premises for the
 *  same conclusion adds nothing; fold its provenance into the smaller one. */
export function simplifyChains(chains: Chain[]): Chain[] {
  const kept = chains.map((c) => ({ ...c }));
  const drop = new Set<string>();
  for (const a of kept) {
    for (const b of kept) {
      if (a === b || drop.has(b.id) || a.conclusion !== b.conclusion) continue;
      if (a.premises.length > b.premises.length && b.premises.every((p) => a.premises.includes(p))) {
        drop.add(a.id);
        b.provenance = unionProv(b.provenance, a.provenance);
      }
    }
  }
  return kept.filter((c) => !drop.has(c.id));
}

/** Remove a source's contributions; knowledge supported elsewhere survives. */
export function removeSource(graph: Graph, source: string): Graph {
  const keep = (prov: Provenance[]) => prov.filter((p) => p.source !== source);
  const propositions = graph.propositions
    .map((p) => ({ ...p, provenance: keep(p.provenance) }))
    .filter((p) => p.provenance.length > 0);
  const alive = new Set(propositions.map((p) => p.id));
  const chains = graph.chains
    .map((c) => ({ ...c, provenance: keep(c.provenance) }))
    .filter((c) => c.provenance.length > 0 && alive.has(c.conclusion) && c.premises.every((p) => alive.has(p)));
  return { propositions, chains };
}

export function removeProposition(graph: Graph, id: string): Graph {
  return {
    propositions: graph.propositions.filter((p) => p.id !== id),
    chains: graph.chains.filter((c) => c.conclusion !== id && !c.premises.includes(id)),
  };
}
