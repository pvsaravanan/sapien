import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId, Settings } from "../core/types";
import { claudeCliEngine, type Engine, EngineError, type EngineRequest, type EngineResult } from "./engine";
import type { ContentBlock } from "./files";
import { DATA_DIR } from "./store";

/** Non-Claude coding-agent CLIs, driven headlessly. Each adapter follows the tool's
 *  documented non-interactive interface:
 *   - Codex:        `codex exec` (stdin prompt, --output-schema, -o, --json, -i)
 *   - Gemini CLI:   `gemini -p … --output-format stream-json --approval-mode plan`
 *   - Copilot CLI:  `copilot -p … -s --no-ask-user` (also reachable as `gh copilot --`)
 *   - OpenCode:     `opencode run … --format json -f file`
 *   - Command Code: `cmd -p … --output-format json` (read-only by default in headless mode)
 *  Only Claude Code and Codex enforce a JSON Schema natively; for the others the schema is
 *  stated in the prompt and the JSON object is extracted from the reply, after which the
 *  normal heal → validate → corrective-retry pipeline applies. Every run happens in an empty
 *  temporary directory holding only the learner's attachments. */

export { PROVIDERS } from "../core/provider-info";
import { PROVIDERS } from "../core/provider-info";

// ─── JSON extraction from free text ─────────────────────────────────────────

/** First complete JSON object in `text` (handles ```json fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  for (let start = t.indexOf("{"); start !== -1; start = t.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new EngineError("The model did not reply with a JSON object.");
}

/** Every JSON object that appears in `text`, in order. */
export function jsonObjectsIn(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const t = text;
  for (let start = t.indexOf("{"); start !== -1; ) {
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) break;
    try {
      const v = JSON.parse(t.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out.push(v);
        start = t.indexOf("{", end + 1);
        continue;
      }
    } catch {
      /* not JSON at this brace; try the next one */
    }
    start = t.indexOf("{", start + 1);
  }
  return out;
}

function deepStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    if (v.includes("{")) out.push(v);
  } else if (Array.isArray(v)) v.forEach((x) => deepStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => deepStrings(x, out));
  return out;
}

/** Find the answer object without relying on one exact output format: try the adapter's
 *  own reading, then every string inside every JSON event line, then the raw output; pick
 *  the object that best matches the schema's top-level fields. */
