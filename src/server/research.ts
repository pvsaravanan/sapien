import type { ResearchSettings } from "../core/types";
import { getSecrets } from "./store";

/** Sapien's own web research, used when the selected CLI has no live web search.
 *  Search → fetch a few pages → hand their text to the research agent, which must
 *  answer from those sources and cite only their URLs.
 *  Backends: Wikipedia (no key), Brave Search API or Tavily (API key in data/secrets.json). */

export interface Source {
  title: string;
  url: string;
  text: string;
}

const UA = "Sapien/0.1 (local learning app)";
const MAX_SOURCES = 4;
const MAX_CHARS_PER_SOURCE = 8000;

type Fetch = typeof fetch;
const g = globalThis as unknown as { __sapienFetch?: Fetch };
/** Tests can replace network access. */
export function setResearchFetch(f: Fetch | null) {
  g.__sapienFetch = f ?? undefined;
}
const http = (input: string, init?: RequestInit) => (g.__sapienFetch ?? fetch)(input, init);

/** Only public http(s) URLs: no localhost, private ranges, or bare hostnames. */
export function isPublicUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(".") || h.endsWith(".local") || h.endsWith(".internal") || h === "localhost") return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return false;
  return true;
}

/** Readable text from HTML: drop scripts, styles and page chrome; decode common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export async function fetchPage(url: string): Promise<string | null> {
  if (!isPublicUrl(url)) return null;
  try {
    const res = await http(url, { headers: { "user-agent": UA, accept: "text/html,text/plain" }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
    if (!res.ok || (res.url && !isPublicUrl(res.url))) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/(html|plain)/.test(type)) return null;
    const body = (await res.text()).slice(0, 1_500_000);
    const text = type.includes("html") ? htmlToText(body) : body;
    return text.slice(0, MAX_CHARS_PER_SOURCE) || null;
  } catch {
    return null;
  }
}

async function wikipedia(query: string): Promise<Source[]> {
  const api = "https://en.wikipedia.org/w/api.php";
  const search = await http(`${api}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${MAX_SOURCES}&format=json&utf8=1`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!search.ok) throw new Error(`Wikipedia search failed (${search.status})`);
  const titles = ((await search.json()) as { query?: { search?: { title: string }[] } }).query?.search?.map((r) => r.title) ?? [];
  const out: Source[] = [];
  for (const title of titles.slice(0, MAX_SOURCES)) {
    const r = await http(`${api}?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) continue;
    const pages = ((await r.json()) as { query?: { pages?: Record<string, { title: string; extract?: string }> } }).query?.pages ?? {};
    const page = Object.values(pages)[0];
    if (page?.extract) out.push({ title: page.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`, text: page.extract.slice(0, MAX_CHARS_PER_SOURCE) });
  }
  return out;
}

async function brave(query: string, key: string): Promise<Source[]> {
  const res = await http(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, {
    headers: { accept: "application/json", "x-subscription-token": key },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Brave Search failed (${res.status})`);
  const results = ((await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } }).web?.results ?? [];
  return withPages(results.map((r) => ({ title: r.title, url: r.url, snippet: htmlToText(r.description ?? "") })));
}

async function tavily(query: string, key: string): Promise<Source[]> {
  const res = await http("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: 6, search_depth: "basic" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Tavily search failed (${res.status})`);
  const results = ((await res.json()) as { results?: { title: string; url: string; content?: string }[] }).results ?? [];
  return withPages(results.map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" })));
}

/** Fetch the top results' pages; fall back to the search snippet when a page won't load. */
async function withPages(results: { title: string; url: string; snippet: string }[]): Promise<Source[]> {
  const top = results.filter((r) => isPublicUrl(r.url)).slice(0, MAX_SOURCES);
  const pages = await Promise.all(top.map((r) => fetchPage(r.url)));
  return top
    .map((r, i) => ({ title: r.title, url: r.url, text: pages[i] ?? r.snippet }))
    .filter((s) => s.text.trim().length > 40);
}

/** Search for a research brief and return readable source excerpts. */
export async function gatherSources(title: string, brief: string, cfg: ResearchSettings): Promise<{ sources: Source[]; backend: string; note?: string }> {
  const query = `${title} ${brief}`.replace(/\s+/g, " ").slice(0, 200);
  const keys = getSecrets();
  try {
    if (cfg.search === "brave" && keys.brave) return { sources: await brave(query, keys.brave), backend: "Brave Search" };
    if (cfg.search === "tavily" && keys.tavily) return { sources: await tavily(query, keys.tavily), backend: "Tavily" };
    const note = cfg.search !== "wikipedia" ? `No ${cfg.search} API key is set, so Wikipedia was searched instead.` : undefined;
    let sources = await wikipedia(title.slice(0, 120));
    if (sources.length < 2) sources = [...sources, ...(await wikipedia(query))].filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i);
    return { sources: sources.slice(0, MAX_SOURCES), backend: "Wikipedia", note };
  } catch (err) {
    return { sources: [], backend: cfg.search, note: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
