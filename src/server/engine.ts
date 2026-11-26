import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Effort } from "../core/types";
import type { ContentBlock } from "./files";

export interface EngineRequest {
  /** Model name for the CLI; undefined = the CLI's default. */
  model?: string;
  effort?: Effort;
  system: string;
  prompt: string;
  /** JSON Schema the final answer must satisfy. */
  schema: object;
  /** Built-in CLI tools to allow (e.g. WebSearch). Default: none. */
  tools?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Learner files etc. sent ahead of the prompt as message content blocks. */
  files?: ContentBlock[];
  /** Called with the structured answer's JSON as it streams in (incomplete). */
  onPartial?: (partialJson: string) => void;
}

export interface EngineResult {
  output: unknown;
  /** inputTokens includes cache reads and writes; the split is reported where known. */
  usage: { inputTokens: number; outputTokens: number; costUsd: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

// ─── prompt blocks and cache points ─────────────────────────────────────────
// Each call is stateless, so the whole lesson is re-sent every turn. Prompts mark
// block boundaries, and one cache point after the part that only grows by
// appending (the stable head and the transcript). Claude Code receives these as
// separate content blocks with a cache breakpoint, so the next call reads that
// prefix from the prompt cache instead of paying for it again. Other CLIs get the
// plain text.

/** Starts a new content block. */
export const BLOCK = "\u0001";
/** Marks the end of the block before it as a cache breakpoint. */
export const CACHE_POINT = "\u0002";

export function promptBlocks(prompt: string): { text: string; cache: boolean }[] {
  const out: { text: string; cache: boolean }[] = [];
  for (const raw of prompt.split(BLOCK)) {
    const cache = raw.endsWith(CACHE_POINT);
    const text = raw.replaceAll(CACHE_POINT, "");
    if (text.trim()) out.push({ text, cache });
    else if (cache && out.length) out[out.length - 1].cache = true;
  }
  // The API allows a handful of breakpoints; keep only the last one we set.
  const last = out.map((b) => b.cache).lastIndexOf(true);
  return out.map((b, i) => ({ ...b, cache: i === last }));
}

export function plainPrompt(prompt: string): string {
  return prompt.replaceAll(CACHE_POINT, "").replaceAll(BLOCK, "");
}

export type Engine = (req: EngineRequest) => Promise<EngineResult>;

export class EngineError extends Error {
  constructor(
    message: string,
    /** "refusal": the model's safety filter declined this request (often a false positive). */
    readonly kind: "refusal" | "other" = "other",
  ) {
    super(message);
  }
}

const REFUSAL_RE = /safeguards flagged|usage policy|legal\/aup|can't respond to this message/i;

/** Resolve the claude executable: explicit path, PATH, or common install locations. */
export function resolveClaude(configured: string): string {
  if (configured.includes(path.sep)) return configured;
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, configured)),
    path.join(os.homedir(), ".local", "bin", configured),
    path.join(os.homedir(), ".claude", "local", configured),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return candidates.find((c) => c && fs.existsSync(c)) ?? configured;
}

/** One stateless `claude -p` call returning schema-validated structured output.
 *  The CLI runs in an empty temp dir with no built-in tools (unless granted), no
 *  MCP servers, no settings files, no CLAUDE.md, and no saved session. Input and
 *  output are stream-json so files can travel as content blocks and the answer
 *  can be shown while it is being written. */
