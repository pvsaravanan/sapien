import fs from "node:fs";
import path from "node:path";
import type { Graph, Job, NotesSource, Session, Settings } from "../core/types";
import { DEFAULT_SETTINGS } from "./defaults";

/** All mutable state lives under SAPIEN_DATA_DIR (default ./data). Plain JSON files
 *  you can inspect. One server process should own a data directory. */
export const DATA_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.SAPIEN_DATA_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data"));

const dirs = {
  sessions: path.join(DATA_DIR, "sessions"),
  jobs: path.join(DATA_DIR, "jobs"),
  graph: path.join(DATA_DIR, "graph"),
};

function ensure(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write via temp file + rename so a crash never leaves a half-written record. */
function writeJson(file: string, value: unknown) {
  ensure(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
function safeId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid id: ${id}`);
  return id;
}

// ─── sessions ───────────────────────────────────────────────────────────────

export function getSession(id: string): Session | null {
  return readJson<Session>(path.join(dirs.sessions, `${safeId(id)}.json`));
}

export function saveSession(s: Session) {
  s.updatedAt = new Date().toISOString();
  writeJson(path.join(dirs.sessions, `${safeId(s.id)}.json`), s);
}

export function listSessions(): Session[] {
  ensure(dirs.sessions);
  return fs
    .readdirSync(/*turbopackIgnore: true*/ dirs.sessions)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Session>(path.join(dirs.sessions, f)))
    .filter((s): s is Session => !!s)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteSession(id: string) {
  fs.rmSync(path.join(dirs.sessions, `${safeId(id)}.json`), { force: true });
  for (const j of listJobs(id)) fs.rmSync(path.join(dirs.jobs, `${j.id}.json`), { force: true });
}

// ─── jobs ───────────────────────────────────────────────────────────────────

export function getJob(id: string): Job | null {
  return readJson<Job>(path.join(dirs.jobs, `${safeId(id)}.json`));
}
export function saveJob(j: Job) {
  writeJson(path.join(dirs.jobs, `${safeId(j.id)}.json`), j);
}
export function listJobs(sessionId?: string): Job[] {
  ensure(dirs.jobs);
  return fs
    .readdirSync(/*turbopackIgnore: true*/ dirs.jobs)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Job>(path.join(dirs.jobs, f)))
    .filter((j): j is Job => !!j && (!sessionId || j.sessionId === sessionId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ─── graph ──────────────────────────────────────────────────────────────────

const graphFile = () => path.join(dirs.graph, "graph.json");
const notesFile = () => path.join(dirs.graph, "notes-sources.json");

export function getGraph(): Graph {
  return readJson<Graph>(graphFile()) ?? { propositions: [], chains: [] };
}
export function saveGraph(g: Graph) {
  writeJson(graphFile(), g);
}
export function listNotesSources(): NotesSource[] {
  return readJson<NotesSource[]>(notesFile()) ?? [];
}
export function saveNotesSources(list: NotesSource[]) {
  writeJson(notesFile(), list);
}

// ─── settings ───────────────────────────────────────────────────────────────

const settingsFile = () => path.join(DATA_DIR, "settings.json");

export function getSettings(): Settings {
  const saved = readJson<Partial<Settings>>(settingsFile()) ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    models: { ...DEFAULT_SETTINGS.models, ...(saved.models ?? {}) },
    effort: { ...DEFAULT_SETTINGS.effort, ...(saved.effort ?? {}) },
    workers: { ...DEFAULT_SETTINGS.workers, ...(saved.workers ?? {}) },
    research: { ...DEFAULT_SETTINGS.research, ...(saved.research ?? {}) },
    providers: Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS.providers).map(([k, v]) => {
        const s = (saved.providers as Settings["providers"] | undefined)?.[k as keyof Settings["providers"]];
        return [k, { path: s?.path || v.path, models: { ...(s?.models ?? {}) }, fallbackModels: s?.fallbackModels ?? [], node: s?.node ?? "" }];
      }),
    ) as Settings["providers"],
  };
}
export function saveSettings(s: Settings) {
  writeJson(settingsFile(), s);
}

// ─── secrets (search API keys; never sent to the browser) ───────────────────

export interface Secrets {
  brave?: string;
  tavily?: string;
}
const secretsFile = () => path.join(DATA_DIR, "secrets.json");

export function getSecrets(): Secrets {
  return readJson<Secrets>(secretsFile()) ?? {};
}
export function saveSecrets(s: Secrets) {
  writeJson(secretsFile(), s);
  try {
    fs.chmodSync(secretsFile(), 0o600);
  } catch {}
}