export function findAnswer(text: string, stdout: string, schema: object): unknown {
  const props = Object.keys((schema as { properties?: Record<string, unknown> }).properties ?? {});
  const candidates: string[] = [text];
  for (const line of stdout.split("\n")) {
    const e = safeJson(line.trim());
    if (e) candidates.push(...deepStrings(e));
  }
  candidates.push(stdout);
  let best: { obj: Record<string, unknown>; score: number } | null = null;
  for (const c of candidates) {
    if (!c?.trim()) continue;
    const objs = [...jsonObjectsIn(c.replace(/```(?:json)?/gi, ""))];
    for (const obj of objs) {
      const score = props.length ? props.filter((k) => k in obj).length : 1;
      if (score > 0 && (!best || score > best.score)) best = { obj, score };
    }
    if (best && props.length && best.score === props.length) break;
  }
  const needed = props.length ? Math.max(1, Math.ceil(props.length * 0.3)) : 1;
  if (!best || best.score < needed) throw new EngineError("The model did not reply with a JSON object matching the expected format.");
  return best.obj;
}

/** OpenAI-style strict schemas: every object closed, unsupported keywords removed. */
export function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (["minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "default", "$schema"].includes(k)) continue;
    out[k] = strictSchema(v);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

const REFUSAL_RE = /safeguards flagged|usage policy|content policy|can't respond to this message|safety (?:system|filter)/i;

// ─── generic CLI runner ─────────────────────────────────────────────────────

interface RunState {
  text: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  error?: string;
  /** Set when the adapter got the final answer from a structured field. */
  final?: string;
}

interface Adapter {
  /** argv after the executable, built per request in the temp dir. */
  args(req: EngineRequest, cwd: string, files: StagedFile[], prompt: string): string[];
  /** What to write to stdin (undefined = nothing). */
  stdin?(prompt: string): string | undefined;
  /** Handle one stdout line; return text to append to the streamed answer. */
  line?(line: string, st: RunState): void;
  /** Final text after exit (e.g. read an -o file). */
  finish?(st: RunState, stdout: string, cwd: string): string;
}

interface StagedFile {
  name: string;
  path: string;
  kind: "pdf" | "image" | "text";
}

/** Split "gh copilot" or a path into executable + leading args (paths may contain spaces). */
export function splitCommand(cmd: string): { bin: string; pre: string[] } {
  const c = cmd.trim();
  if (fs.existsSync(c)) return { bin: c, pre: [] };
  const [bin, ...pre] = c.split(/\s+/);
  return { bin: resolveBin(bin), pre };
}

/** Global npm bin dirs of every nvm-installed Node, newest first. */
function nvmBinDirs(): string[] {
  const root = path.join(os.homedir(), ".nvm", "versions", "node");
  try {
    return fs
      .readdirSync(root)
      .sort((a, b) => nodeMajorFromName(b) - nodeMajorFromName(a) || b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(root, v, "bin"));
  } catch {
    return [];
  }
}
const nodeMajorFromName = (s: string) => Number(/v?(\d+)\./.exec(s)?.[1] ?? 0);

const versionCache = new Map<string, number>();
function nodeMajor(bin: string): number {
  if (versionCache.has(bin)) return versionCache.get(bin)!;
  let major = 0;
  try {
    const r = spawnSync(bin, ["--version"], { timeout: 3000, encoding: "utf8" });
    major = Number(/v(\d+)\./.exec(r.stdout ?? "")?.[1] ?? 0);
  } catch {
    major = 0;
  }
  versionCache.set(bin, major);
  return major;
}

/** Minimum Node major for JavaScript-based CLIs (from each package's engines field). */
const MIN_NODE: Partial<Record<ProviderId, number>> = { codex: 16, gemini: 20, copilot: 22, commandcode: 22 };

function isNodeScript(file: string): boolean {
  if (/\.(c|m)?js$/.test(file)) return true;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(128);
    fs.readSync(fd, buf, 0, 128, 0);
    fs.closeSync(fd);
    const head = buf.toString("utf8");
    return head.startsWith("#!") && /\bnode\b/.test(head.split("\n")[0]);
  } catch {
    return false;
  }
}

/** Node binaries on this machine, best candidates first. */
function nodeCandidates(): string[] {
  const list = [
    process.execPath,
    ...(process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "node")),
    ...nvmBinDirs().map((d) => path.join(d, "node")),
    ...["/opt/homebrew/opt", "/usr/local/opt"].flatMap((root) => {
      try {
        return fs.readdirSync(root).filter((d) => /^node(@\d+)?$/.test(d)).map((d) => path.join(root, d, "bin", "node"));
      } catch {
        return [];
      }
    }),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    path.join(os.homedir(), ".volta", "bin", "node"),
  ];
  return [...new Set(list)].filter((p) => fs.existsSync(p));
}

/** How to launch a CLI. JavaScript CLIs whose Node requirement the default `node` does
 *  not meet are run with a suitable Node found on this machine (or the configured one). */
export function runnerFor(command: string, id: ProviderId, nodeOverride?: string): { bin: string; pre: string[]; node?: string; need?: number } {
  const { bin, pre } = splitCommand(command);
  if (!fs.existsSync(bin)) return { bin, pre };
  let real = bin;
  try {
    real = fs.realpathSync(bin);
  } catch {
    /* keep bin */
  }
  if (!isNodeScript(real)) return { bin, pre };
  const need = MIN_NODE[id] ?? 18;
  const explicit = nodeOverride?.trim();
  const sibling = path.join(path.dirname(bin), "node");
  const node = explicit || [sibling, ...nodeCandidates()].find((c) => fs.existsSync(c) && nodeMajor(c) >= need);
  if (!node) return { bin, pre, need };
  return { bin: node, pre: [real, ...pre], node, need };
}

export function resolveBin(name: string): string {
  if (name.includes(path.sep)) return name;
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, name)),
    ...nvmBinDirs().map((d) => path.join(d, name)),
    path.join(os.homedir(), ".local", "bin", name),
    path.join(os.homedir(), ".npm-global", "bin", name),
    path.join(os.homedir(), ".opencode", "bin", name),
    path.join("/opt/homebrew/bin", name),
    path.join("/usr/local/bin", name),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? name;
}

/** Write attachment blocks into the temp dir so CLIs can attach or read them. */
function stageFiles(blocks: ContentBlock[] | undefined, cwd: string): { staged: StagedFile[]; inline: string } {
  const staged: StagedFile[] = [];
  const inline: string[] = [];
  let pendingName = "";
  let n = 0;
  for (const b of blocks ?? []) {
    if (b.type === "text" && b.text.startsWith("=== LEARNER FILE")) {
      pendingName = /: (.+?) \(/.exec(b.text)?.[1] ?? `file-${n + 1}`;
      inline.push(b.text);
      continue;
    }
    if (b.type === "text") {
      inline.push(b.text); // text files travel inline, as with Claude
      continue;
    }
    n++;
    const safe = `${n}-${pendingName.replace(/[^\w.\-]/g, "_") || (b.type === "image" ? "image.png" : "document.pdf")}`;
    const file = path.join(cwd, "files", safe);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(b.source.data, "base64"));
    staged.push({ name: pendingName, path: file, kind: b.type === "image" ? "image" : "pdf" });
    inline.push(`(attached as ${path.relative(cwd, file)})`);
  }
  return { staged, inline: inline.join("\n") };
}

function composePrompt(req: EngineRequest, filesText: string, schemaInPrompt: boolean): string {
  return [
    `SYSTEM INSTRUCTIONS (follow these exactly; they define your role):\n${req.system}`,
    filesText ? `LEARNER FILES\n${filesText}` : "",
    req.prompt,
    schemaInPrompt
      ? `RESPONSE FORMAT\nReply with ONLY one JSON object that matches this JSON Schema: no prose before or after it and no code fences. Every property listed must be present; use null where a field does not apply.\n${JSON.stringify(req.schema)}`
      : "Your final reply is the JSON object described by the output schema.",
  ]
    .filter(Boolean)
    .join("\n\n=====\n\n");
}

/** Save the raw output of a failed run so it can be inspected or shared. */
function saveFailure(id: string, info: { argv: string[]; code: number | null; stdout: string; stderr: string; error: string }): string {
  const dir = path.join(DATA_DIR, "logs");
  const file = path.join(dir, `${id}-last-failure.txt`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const argv = info.argv.map((a) => (a.length > 300 ? `${a.slice(0, 300)}…[${a.length} chars]` : a));
    fs.writeFileSync(
      file,
      [`time: ${new Date().toISOString()}`, `error: ${info.error}`, `exit code: ${info.code}`, `command: ${argv.join(" ")}`, "", "--- stderr (tail) ---", info.stderr.slice(-8000), "", "--- stdout (tail) ---", info.stdout.slice(-40000)].join("\n"),
    );
  } catch {
    /* logging must never break a run */
  }
  return path.relative(process.cwd(), file);
}

function cliEngine(id: ProviderId, command: string, adapter: Adapter, schemaInPrompt: boolean, nodeOverride?: string): Engine {
  return (req) =>
    new Promise<EngineResult>((resolve, reject) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sapien-"));
      const { staged, inline } = stageFiles(req.files, cwd);
      const prompt = composePrompt(req, inline, schemaInPrompt);
      const runner = runnerFor(command, id, nodeOverride);
      const { bin, pre } = runner;
      const args = [...pre, ...adapter.args(req, cwd, staged, prompt)];
      const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CI: "1" };
      const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      const st: RunState = { text: "", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      let stdout = "";
      let buffer = "";
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        fn();
        fs.rmSync(cwd, { recursive: true, force: true });
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new EngineError(`${bin} timed out after ${Math.round((req.timeoutMs ?? 600_000) / 1000)}s`)));
      }, req.timeoutMs ?? 10 * 60_000);
      const onAbort = () => {
        child.kill("SIGTERM");
        finish(() => reject(new EngineError("Aborted")));
      };
      req.signal?.addEventListener("abort", onAbort);
      const emit = () => {
        try {
          req.onPartial?.(st.text);
        } catch {
          /* display only */
        }
      };
      child.stdout.on("data", (d) => {
        const s = String(d);
        stdout += s;
        if (!adapter.line) {
          st.text = stdout;
          emit();
          return;
        }
        buffer += s;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          adapter.line(buffer.slice(0, nl), st);
          buffer = buffer.slice(nl + 1);
          emit();
        }
      });
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
      child.on("error", (err) => finish(() => reject(new EngineError(`Could not start ${bin} (${err.message}). Is it installed and on PATH?`))));
      child.on("close", (code) =>
        finish(() => {
          if (buffer && adapter.line) adapter.line(buffer, st);
          let text = "";
          try {
            text = adapter.finish ? adapter.finish(st, stdout, cwd) : (st.final ?? st.text);
          } catch {
            text = st.final ?? st.text;
          }
          const name = PROVIDERS[id].name;
          const detail = (st.error ?? (text.trim() ? "" : stderr.trim())).slice(-600);
          const nodeHint = runner.need && !runner.node ? ` ${name} needs Node.js ${runner.need} or newer and none was found; install it (e.g. \`nvm install ${runner.need}\`) or set its path in Settings.` : "";
          if (st.error || (!text.trim() && code !== 0)) {
            const msg = `${name} error: ${detail || `exited with code ${code}`}.${nodeHint}`;
            const log = saveFailure(id, { argv: args, code, stdout, stderr, error: msg });
            return reject(new EngineError(`${msg} Raw output: ${log}`, REFUSAL_RE.test(detail) ? "refusal" : "other"));
          }
          try {
            resolve({ output: findAnswer(text, stdout, req.schema), usage: st.usage });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const log = saveFailure(id, { argv: args, code, stdout, stderr, error: msg });
            reject(new EngineError(`${name}: ${msg} Raw output: ${log}`));
          }
        }),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(adapter.stdin?.(prompt) ?? "");
    });
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
function safeJson(line: string): Record<string, any> | null {
  if (!line.startsWith("{")) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
const codexEffort = (e?: string) => (e === "low" || e === "medium" || e === "high" ? e : e ? "high" : undefined);

// ─── adapters ───────────────────────────────────────────────────────────────

const codex: Adapter = {
  args(req, cwd, files) {
    fs.writeFileSync(path.join(cwd, "schema.json"), JSON.stringify(strictSchema(req.schema)));
    const effort = codexEffort(req.effort);
    return [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color", "never",
      "-s", "read-only",
      "--output-schema", path.join(cwd, "schema.json"),
      "-o", path.join(cwd, "last-message.txt"),
      ...(req.model ? ["-m", req.model] : []),
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      ...files.filter((f) => f.kind === "image").flatMap((f) => ["-i", f.path]),
      "-",
    ];
  },
  stdin: (prompt) => prompt,
  line(line, st) {
    const e = safeJson(line);
    if (!e) return;
    const item = e.item ?? {};
    if ((e.type === "item.completed" || e.type === "item.updated") && item.type === "agent_message" && typeof item.text === "string") st.text = item.text;
    if (e.type === "turn.completed" && e.usage) {
      st.usage.inputTokens += num(e.usage.input_tokens) + num(e.usage.cached_input_tokens);
      st.usage.outputTokens += num(e.usage.output_tokens);
    }
    if (e.type === "turn.failed" || e.type === "error") st.error = String(e.error?.message ?? e.message ?? "Codex reported an error");
  },
  finish(st, _out, cwd) {
    const f = path.join(cwd, "last-message.txt");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : st.text;
  },
};

const gemini: Adapter = {
  // The full prompt goes on stdin; -p text is appended to it (documented behaviour).
  args(req, cwd, files) {
    const refs = files.map((f) => `@${path.relative(cwd, f.path)}`).join(" ");
    return [
      "-p", `Follow the instructions above exactly.${refs ? ` Attached files: ${refs}` : ""}`,
      "--output-format", "stream-json",
      "--approval-mode", "plan",
      ...(req.model ? ["-m", req.model] : []),
    ];
  },
  line(line, st) {
    const e = safeJson(line);
    if (!e) return;
    if (e.type === "message" && e.role === "assistant") {
      const c = typeof e.content === "string" ? e.content : Array.isArray(e.content) ? e.content.map((x: any) => x?.text ?? "").join("") : "";
      st.text = e.delta ? st.text + c : c || st.text;
    } else if (e.type === "result") {
      const u = e.stats ?? {};
      st.usage.inputTokens += num(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens);
      st.usage.outputTokens += num(u.output_tokens ?? u.outputTokens ?? u.candidates_tokens);
      if (typeof e.response === "string" && e.response.trim()) st.final = e.response;
      if (e.status === "error" || e.error) st.error = String(e.error?.message ?? e.error ?? "Gemini CLI reported an error");
    } else if (e.type === "error" && e.severity !== "warning" && e.fatal) {
      st.error = String(e.message ?? "Gemini CLI error");
    }
  },
  stdin: (prompt) => prompt,
  finish: (st) => st.final ?? st.text,
};

/** Long prompts exceed argv limits; hand them over as a file in the temp dir. */
function promptFile(cwd: string, prompt: string): string {
  const f = path.join(cwd, "PROMPT.md");
  fs.writeFileSync(f, prompt);
  return f;
}

const copilot: Adapter = {
  args(req, cwd, files, prompt) {
    promptFile(cwd, prompt);
    return [
      "-p", "Read @PROMPT.md and follow its instructions exactly. Your reply must be only the JSON object it asks for.",
      "-s",
      "--no-ask-user",
      "--no-custom-instructions",
      "--deny-tool", "shell",
      "--deny-tool", "write",
      ...(req.model ? ["--model", req.model] : []),
      ...(req.effort ? ["--reasoning-effort", req.effort === "xhigh" || req.effort === "max" ? "high" : req.effort] : []),
      ...files.flatMap((f) => ["--attachment", f.path]),
    ];
  },
};

const opencode: Adapter = {
  args(req, cwd, files, prompt) {
    const pf = promptFile(cwd, prompt);
    return [
      "run",
      "--format", "json",
      "--pure",
      ...(req.model ? ["-m", req.model] : []),
      ...(req.effort ? ["--variant", req.effort] : []),
      "-f", pf,
      ...files.flatMap((f) => ["-f", f.path]),
      "--",
      "Follow the instructions in the attached PROMPT.md exactly. Your reply must be only the JSON object it asks for.",
    ];
  },
  line(line, st) {
    const e = safeJson(line);
    if (!e) return;
    const part = e.part ?? e.properties?.part ?? {};
    if ((e.type === "text" || part.type === "text") && typeof (part.text ?? e.text) === "string") {
      st.text = part.text ?? e.text;
    }
    const tokens = part.tokens ?? e.tokens;
    if ((e.type === "step_finish" || part.type === "step-finish") && tokens) {
      st.usage.inputTokens += num(tokens.input) + num(tokens.cache?.read);
      st.usage.outputTokens += num(tokens.output);
      st.usage.costUsd += num(part.cost ?? e.cost);
    }
    if (e.type === "error") st.error = String(e.error?.data?.message ?? e.error?.message ?? e.message ?? "OpenCode error");
  },
};

const commandcode: Adapter = {
  args(req, _cwd, _files, _prompt) {
    return [
      "-p",
      "--output-format", "json",
      "--max-turns", "12",
      "--skip-onboarding",
      ...(req.model ? ["-m", req.model] : []),
      ...(req.effort ? ["--effort", req.effort === "xhigh" || req.effort === "max" ? "high" : req.effort] : []),
    ];
  },
  // Prompts can be long; Command Code reads the query from stdin when none is given.
  stdin: (prompt) => prompt,
  line(line, st) {
    const e = safeJson(line);
    if (!e) return;
    if (e.type === "result") {
      if (typeof e.finalText === "string") st.final = e.finalText;
      const u = e.usage ?? {};
      st.usage.inputTokens += num(u.inputTokens ?? u.input_tokens);
      st.usage.outputTokens += num(u.outputTokens ?? u.output_tokens);
      if (e.subtype === "error") st.error = String(e.error ?? e.finalText ?? "Command Code reported an error");
    } else if (e.type === "event") {
      const d = e.delta ?? e.data?.delta ?? e.text;
      if (typeof d === "string") st.text += d;
    }
  },
  finish: (st) => st.final ?? st.text,
};

const ADAPTERS: Record<Exclude<ProviderId, "claude">, Adapter> = { codex, gemini, copilot, opencode, commandcode };

/** The engine for the configured provider. */
export function engineFor(settings: Settings): Engine {
  if (settings.provider === "claude" || !ADAPTERS[settings.provider]) return claudeCliEngine(settings.claudePath);
  const id = settings.provider;
  const cfg = settings.providers[id];
  return cliEngine(id, cfg.path || PROVIDERS[id].defaultPath, ADAPTERS[id], PROVIDERS[id].schema === "prompted", cfg.node);
}

/** Model for a role under the configured provider (undefined = the CLI's default). */
export function modelFor(settings: Settings, role: keyof Settings["models"]): string | undefined {
  if (settings.provider === "claude") return settings.models[role];
  const m = settings.providers[settings.provider]?.models;
  return (m?.[role] || m?.default || "").trim() || undefined;
}

/** `--version` probe for the settings page (never triggers installs or logins). */
export function probe(command: string, id: ProviderId, nodeOverride?: string): Promise<{ ok: boolean; version: string | null; path: string; note?: string }> {
  const runner = id === "claude" ? { ...splitCommand(command), need: undefined, node: undefined } : runnerFor(command, id, nodeOverride);
  const { bin, pre } = runner;
  // `gh copilot --version` would offer to download Copilot; only probe gh itself then.
  const args = id === "copilot" && path.basename(bin) === "gh" ? ["--version"] : [...pre, "--version"];
  if (runner.need && !runner.node) {
    return Promise.resolve({ ok: false, version: null, path: bin, note: `needs Node.js ${runner.need}+` });
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
      let out = "";
      const t = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", () => (clearTimeout(t), resolve({ ok: false, version: null, path: bin })));
      child.on("close", (code) => {
        clearTimeout(t);
        const first = out.trim().split("\n")[0] ?? "";
        const notFound = /not found|not installed/i.test(out);
        const needNode = /needs Node\.?js (\d+)/i.exec(out);
        resolve({
          ok: code === 0 && !notFound && !needNode && !!first,
          version: code === 0 && !notFound && !needNode ? first : null,
          path: bin,
          note: needNode ? `needs Node.js ${needNode[1]}+` : runner.node ? `runs on ${runner.node}` : undefined,
        });
      });
    } catch {
      resolve({ ok: false, version: null, path: bin });
    }
  });
}