export function claudeCliEngine(claudePath: string): Engine {
  return (req) =>
    new Promise<EngineResult>((resolve, reject) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sapien-"));
      const tools = req.tools ?? [];
      const args = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        ...(req.model ? ["--model", req.model] : []),
        "--no-session-persistence",
        "--strict-mcp-config",
        "--setting-sources", "",
        "--system-prompt", req.system,
        "--json-schema", JSON.stringify(req.schema),
        "--tools", tools.length ? tools.join(",") : "",
        ...(tools.length ? ["--allowedTools", ...tools] : []),
        ...(req.effort ? ["--effort", req.effort] : []),
      ];
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" };
      // Never forward an API key from our environment by accident: the CLI should
      // use its own subscription login.
      delete env.ANTHROPIC_API_KEY;
      const child = spawn(resolveClaude(claudePath), args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "";
      let stderr = "";
      let result: Record<string, any> | null = null;
      let partial = "";
      let inStructured = false;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        fs.rmSync(cwd, { recursive: true, force: true });
        fn();
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new EngineError(`Claude CLI timed out after ${Math.round((req.timeoutMs ?? 600_000) / 1000)}s`)));
      }, req.timeoutMs ?? 10 * 60_000);
      const onAbort = () => {
        child.kill("SIGTERM");
        finish(() => reject(new EngineError("Aborted")));
      };
      req.signal?.addEventListener("abort", onAbort);

      const handle = (line: string) => {
        if (!line.trim()) return;
        let e: Record<string, any>;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        if (e.type === "result") {
          result = e;
          return;
        }
        if (e.type !== "stream_event") return;
        const ev = e.event ?? {};
        if (ev.type === "content_block_start") {
          inStructured = ev.content_block?.type === "tool_use" && ev.content_block?.name === "StructuredOutput";
          if (inStructured) partial = "";
        } else if (ev.type === "content_block_delta" && inStructured && ev.delta?.type === "input_json_delta") {
          partial += ev.delta.partial_json ?? "";
          try {
            req.onPartial?.(partial);
          } catch {
            /* a display callback must never break the call */
          }
        } else if (ev.type === "content_block_stop") {
          inStructured = false;
        }
      };
      child.stdout.on("data", (d) => {
        buffer += d;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          handle(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
      child.on("error", (err) =>
        finish(() => reject(new EngineError(`Could not start the Claude CLI (${err.message}). Is Claude Code installed and on PATH?`))),
      );
      child.on("close", (code) =>
        finish(() => {
          handle(buffer);
          const parsed = result;
          if (!parsed) return reject(new EngineError(`Claude CLI exited ${code} without a result. ${stderr.trim().slice(-500)}`));
          if (parsed.is_error || parsed.subtype !== "success") {
            const detail = String(parsed.result ?? parsed.subtype ?? "unknown").slice(0, 500);
            return reject(new EngineError(`Claude CLI error: ${detail}`, REFUSAL_RE.test(detail) ? "refusal" : "other"));
          }
          let output = parsed.structured_output;
          if (output === undefined && typeof parsed.result === "string") {
            try {
              output = JSON.parse(parsed.result);
            } catch {
              return reject(new EngineError("Claude CLI returned no structured output."));
            }
          }
          const u = parsed.usage ?? {};
          resolve({
            output,
            usage: {
              inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              outputTokens: u.output_tokens ?? 0,
              costUsd: parsed.total_cost_usd ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            },
          });
        }),
      );
      const message = {
        type: "user",
        message: {
          role: "user",
          content: [
            ...(req.files ?? []),
            // A one-hour TTL: the CLI's own breakpoints use it, and a shorter one may not precede them.
            ...promptBlocks(req.prompt).map((b) => ({ type: "text", text: b.text, ...(b.cache ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}) })),
          ],
        },
      };
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(message) + "\n");
    });
}

// ─── shared FIFO gate for background CLI processes ─────────────────────────

const g = globalThis as unknown as { __sapienGate?: { active: number; queue: (() => void)[] } };
const gate = (g.__sapienGate ??= { active: 0, queue: [] });

export async function withWorkerSlot<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  if (gate.active >= Math.max(1, limit)) {
    // The releasing holder hands its slot straight to us (active stays counted).
    await new Promise<void>((r) => gate.queue.push(r));
  } else {
    gate.active++;
  }
  try {
    return await fn();
  } finally {
    const next = gate.queue.shift();
    if (next) next();
    else gate.active--;
  }
}
