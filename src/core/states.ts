// Structure for the prober's knowledge-state notes, for display. The notes are written
// for the agents as prose with capitalised section labels ("HELD FIRMLY:", "MISSING:")
// and enumerated points ("(1) …", "(a) …"); this turns them into labelled groups of
// short headlines with the supporting evidence kept separately.

export type StateStatus = "held" | "partial" | "missing" | "new" | "other";

export interface StateItem {
  /** First sentence: the claim itself. */
  text: string;
  /** The rest: evidence and nuance. */
  detail?: string;
}

export interface StateSection {
  label: string;
  status: StateStatus;
  items: StateItem[];
}

export interface ParsedStates {
  /** Text before the first label or enumerated point. */
  lead?: string;
  /** Points that appear before any label (e.g. a goal's "(a) … (b) …" list). */
  items: StateItem[];
  sections: StateSection[];
}

const LABEL = /\b([A-Z][A-Z\- ]{2,}[A-Z](?: \([^)]{1,40}\))?):\s*/;
const MARKER = /(?:^|\s)\((\d{1,2}|[a-z])\)\s+/g;
/** Sentence ends: ".", "!" or "?" not part of "...", followed by a capital. */
const SENTENCE_END = /(?<!\.)[.!?](?!\.)\s+(?=[A-Z"'(])/g;

const STATUS_NAMES: Record<Exclude<StateStatus, "other">, string> = {
  held: "Already solid",
  partial: "Half there",
  missing: "Missing",
  new: "New to you",
};

/** Order matters: "NOT YET ENCOUNTERED (assume missing)" is new; "HALF-HELD" is partial. */
export function statusOf(label: string): StateStatus {
  const l = label.toUpperCase();
  if (/NOT YET|NEW TO|UNSEEN|NEVER|UNENCOUNTERED/.test(l)) return "new";
  if (/HALF|PARTIAL|SHAKY|WEAK|FRAGILE|UNSURE|EMERGING/.test(l)) return "partial";
  if (/MISSING|GAP|WRONG|MISCONCEPTION|LACK|ABSENT/.test(l)) return "missing";
  if (/HELD|SOLID|FIRM|KNOWS|STRONG|SECURE|CONFIDENT/.test(l)) return "held";
  return "other";
}

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

function clean(t: string): string {
  return t
    .trim()
    .replace(/[;,]\s*(?:and|or)?$/i, "")
    .replace(/\s+(?:and|or)$/i, "")
    .trim();
}

/** Split off the first sentence, never inside parentheses or quotes. */
function toItem(raw: string): StateItem {
  const t = clean(raw).replace(/^\((?:\d{1,2}|[a-z])\)\s+/, "");
  for (const m of t.matchAll(SENTENCE_END)) {
    const head = t.slice(0, m.index! + 1);
    const open = (head.match(/\(/g) ?? []).length - (head.match(/\)/g) ?? []).length;
    const quotes = (head.match(/'/g) ?? []).length - (head.match(/\w'\w/g) ?? []).length;
    if (open > 0 || quotes % 2) continue;
    const detail = t.slice(m.index! + m[0].length).trim();
    return detail ? { text: head, detail } : { text: head };
  }
  return { text: t };
}

/** Split a chunk into an optional lead and its points. */
function splitPoints(chunk: string): { lead?: string; points: string[] } {
  const text = chunk.trim();
  const hits = [...text.matchAll(MARKER)];
  if (hits.length >= 2) {
    const lead = text.slice(0, hits[0].index).trim();
    const points = hits.map((h, i) => text.slice(h.index! + h[0].length, i + 1 < hits.length ? hits[i + 1].index : undefined));
    return { lead: lead || undefined, points };
  }
  const parts = text.split(/;\s+/);
  if (parts.length >= 3) return { points: parts };
  return { points: text ? [text] : [] };
}

export function parseStates(text: string): ParsedStates {
  const parts = (text ?? "").split(LABEL);
  const head = splitPoints(parts[0] ?? "");
  const out: ParsedStates = { lead: head.lead ?? (head.points.length === 1 ? clean(head.points[0]) : undefined), items: [], sections: [] };
  if (head.points.length > 1) {
    out.items = head.points.map(toItem).filter((i) => i.text);
    // "…At the end it should feel obvious that:" only introduces the list; the card has its own heading.
    out.lead = out.lead?.replace(/(?:^|(?<=[.!?])\s+)[^.!?]*:\s*$/, "").trim() || undefined;
  }
  for (let i = 1; i < parts.length; i += 2) {
    const raw = parts[i].trim();
    const status = statusOf(raw);
    const { lead, points } = splitPoints(parts[i + 1] ?? "");
    const items = [...(lead ? [lead] : []), ...points].map(toItem).filter((it) => it.text);
    if (!items.length) continue;
    out.sections.push({ label: status === "other" ? titleCase(raw) : STATUS_NAMES[status], status, items });
  }
  return out;
}
