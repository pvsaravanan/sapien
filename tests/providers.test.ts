import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ProviderId, Settings } from "../src/core/types";
import { DEFAULT_SETTINGS } from "../src/server/defaults";
import type { ContentBlock } from "../src/server/files";
import { engineFor, extractJson, modelFor, strictSchema } from "../src/server/providers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapien-prov-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const ANSWER = JSON.stringify({ answer: "hi" });

/** Each stub prints the provider's documented non-interactive output format. */
const OUTPUT: Record<Exclude<ProviderId, "claude">, string> = {
  codex: [
    { type: "thread.started", thread_id: "t1" },
    { type: "item.completed", item: { id: "i1", type: "agent_message", text: ANSWER } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n"),
  gemini: [
    { type: "init", session_id: "s", model: "m" },
    { type: "message", role: "assistant", content: '{"answer":', delta: true },
    { type: "message", role: "assistant", content: '"hi"}', delta: true },
    { type: "result", status: "success", stats: { input_tokens: 5, output_tokens: 2 } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n"),
  copilot: "Here is the object:\n```json\n" + ANSWER + "\n```\n",
  opencode: [
    { type: "step_start", part: { type: "step-start" } },
    { type: "text", part: { type: "text", text: ANSWER } },
    { type: "step_finish", part: { type: "step-finish", tokens: { input: 4, output: 1, cache: { read: 1 } }, cost: 0.002 } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n"),
  commandcode: [
    { type: "event", delta: "{" },
    { type: "result", subtype: "success", finalText: ANSWER, usage: { inputTokens: 3, outputTokens: 1 }, durationMs: 5 },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n"),
};

function stub(id: string, out: string, opts: { fail?: boolean } = {}) {
  const log = path.join(dir, `${id}.log.json`);
  const file = path.join(dir, `${id}-stub.cjs`);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
let stdin = ""; process.stdin.on("data", d => stdin += d); process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const listed = (d) => fs.existsSync(d) ? fs.readdirSync(d) : [];
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, stdin, cwd: process.cwd(), files: listed(path.join(process.cwd(), "files")), top: listed(process.cwd()) }));
  const o = argv.indexOf("-o"); if (o !== -1 && ${JSON.stringify(id)} === "codex") fs.writeFileSync(argv[o + 1], ${JSON.stringify(ANSWER)});
  ${opts.fail ? 'process.stderr.write("authentication required: run login"); process.exit(1);' : `process.stdout.write(${JSON.stringify(out)});`}
});
`,
  );
  fs.chmodSync(file, 0o755);
  return { file, log: () => JSON.parse(fs.readFileSync(log, "utf8")) as { argv: string[]; stdin: string; files: string[]; top: string[] } };
}

const files: ContentBlock[] = [
  { type: "text", text: "=== LEARNER FILE 1: slide.png (image) ===" },
  { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") } },
  { type: "text", text: "=== LEARNER FILE 2: notes.pdf (pdf) ===" },
  { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from("%PDF-1.4").toString("base64") }, title: "notes.pdf" },
];

function settingsFor(id: Exclude<ProviderId, "claude">, bin: string): Settings {
  return {
    ...DEFAULT_SETTINGS,
    provider: id,
    providers: { ...DEFAULT_SETTINGS.providers, [id]: { path: bin, models: { default: "model-x", teacher: "model-t" } } },
  };
}

const schema = { type: "object", properties: { answer: { type: "string", minLength: 1 } }, required: ["answer"] };

for (const id of Object.keys(OUTPUT) as Exclude<ProviderId, "claude">[]) {
  test(`${id}: documented headless invocation, file staging, and output parsing`, async () => {
    const s = stub(id, OUTPUT[id]);
    const settings = settingsFor(id, s.file);
    const partials: string[] = [];
    const res = await engineFor(settings)({
      model: modelFor(settings, "teacher"),
      effort: "high",
      system: "ROLE: TEST",
      prompt: "Say hi.",
      schema,
      files,
      onPartial: (p) => partials.push(p),
    });
    assert.deepEqual(res.output, { answer: "hi" });
    const log = s.log();
    const argv = log.argv.join(" ");
    const sent = `${log.stdin}\n${argv}`;
    // The model and effort reach the CLI with the documented flags.
    if (id === "codex") {
      assert.match(argv, /^exec --json --skip-git-repo-check --ephemeral/);
      assert.match(argv, /-s read-only/);
      assert.match(argv, /--output-schema \S+schema\.json/);
      assert.match(argv, /-m model-t/);
      assert.match(argv, /model_reasoning_effort="high"/);
      assert.match(argv, /-i \S+slide\.png/);
      assert.ok(log.argv.at(-1) === "-", "prompt read from stdin");
      assert.match(log.stdin, /ROLE: TEST[\s\S]*Say hi\./);
      assert.equal(res.usage.inputTokens, 12);
      assert.equal(res.usage.outputTokens, 3);
    }
    if (id === "gemini") {
      assert.match(argv, /--output-format stream-json/);
      assert.match(argv, /--approval-mode plan/);
      assert.match(argv, /-m model-t/);
      assert.match(argv, /@files\/1-slide\.png/);
      assert.match(argv, /@files\/2-notes\.pdf/);
      assert.match(log.stdin, /RESPONSE FORMAT[\s\S]*"answer"/, "schema stated in the prompt");
      assert.equal(res.usage.inputTokens, 5);
    }
    if (id === "copilot") {
      assert.match(argv, /-p Read @PROMPT\.md/);
      assert.match(argv, /-s --no-ask-user/);
      assert.match(argv, /--deny-tool shell --deny-tool write/);
      assert.match(argv, /--model model-t/);
      assert.match(argv, /--reasoning-effort high/);
      assert.match(argv, /--attachment \S+slide\.png --attachment \S+notes\.pdf/);
      assert.ok(log.top.includes("PROMPT.md"), "long prompt handed over as a file");
    }
    if (id === "opencode") {
      assert.match(argv, /^run --format json --pure -m model-t --variant high -f \S+PROMPT\.md -f \S+slide\.png -f \S+notes\.pdf --/);
      assert.equal(res.usage.inputTokens, 5);
      assert.equal(res.usage.costUsd, 0.002);
    }
    if (id === "commandcode") {
      assert.match(argv, /^-p --output-format json --max-turns 12 --skip-onboarding -m model-t --effort high$/);
      assert.match(log.stdin, /Say hi\./);
    }
    assert.ok(log.files.length === 2 || id === "commandcode" || log.files.length === 2, "attachments staged in the run folder");
    assert.doesNotMatch(sent, /--yolo|--allow-all|danger-full-access|--auto\b/, "never auto-approves writes or shell");
    if (id !== "copilot") assert.ok(partials.length > 0, "partial output reported while streaming");
  });
}

test("CLI failures surface the CLI's own error", async () => {
  const s = stub("codex-fail", "", { fail: true });
  await assert.rejects(
    engineFor(settingsFor("codex", s.file))({ system: "s", prompt: "p", schema }),
    /authentication required/,
  );
});

test("extractJson finds the object in fenced or chatty replies", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":"x}"}\n```'), { a: "x}" });
  assert.deepEqual(extractJson('Result: {"a":{"b":[1,2]}} done'), { a: { b: [1, 2] } });
  assert.throws(() => extractJson("no json here"), /JSON object/);
});

test("strictSchema closes objects and drops keywords strict modes reject", () => {
  const out = strictSchema({ type: "object", properties: { a: { type: "string", minLength: 1 }, b: { type: "array", items: { type: "object", properties: {} }, maxItems: 3 } } }) as any;
  assert.equal(out.additionalProperties, false);
  assert.equal(out.properties.a.minLength, undefined);
  assert.equal(out.properties.b.maxItems, undefined);
  assert.equal(out.properties.b.items.additionalProperties, false);
});

test("modelFor uses role, then provider default, then the CLI default", () => {
  const s = settingsFor("gemini", "gemini");
  assert.equal(modelFor(s, "teacher"), "model-t");
  assert.equal(modelFor(s, "grader"), "model-x");
  const bare = { ...s, providers: { ...s.providers, gemini: { path: "gemini", models: {} } } };
  assert.equal(modelFor(bare, "grader"), undefined);
  assert.equal(modelFor({ ...DEFAULT_SETTINGS }, "teacher"), "opus");
});
