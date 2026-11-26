import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { z } from "zod";
import type { EngineRequest, EngineResult } from "../src/server/engine";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapien-hard-"));
process.env.SAPIEN_DATA_DIR = dir;

let runtime: typeof import("../src/server/runtime");
let providers: typeof import("../src/server/providers");
let research: typeof import("../src/server/research");
let files: typeof import("../src/server/files");
let defaults: typeof import("../src/server/defaults");
let EngineError: typeof import("../src/server/engine").EngineError;

before(async () => {
  runtime = await import("../src/server/runtime");
  providers = await import("../src/server/providers");
  research = await import("../src/server/research");
  files = await import("../src/server/files");
  defaults = await import("../src/server/defaults");
  EngineError = (await import("../src/server/engine")).EngineError;
});
after(() => {
  runtime.setEngine(null);
  research.setResearchFetch(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("findAnswer works with event shapes the adapters don't know", () => {
  const schema = { type: "object", properties: { message: {}, action: {}, question: {} } };
  const answer = { message: "Hi", action: "ask", question: "Why?" };
  // Unknown streaming shape: the answer is a string deep inside some event.
  const stdout = [
    JSON.stringify({ kind: "session", id: "x", meta: { role: "assistant" } }),
    JSON.stringify({ kind: "chunk", payload: { parts: [{ body: JSON.stringify(answer) }] } }),
    JSON.stringify({ kind: "done", tokens: 12 }),
  ].join("\n");
  assert.deepEqual(providers.findAnswer("", stdout, schema), answer);
  // A look-alike event object loses to the real answer.
  const noisy = `${JSON.stringify({ type: "message", role: "assistant" })}\nAnswer: ${JSON.stringify(answer)}`;
  assert.deepEqual(providers.findAnswer("", noisy, schema), answer);
  assert.throws(() => providers.findAnswer("", JSON.stringify({ type: "x" }), schema), /expected format/);
});

test("Sapien research: search → fetch → grounded answer with checked citations", async () => {
  const calls: string[] = [];
  research.setResearchFetch((async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("list=search")) return Response.json({ query: { search: [{ title: "Rayleigh scattering" }, { title: "Diffuse sky radiation" }] } });
    if (url.includes("prop=extracts")) {
      const title = decodeURIComponent(/titles=([^&]+)/.exec(url)![1]);
      return Response.json({ query: { pages: { "1": { title, extract: `${title}: shorter wavelengths scatter far more strongly, roughly as 1/λ⁴.` } } } });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch);

  const prompts: string[] = [];
  let attempt = 0;
  runtime.setEngine(async (req: EngineRequest): Promise<EngineResult> => {
    prompts.push(req.prompt);
    assert.equal(req.tools, undefined, "no CLI tools needed when Sapien fetched the sources");
    attempt++;
    const output =
      attempt === 1
        ? { answer: "Blue scatters more.", sources: [{ title: "Made up", url: "https://example.com/fake" }] }
        : { answer: "Blue scatters ~5.5× more than red.", sources: [{ title: "Rayleigh scattering", url: "https://en.wikipedia.org/wiki/Rayleigh_scattering" }] };
    return { output, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
  });
  const { runWorker } = await import("../src/agents/agents");
  const settings = { ...defaults.DEFAULT_SETTINGS, provider: "codex" as const };
  const out = (await runWorker({ settings }, "research", "Why is the sky blue", "Explain Rayleigh scattering", "optics")) as { answer: string; sources: { url: string }[] };
  assert.match(prompts[0], /SOURCES \(searched with Wikipedia\)[\s\S]*Rayleigh scattering: shorter wavelengths/);
  assert.match(prompts[1], /Cite only URLs from the SOURCES list/, "an invented citation is sent back for correction");
  assert.equal(out.sources[0].url, "https://en.wikipedia.org/wiki/Rayleigh_scattering");
  assert.ok(calls.every((u) => u.startsWith("https://en.wikipedia.org/")));
});

test("research uses the CLI's own search where it has one", async () => {
  let seen: EngineRequest | null = null;
  runtime.setEngine(async (req) => ((seen = req), { output: { answer: "x", sources: [] }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
  const { runWorker } = await import("../src/agents/agents");
  await runWorker({ settings: { ...defaults.DEFAULT_SETTINGS, provider: "claude" } }, "research", "t", "b", "topic");
  assert.deepEqual(seen!.tools, ["WebSearch", "WebFetch"]);
  assert.doesNotMatch(seen!.prompt, /SOURCES/);
});

test("public-URL guard and HTML cleanup", () => {
  assert.ok(research.isPublicUrl("https://en.wikipedia.org/wiki/X"));
  for (const bad of ["http://localhost:3000", "http://127.0.0.1/", "http://192.168.1.4/x", "http://10.0.0.1", "file:///etc/hosts", "http://intranet/", "http://[::1]/"])
    assert.equal(research.isPublicUrl(bad), false, bad);
  assert.equal(research.htmlToText("<p>Hello&nbsp;<b>world</b></p><script>evil()</script><nav>menu</nav>"), "Hello world");
});

test("refusal fallback: provider's fallback models, then the fallback provider", async () => {
  const tried: string[] = [];
  runtime.setEngine(async (req) => {
    tried.push(req.model ?? "default");
    if (req.model !== "sonnet") throw new EngineError("blocked by content policy", "refusal");
    return { output: { ok: "yes" }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  });
  const settings = {
    ...defaults.DEFAULT_SETTINGS,
    provider: "codex" as const,
    fallbackProvider: "claude" as const,
    providers: { ...defaults.DEFAULT_SETTINGS.providers, codex: { path: "codex", models: { default: "m1" }, fallbackModels: ["m2", "m3"] } },
  };
  settings.models = { ...settings.models, grader: "sonnet" };
  const out = await runtime.runAgent({ role: "grader", system: "s", prompt: "p", schema: z.object({ ok: z.string() }), settings });
  assert.deepEqual(out, { ok: "yes" });
  assert.deepEqual(tried, ["m1", "m2", "m3", "sonnet"]);
  assert.deepEqual(runtime.modelChain(settings, "grader"), ["m1", "m2", "m3"]);
});

test("PDF text extraction feeds CLIs that cannot read PDFs", async () => {
  const meta = files.saveFile("lecture3.pdf", fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "lecture3.pdf")));
  const text = await files.ensurePdfText(meta.id);
  assert.match(text!, /\[page 1\][\s\S]*first normal form/i);
  assert.match(text!, /\[page 2\][\s\S]*nothing but the key/);
  assert.equal(files.getFile(meta.id)!.pages, 2);
  const asText = files.fileBlocks([meta.id], { pdf: "text" }).blocks;
  assert.ok(asText.every((b) => b.type === "text"));
  assert.ok(asText.some((b) => b.type === "text" && b.text.includes("[page 2]")));
  const native = files.fileBlocks([meta.id]).blocks;
  assert.ok(native.some((b) => b.type === "document"));
  const forCodex = await files.filesFor([meta.id], { ...defaults.DEFAULT_SETTINGS, provider: "codex" });
  assert.ok(forCodex.blocks.some((b) => b.type === "text" && b.text.includes("nothing but the key")));
});

test("JavaScript CLIs run with a Node version that meets their requirement", () => {
  const bin = path.join(dir, "fakebin");
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(bin, "cmd");
  fs.writeFileSync(cli, "#!/usr/bin/env node\nconsole.log('1.0');\n");
  fs.chmodSync(cli, 0o755);
  // An explicit Node path always wins.
  const forced = providers.runnerFor(cli, "commandcode", process.execPath);
  assert.equal(forced.bin, process.execPath);
  assert.equal(forced.pre[0], fs.realpathSync(cli));
  // Auto-detection: either a Node >= 22 is found on this machine, or the requirement is reported.
  const auto = providers.runnerFor(cli, "commandcode");
  assert.equal(auto.need, 22);
  if (auto.node) {
    const major = Number(/v(\d+)\./.exec(execFileSync(auto.node, ["--version"], { encoding: "utf8" }))![1]);
    assert.ok(major >= 22, `picked Node ${major}`);
    assert.equal(auto.pre[0], fs.realpathSync(cli));
  } else assert.equal(auto.bin, cli);
  // Non-JS executables are launched directly.
  assert.equal(providers.runnerFor(process.execPath, "commandcode").bin, process.execPath);
});
