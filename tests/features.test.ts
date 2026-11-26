import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { partialStringField } from "../src/core/partial";
import type { EngineRequest, EngineResult } from "../src/server/engine";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapien-feat-"));
process.env.SAPIEN_DATA_DIR = dir;

let orch: typeof import("../src/server/orchestrator");
let store: typeof import("../src/server/store");
let files: typeof import("../src/server/files");

type Script = (req: EngineRequest) => Promise<unknown> | unknown;
const scripts: Record<string, Script[]> = {};
const seen: { role: string; req: EngineRequest }[] = [];

function roleOf(req: EngineRequest) {
  return /ROLE: ([A-Z -]+)/.exec(req.system)?.[1].trim() ?? "UNKNOWN";
}

async function fakeEngine(req: EngineRequest): Promise<EngineResult> {
  const role = roleOf(req);
  seen.push({ role, req });
  const next = scripts[role]?.shift();
  if (!next) throw new Error(`No scripted output for ${role}`);
  return { output: await next(req), usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
}

async function until(cond: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

before(async () => {
  (await import("../src/server/runtime")).setEngine(fakeEngine);
  orch = await import("../src/server/orchestrator");
  store = await import("../src/server/store");
  files = await import("../src/server/files");
  store.saveSettings({ ...store.getSettings(), graphEnabled: false, compactionThresholdChars: 20000 });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("partialStringField decodes streaming JSON safely", () => {
  assert.equal(partialStringField('{"message":"Hel', "message"), "Hel");
  assert.equal(partialStringField('{"message":"a\\nb \\"q\\" \\u00e9', "message"), 'a\nb "q" é');
  assert.equal(partialStringField('{"message":"cut \\u00', "message"), "cut ");
  assert.equal(partialStringField('{"message":"done","action":"x"}', "message"), "done");
  assert.equal(partialStringField('{"action":"x"', "message"), null);
});

test("files: upload sniffing, content blocks, and transcript attribution", async () => {
  assert.throws(() => files.saveFile("evil.exe", Buffer.from("MZ\0\0binary")), /Unsupported/);
  const pdf = files.saveFile("lecture3.pdf", Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Pages >> endobj"));
  assert.equal(pdf.kind, "pdf");
  assert.equal(pdf.pages, 1);
  const png = files.saveFile("slide.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const notes = files.saveFile("notes.md", Buffer.from("# Normal forms\n3NF: nothing but the key"));

  let streamedSeen = "";
  scripts["PROBER"] = [
    async (req) => {
      // Simulate streaming: partial JSON arrives before the final answer.
      req.onPartial?.('{"message":"Looking at your lecture');
      await new Promise((r) => setTimeout(r, 30));
      return { message: "Looking at your lecture notes now.", action: "ask", question: "Which part of lecture 3 feels least clear?" };
    },
  ];
  const s0 = orch.createSession({ kind: "teach", topic: "", attachmentIds: [pdf.id, png.id, notes.id] });
  await until(() => {
    const l = orch.getLive(s0.id);
    if (l?.text) streamedSeen = l.text;
    return !orch.isRunning(s0.id);
  });
  assert.equal(streamedSeen, "Looking at your lecture", "live text was visible while streaming");
  assert.equal(orch.getLive(s0.id), null, "live state cleared after commit");

  const call = seen.find((c) => c.role === "PROBER")!;
  const blocks = call.req.files ?? [];
  assert.ok(blocks.some((b) => b.type === "document"), "PDF sent as a document block");
  assert.ok(blocks.some((b) => b.type === "image"), "image sent as an image block");
  assert.ok(blocks.some((b) => b.type === "text" && b.text.includes("nothing but the key")), "text file inlined");
  assert.match(call.req.prompt, /LEARNER FILES/);
  assert.match(call.req.prompt, /\[attached: lecture3\.pdf, slide\.png, notes\.md\]/);
  const s = store.getSession(s0.id)!;
  assert.deepEqual(s.attachments, [pdf.id, png.id, notes.id]);
  assert.match(s.topic, /attached material/);
});

test("delivery: a result arriving during an open question wakes the teacher for a note", async () => {
  scripts["PROBER"] = [() => ({ message: "", action: "finish", states: { current: "c", goal: "g" } })];
  scripts["PLANNER"] = [() => ({ nodes: [{ id: "a", title: "A", summary: "s" }], edges: [], intro: "Plan." })];
  scripts["TEACHER"] = [
    () => ({
      message: "Step one.",
      action: "check_choice",
      role: "check",
      nodeId: "a",
      question: "Q?",
      options: ["x", "y"],
      correct: [0],
      explanation: "x.",
      optionNotes: ["Right.", "Mistake."],
      dispatch: [{ kind: "visual", title: "Diagram", brief: "draw" }],
    }),
  ];
  let releaseVisual!: () => void;
  scripts["VISUAL MAKER"] = [() => new Promise((r) => (releaseVisual = () => r({ svg: '<svg viewBox="0 0 1 1"></svg>', caption: "Look here." })))];
  const s0 = orch.createSession({ kind: "teach", topic: "topic" });
  await until(() => !orch.isRunning(s0.id) && !!scripts["VISUAL MAKER"] && typeof releaseVisual === "function");
  let s = store.getSession(s0.id)!;
  const q = orch.getLive(s0.id);
  assert.equal(q, null);
  const pending = s.events.filter((e) => e.type === "question").at(-1)!;

  // The visual finishes while the learner is still answering; teacher may only note.
  scripts["TEACHER"] = [
    (req) => {
      assert.match(req.prompt, /\[NEW · visual "Diagram"/);
      return { message: "The diagram shows the idea from step one.", action: "check_choice", question: "new?", options: ["a", "b"], correct: [0], explanation: "a.", optionNotes: ["Right.", "Mistake."], role: "check", nodeId: "a" };
    },
    () => ({ message: "The diagram shows the idea from step one.", action: "note" }),
  ];
  releaseVisual();
  await until(() => {
    const x = store.getSession(s0.id)!;
    return x.events.some((e) => e.type === "job_result" && e.delivered) && !orch.isRunning(s0.id);
  });
  s = store.getSession(s0.id)!;
  const notes = s.events.filter((e) => e.type === "agent_message" && e.text.startsWith("The diagram"));
  assert.equal(notes.length, 1, "teacher added one note");
  assert.equal(s.events.filter((e) => e.type === "question").at(-1)!.id, pending.id, "the open question is unchanged");
  assert.equal(scripts["TEACHER"].length, 0, "restricted delivery rejected a new question, then accepted the note");
  assert.equal(s.lastError, undefined);
});

test("compaction: long history is summarised and replaces old events in agent context", async () => {
  const id = store.listSessions().find((x) => x.kind === "teach" && x.plan)!.id;
  // Grow the transcript past the 20k threshold with long learner messages.
  store.saveSession({
    ...store.getSession(id)!,
    events: [
      ...store.getSession(id)!.events,
      ...Array.from({ length: 30 }, (_, i) => ({ id: `pad${i}`, at: "", type: "learner_message" as const, text: `Long note ${i}: ${"words ".repeat(250)}` })),
    ],
  });
  scripts["SESSION SUMMARIZER"] = [
    (req) => {
      assert.match(req.prompt, /EVENTS TO FOLD INTO THE SUMMARY/);
      assert.match(req.prompt, /Long note 0/);
      return { summary: "SUMMARY: learner wrote many notes about the topic." };
    },
  ];
  let teacherPrompt = "";
  scripts["TEACHER"] = [
    (req) => {
      teacherPrompt = req.prompt;
      return { message: "Continuing.", action: "check_choice", role: "check", nodeId: "a", question: "Next?", options: ["p", "q"], correct: [1], explanation: "q.", optionNotes: ["Mistake.", "Right."] };
    },
  ];
  orch.submitInput(id, { type: "message", text: "please continue" });
  await until(() => !orch.isRunning(id));
  const s = store.getSession(id)!;
  assert.equal(s.lastError, undefined, s.lastError);
  assert.ok(s.compaction && s.compaction.throughIndex > 0, "compaction recorded");
  assert.match(teacherPrompt, /SUMMARY OF THE EARLIER SESSION[\s\S]*SUMMARY: learner wrote many notes/);
  assert.doesNotMatch(teacherPrompt, /Long note 0:/, "old events are no longer sent verbatim");
  assert.match(teacherPrompt, /please continue/, "recent events stay verbatim");
});
