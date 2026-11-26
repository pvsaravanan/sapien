import { runAuditor, runExtractor } from "../agents/agents";
import { mergeFindings, type MergeStats } from "../core/graph";
import type { NotesSource, Session, SessionEvent, Usage } from "../core/types";
import { withWorkerSlot } from "./engine";
import { auditCandidates, refreshIndex } from "./embeddings";
import { filesFor, getFile, type ContentBlock } from "./files";
import { getGraph, getSession, getSettings, listNotesSources, saveGraph, saveNotesSources, saveSession } from "./store";

const g = globalThis as unknown as { __sapienGraphLock?: Promise<unknown>; __sapienExtracting?: Map<string, string> };
/** sessionId → start time of a running extraction. */
const extracting = (g.__sapienExtracting ??= new Map());

export function extractionsInFlight(): { source: string; startedAt: string }[] {
  return [...extracting].map(([source, startedAt]) => ({ source, startedAt }));
}

/** Serialize audit → merge across all sources so identities resolve against a stable graph. */
function withGraphLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__sapienGraphLock ?? Promise.resolve();
  const next = prev.then(fn, fn);
  g.__sapienGraphLock = next.catch(() => {});
  return next;
}

/** Teacher-authored prose that teaches: messages, plan intros, and choice explanations.
 *  Learner text, questions themselves, and tool results do not count. */
export function teachingProse(events: SessionEvent[]): string {
  const parts: string[] = [];
  for (const e of events) {
    if (e.type === "agent_message" && (e.agent === "teacher" || e.agent === "practitioner")) parts.push(e.text);
    if (e.type === "question" && e.interaction.kind === "choice" && e.interaction.explanation && e.agent === "teacher")
      parts.push(e.interaction.explanation);
    if (e.type === "question" && e.interaction.kind === "recall" && e.agent === "teacher" && e.answer)
      parts.push(e.interaction.committedAnswer);
    if (e.type === "problem" && e.status === "concluded") parts.push(`${e.problem.statement}\n${e.problem.solution}`);
  }
  return parts.join("\n\n");
}

/** Split into chunks of at most `max` chars on paragraph boundaries. */
export function chunk(text: string, max = 30_000): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    if (cur && cur.length + para.length + 2 > max) (out.push(cur), (cur = ""));
    cur = cur ? `${cur}\n\n${para}` : para.slice(0, max);
  }
  if (cur.trim()) out.push(cur);
  return out;
}

async function extractInto(source: string, text: string, usage: Usage, files?: ContentBlock[]): Promise<MergeStats> {
  const settings = getSettings();
  const total: MergeStats = { added: 0, linked: 0, chainsAdded: 0, chainsDropped: 0 };
  const pieces = files?.length ? [""] : chunk(text);
  for (const piece of pieces) {
    const findings = await withWorkerSlot(settings.workerConcurrency, () => runExtractor({ settings, usage, files }, piece));
    if (!findings.propositions.length) continue;
    await withGraphLock(async () => {
      const graph = getGraph();
      const links = await withWorkerSlot(settings.workerConcurrency, () =>
        runAuditor({ settings, usage }, findings, graph, (f, gr) => auditCandidates(f, gr, settings.graphSemantic)),
      );
      const fresh = getGraph(); // re-read: deletions may have happened while auditing
      const { graph: merged, stats } = mergeFindings(fresh, findings, links, { source });
      saveGraph(merged);
      if (settings.graphSemantic) refreshIndex(merged);
      for (const k of Object.keys(total) as (keyof MergeStats)[]) total[k] += stats[k];
    });
  }
  return total;
}

/** Fold uncovered teaching prose into the graph when enough has accumulated
 *  (or the session completed). Coverage advances only after a successful merge. */
export async function maybeExtract(sessionId: string, force = false): Promise<MergeStats | null> {
  const settings = getSettings();
  if (!settings.graphEnabled && !force) return null;
  if (extracting.has(sessionId)) return null;
  const s = getSession(sessionId);
  if (!s || s.status === "running") return null;
  const through = s.events.length;
  const fresh = s.events.slice(s.extractedThrough, through);
  const prose = teachingProse(fresh);
  const completed = fresh.some((e) => e.type === "complete");
  if (!prose.trim() || (!force && !completed && prose.length < settings.extractionThresholdChars)) return null;
  extracting.set(sessionId, new Date().toISOString());
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  try {
    const stats = await extractInto(sessionId, prose, usage);
    const latest = getSession(sessionId);
    if (latest) {
      latest.extractedThrough = Math.max(latest.extractedThrough, through);
      addUsage(latest, usage);
      saveSession(latest);
    }
    return stats;
  } finally {
    extracting.delete(sessionId);
  }
}

function addUsage(s: Session, u: Usage) {
  s.usage.calls += u.calls;
  s.usage.inputTokens += u.inputTokens;
  s.usage.outputTokens += u.outputTokens;
  s.usage.costUsd += u.costUsd;
}

export function isExtracting(sessionId: string) {
  return extracting.has(sessionId);
}

/** Import notes text through the same pipeline, without session anchors. */
export async function importNotes(name: string, text: string, fileId?: string): Promise<{ source: NotesSource; stats: MergeStats }> {
  const file = fileId ? getFile(fileId) : null;
  if (fileId && !file) throw new Error("That file could not be found. Upload it again.");
  if (file && file.kind !== "text") {
    const { blocks } = await filesFor([file.id], getSettings());
    const source: NotesSource = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      name: name.trim().slice(0, 120) || file.name,
      importedAt: new Date().toISOString(),
      chars: file.size,
    };
    const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const stats = await extractInto(`notes:${source.id}`, "", usage, blocks);
    saveNotesSources([...listNotesSources(), source]);
    return { source, stats };
  }
  const body = text.trim();
  if (!body) throw new Error("The notes are empty.");
  if (body.length > 400_000) throw new Error("Notes are limited to 400,000 characters per import.");
  const source: NotesSource = {
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    name: name.trim().slice(0, 120) || "Untitled notes",
    importedAt: new Date().toISOString(),
    chars: body.length,
  };
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const stats = await extractInto(`notes:${source.id}`, body, usage);
  saveNotesSources([...listNotesSources(), source]);
  return { source, stats };
}
