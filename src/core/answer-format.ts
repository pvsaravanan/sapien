// Tidies model answers written as one dense paragraph (older sessions, or a model that
// ignored the formatting rules): grading criteria are split out, inline "(1) … (2) …"
// enumerations become lists, and SQL statements move into code blocks. Pure and
// conservative: text that already has Markdown structure is left alone.

/** Sentences that grade the answer rather than give it. */
const RUBRIC: RegExp[] = [
  /\bthe learner\b/i,
  /^(?:the |an |their |your )?answer (?:is|counts as|should be marked) (?:right|correct|acceptable|fine|partial)\b/i,
  /^(?:accept|count it|mark it|grade it|give credit)\b/i,
  /^(?:full|partial) (?:credit|marks)\b/i,
  /^(?:the )?exact wording\b/i,
  /^(?:the )?wording (?:doesn't|does not|need not)\b/i,
  /^they (?:don't|do not|needn't|need not|don't have to|do not have to)\b/i,
];

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z(*`"'])/;
const SQL_START = String.raw`SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE`;
/** One complete statement ending in ";", never spanning the start of another. */
const SQL_STATEMENT = new RegExp(String.raw`\b(?:${SQL_START})\b(?:(?!\b(?:${SQL_START})\b)[^;\`\n])*;`, "g");
const SQL_KEYWORD = /(?<![`\w])(SELECT|FROM|WHERE|GROUP BY|ORDER BY|HAVING|JOIN|LEFT JOIN|INNER JOIN|ON|SUM|COUNT|AVG|MIN|MAX|INSERT INTO|INSERT|UPDATE|SET|VALUES|DELETE FROM|DELETE|LIMIT|DISTINCT)(?![`\w])/g;

const isRubric = (sentence: string) => RUBRIC.some((r) => r.test(sentence.trim()));

/** Split rubric sentences out of plain prose paragraphs. */
export function splitRubric(text: string): { answer: string; notes: string } {
  const notes: string[] = [];
  const answer = mapProse(text, (para) => {
    const kept: string[] = [];
    for (const s of para.split(SENTENCE_SPLIT)) (isRubric(s) ? notes : kept).push(s.trim());
    return kept.join(" ");
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { answer, notes: notes.join(" ") };
}

/** Learner-facing model answer: rubric removed, lists and code restored. */
export function formatModelAnswer(text: string): string {
  const { answer } = splitRubric(text);
  return mapProse(answer, (para) =>
    enumerate(para)
      .split("\n\n")
      .map((chunk) => {
        // In a list, statements stay inline; in a paragraph they become a code block under it.
        if (/^\d+\. /.test(chunk)) return codeKeywords(chunk.replace(SQL_STATEMENT, (stmt) => `\`${stmt.trim()}\``));
        const blocks: string[] = [];
        const body = codeKeywords(chunk.replace(SQL_STATEMENT, (stmt) => (blocks.push(stmt.trim()), "the query below")));
        return [body, ...blocks.map((b) => "```sql\n" + b + "\n```")].join("\n\n");
      })
      .join("\n\n"),
  ).trim();
}

/** Apply fn to plain prose paragraphs only (not code, lists, tables, headings, quotes). */
function mapProse(text: string, fn: (para: string) => string): string {
  const parts = text.split(/(```[\s\S]*?```)/);
  return parts
    .map((part) => {
      if (part.startsWith("```")) return part;
      return part
        .split(/\n{2,}/)
        .map((para) => {
          const p = para.trim();
          if (!p || /^(?:#|>|\||[-*+] |\d+\. )/.test(p) || p.includes("\n")) return para;
          return fn(p);
        })
        .join("\n\n");
    })
    .join("");
}

/** "Lead. (1) a. (2) b. (3) c. More." → lead, a numbered list, then the rest. */
function enumerate(para: string): string {
  const marker = /(?:^|\s)\((\d{1,2})\)\s+/g;
  const hits = [...para.matchAll(marker)];
  if (hits.length < 2 || hits[0][1] !== "1" || hits[1][1] !== "2") return para;
  const lead = para.slice(0, hits[0].index).trim();
  const items = hits.map((h, i) => para.slice(h.index! + h[0].length, i + 1 < hits.length ? hits[i + 1].index : undefined).trim());
  // The last item ends at its first sentence; what follows is the conclusion.
  const lastSentences = items[items.length - 1].split(SENTENCE_SPLIT);
  items[items.length - 1] = lastSentences[0];
  const rest = lastSentences.slice(1).join(" ").trim();
  return [lead, items.map((it, i) => `${i + 1}. ${it}`).join("\n"), rest].filter(Boolean).join("\n\n");
}

/** Uppercase SQL keywords in prose → inline code (outside existing code spans). */
function codeKeywords(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((seg) => (seg.startsWith("`") ? seg : seg.replace(SQL_KEYWORD, "`$1`")))
    .join("");
}
