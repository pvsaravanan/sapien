"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Effort, Graph, ModelAlias, Session, Settings } from "@/src/core/types";
import { api } from "./api";
import { AttachButton, DropZone, PendingFiles, useAttachments } from "./attachments";
import { DeleteSessionDialog } from "./delete-session";
import { DictateButton } from "./dictation";
import { GraphCanvas } from "./graph-canvas";
import { ModelPills } from "./model-pills";
import { notifySidebar, relTime } from "./top-nav";

type Row = Omit<Session, "events" | "side"> & { eventCount: number; statusLine: string };

const PHASE_LABEL: Record<string, string> = {
  probing: "Measuring",
  planning: "Planning",
  teaching: "Teaching",
  complete: "Complete",
  practice: "Practice",
};

const EXAMPLES = [
  { who: "Curious", phase: "Physics", topic: "Why the sky is blue, not violet", time: "20 min" },
  { who: "I know some calculus", phase: "Analysis", topic: "Why a Gaussian's Fourier transform is a Gaussian", time: "45 min" },
  { who: "I write code", phase: "Systems", topic: "How hash tables stay fast as they grow", time: "30 min" },
  { who: "Build intuition", phase: "Linear algebra", topic: "What eigenvectors actually mean", time: "40 min" },
];

const TUTOR_STEPS = [
  { n: "01", cmd: "/measure", title: "Find your level", text: "A few diagnostic questions. The prober maps what you already hold, where your grip ends, and what you're aiming for." },
  { n: "02", cmd: "/plan", title: "Get your plan", text: "The planner searches the shortest dependency path to your goal and draws it as a lesson map you can follow." },
  { n: "03", cmd: "/teach", title: "Learn step by step", text: "One reasoning step, then one check. Your answer, confidence, and thinking decide what comes next." },
  { n: "04", cmd: "/practice", title: "Make it stick", text: "Problems that never name the idea they need, with hints that point instead of tell. Progress recorded." },
];

const FIG_STEPS = [
  { n: "01", title: "Measure", sub: "where your grip ends", body: "Light is a wave.\nScattering is fuzzy." },
  { n: "02", title: "Plan", sub: "the minimal tree", body: "Frequency → shaking\n→ 1/λ⁴ → blue sky." },
  { n: "03", title: "Teach", sub: "one step, one check", body: "Predict, explain,\ncheck, repair." },
  { n: "04", title: "Practice", sub: "knowledge you can use", body: "Sunsets are red.\nNow you know why." },
];

const all_rows = (rows: Row[] | null) => rows ?? [];

export function Home() {
  const router = useRouter();
  const params = useSearchParams();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<{ ok: boolean; path: string; name: string } | null>(null);
  const [mode, setMode] = useState<"teach" | "practice">(params.get("mode") === "practice" ? "practice" : "teach");
  const [topic, setTopic] = useState("");
  const [model, setModel] = useState<ModelAlias | undefined>();
  const [effort, setEffort] = useState<Effort | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attach = useAttachments();

  const loadRows = () => api<{ sessions: Row[] }>("/api/sessions").then((d) => setRows(d.sessions)).catch((e) => setError(e.message));
  useEffect(() => {
    loadRows();
    api<{ graph: Graph }>("/api/graph").then((d) => setGraph(d.graph)).catch(() => {});
    api<{ settings: Settings }>("/api/settings").then((d) => setSettings(d.settings)).catch(() => {});
    api<{ claude: { ok: boolean; path: string }; providerName: string }>("/api/health").then((d) => setHealth({ ...d.claude, name: d.providerName })).catch(() => {});
  }, []);
  useEffect(() => {
    const m = params.get("mode");
    if (m === "teach" || m === "practice") {
      setMode(m);
      inputRef.current?.focus();
    }
  }, [params]);

  async function start() {
    if (busy || attach.uploading || (!topic.trim() && !attach.ids.length)) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>("/api/sessions", { method: "POST", json: { kind: mode, topic, model, effort, attachmentIds: attach.ids } });
      notifySidebar();
      router.push(`/session/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const deleting = all_rows(rows).find((r) => r.id === confirmDelete);

  const all = rows ?? [];
  const recent = all.slice(0, 4);
  const lessons = all.filter((r) => r.kind === "teach").length;
  const props = graph?.propositions.length ?? 0;
  const role = mode === "teach" ? "teacher" : "practitioner";
  const borderSoft = { borderColor: "var(--rule-soft)" };

  return (
    <div>
      {/* ── masthead ───────────────────────────────────── */}
      <section className="border-b pb-10 pt-16" style={borderSoft}>
        <div className="container-x grid items-center gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,1.62fr)_minmax(0,1fr)]">
          <div>
            <h1 className="display" style={{ fontSize: "clamp(3rem, 9vw, 5.6rem)" }}>
              Learn from
              <br />
              first principles
            </h1>
            <p className="mt-7 mb-2 max-w-[720px]" style={{ fontSize: "clamp(1.05rem, 1.7vw, 1.25rem)", lineHeight: 1.55 }}>
              {lessons > 0 ? `${lessons} lesson${lessons > 1 ? "s" : ""}. ` : ""}
              {props > 0 ? `${props} ideas in your graph. ` : ""}
              Every new idea built from one you already hold, one reasoning step at a time.
            </p>
            <p className="muted italic" style={{ fontSize: "0.95rem" }}>Taught by your own agents through the coding-agent CLI you already use. Runs on your own machine.</p>

            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button className="btn btn-primary" disabled={!all.length} onClick={() => all[0] && router.push(`/session/${all[0].id}`)}>
                Continue where you left off
              </button>
              <Link href="/graph" className="btn">Explore your knowledge graph</Link>
              <Link href="/graph" className="ui flex min-h-8 items-center gap-2 text-[0.82rem]" style={{ color: "var(--ink-soft)" }}>
                <span style={{ color: "var(--ink)" }}>★</span> Knowledge graph
                <span className="mx-1 h-5 w-px" style={{ background: "var(--rule-soft)" }} />
                {props}
              </Link>
              <a href="#sessions" className="ui flex min-h-8 items-center gap-2 text-[0.82rem]" style={{ color: "var(--ink-soft)" }}>
                <span style={{ color: "var(--ink)" }}>◎</span> {all.length} session{all.length === 1 ? "" : "s"} saved locally
              </a>
            </div>

            {/* start box (terminal style) */}
            <DropZone state={attach} className="mt-[26px]">
            <div id="start" className="ui scroll-mt-24 border text-[0.82rem]" style={{ ...borderSoft, background: "var(--surface)" }}>
              <div className="flex items-center justify-between border-b px-3 py-1.5" style={borderSoft}>
                <span className="label-mute">{mode === "teach" ? "Learn with your agents" : "Practice with your coach"}</span>
                <div className="seg">
                  <button className="copy-chip" data-on={mode === "teach"} onClick={() => setMode("teach")}>Teach</button>
                  <button className="copy-chip" data-on={mode === "practice"} onClick={() => setMode("practice")}>Practice</button>
                </div>
              </div>
              <div className="px-[14px] py-3 leading-[1.7]">
                <textarea
                  ref={inputRef}
                  rows={1}
                  className="ui block w-full resize-none bg-transparent text-[0.82rem] leading-[1.7] outline-none placeholder:text-[var(--ink-mute)]"
                  style={{ color: "var(--ink)" }}
                  placeholder={mode === "teach" ? "why gradient descent converges — or attach your lecture notes" : "related-rates word problems"}
                  value={topic}
                  onChange={(e) => {
                    setTopic(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = `${e.target.scrollHeight}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      start();
                    }
                  }}
                />
                <div>
                  <span style={{ color: "var(--ink-mute)" }}>&gt; </span>
                  <span style={{ color: "var(--blue)" }}>
                    {busy
                      ? "Starting your session…"
                      : attach.files.length
                        ? `Press ↵ to learn from ${attach.files.length === 1 ? "this file" : `these ${attach.files.length} files`}.`
                        : mode === "teach"
                          ? "Press ↵ to begin. Drop in PDFs, slides or notes to learn from them."
                          : "Press ↵ to begin, or pick material from your graph."}
                  </span>
                </div>
                {(attach.files.length > 0 || attach.error) && (
                  <div className="mt-2.5">
                    <PendingFiles state={attach} />
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-[14px] py-2 text-[0.66rem] uppercase tracking-[0.08em]" style={{ ...borderSoft, color: "var(--ink-mute)" }}>
                <AttachButton state={attach} />
                <DictateButton value={topic} onChange={setTopic} />
                <span>✳ Prober</span>
                <span>◇ Planner</span>
                <span>◎ Teacher</span>
                <span className="flex-1" />
                <ModelPills provider={settings?.provider} model={model} effort={effort} defaultModel={settings?.models[role] ?? "opus"} defaultEffort={settings?.effort[role]} onChange={(m, e) => (setModel(m), setEffort(e))} />
              </div>
            </div>
            </DropZone>
            <p className="mt-2.5 text-[0.78rem]" style={{ color: "var(--ink-mute)", fontFamily: "var(--font-prose)" }}>
              Your agents become your tutor: a placement probe, a personalized plan, lessons taught one step at a time.{" "}
              {mode === "practice" && (
                <>
                  <Link href="/graph?practice=1" className="link">Practice from your graph →</Link>{" "}
                </>
              )}
            </p>
            <a href="#how" className="link text-[0.78rem]">How it works →</a>
            {health && !health.ok && (
              <p className="ui mt-3 text-xs" style={{ color: "var(--bad)" }}>
                {health.name} not found ({health.path}). Install it and sign in, or choose another provider in <Link href="/settings" className="link">settings</Link>.
              </p>
            )}
            {error && <p className="ui mt-3 text-xs" style={{ color: "var(--bad)" }}>{error}</p>}
          </div>

          {/* start where you are */}
          <div className="card-lift w-full self-center">
            <div className="ui border-b px-4 py-3 text-[0.7rem] uppercase tracking-[0.14em]" style={{ ...borderSoft, color: "var(--blue)" }}>
              {recent.length ? "Pick up where you left off" : "Start where you are"}
            </div>
            {recent.length
              ? recent.map((r) => (
                  <Link key={r.id} href={`/session/${r.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-b px-4 py-3.5 hover:bg-[var(--blue-tint)]" style={borderSoft}>
                    <span className="ui text-[0.68rem] uppercase tracking-[0.08em]" style={{ color: "var(--ink-soft)" }}>{r.statusLine}</span>
                    <span className="ui row-span-2 self-center whitespace-nowrap text-[0.72rem]" style={{ color: "var(--blue)" }}>{relTime(r.updatedAt)} →</span>
                    <span className="truncate text-[1.05rem] leading-[1.3]">
                      <span className="ui mr-2 text-[0.72rem]" style={{ color: "var(--blue)" }}>{r.kind === "practice" ? "Practice" : PHASE_LABEL[r.phase]}</span>
                      {r.title}
                    </span>
                  </Link>
                ))
              : EXAMPLES.map((x) => (
                  <button
                    key={x.topic}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-b px-4 py-3.5 text-left hover:bg-[var(--blue-tint)]"
                    style={borderSoft}
                    onClick={() => (setMode("teach"), setTopic(x.topic), inputRef.current?.focus())}
                  >
                    <span className="ui text-[0.68rem] uppercase tracking-[0.08em]" style={{ color: "var(--ink-soft)" }}>{x.who}</span>
                    <span className="ui row-span-2 self-center whitespace-nowrap text-[0.72rem]" style={{ color: "var(--blue)" }}>{x.time} →</span>
                    <span className="text-[1.05rem] leading-[1.3]">
                      <span className="ui mr-2 text-[0.72rem]" style={{ color: "var(--blue)" }}>{x.phase}</span>
                      {x.topic}
                    </span>
                  </button>
                ))}
            <a href={recent.length ? "#sessions" : "#how"} className="ui block px-4 py-3 text-[0.7rem] uppercase tracking-[0.08em] hover:text-[var(--ink)]" style={{ color: "var(--ink-soft)" }}>
              {recent.length ? `Browse all ${all.length} sessions ↓` : "See how a lesson works ↓"}
            </a>
          </div>
        </div>
      </section>

      {/* ── your agents are the tutor ──────────────────── */}
      <section className="border-b py-14" style={borderSoft}>
        <div className="container-x">
          <div className="grid items-end gap-x-14 gap-y-6 md:grid-cols-2">
            <div>
              <p className="ui mb-3 text-[0.78rem] uppercase tracking-[0.16em]" style={{ color: "var(--blue)" }}>Your agents are the tutor</p>
              <h2 className="h-cream" style={{ fontSize: "clamp(2rem, 3.2vw, 2.9rem)" }}>
                You don&apos;t plan this lesson. Your agents teach it.
              </h2>
            </div>
            <p style={{ fontSize: "1.08rem", lineHeight: 1.6 }}>
              Most explanations hand you a conclusion and leave you to work out the rest. Sapien ships its own tutor: agents that place you, draw your study
              plan, and teach each step, checking it lands before moving on. You don&apos;t need to know what to learn first to start.
            </p>
          </div>
          <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TUTOR_STEPS.map((s) => (
              <li key={s.n} className="grid content-start gap-2.5 border p-[18px]" style={{ ...borderSoft, background: "var(--bg)" }}>
                <span className="num text-[2rem]">{s.n}</span>
                <span className="chip justify-self-start">{s.cmd}</span>
                <h3 className="heading">{s.title}</h3>
                <p className="text-[0.96rem] leading-[1.5]" style={{ color: "var(--ink-soft)" }}>{s.text}</p>
              </li>
            ))}
          </ol>
          <p className="mt-5 text-[0.96rem] leading-[1.6]" style={{ color: "var(--ink-soft)" }}>
            Stuck on a side question? <span className="ui text-[0.88em]" style={{ color: "var(--blue)" }}>Ask</span> opens a helper that answers without moving the
            lesson on. Background workers research, draw diagrams, and build demos while you learn. <Link href="/settings" className="link">Choose your models →</Link>
          </p>
        </div>
      </section>

      {/* ── sessions ───────────────────────────────────── */}
      <section id="sessions" className="py-20">
        <div className="container-x">
          <p className="ui mb-2 text-[0.78rem] uppercase tracking-[0.16em]" style={{ color: "var(--blue)" }}>
            Sessions · {lessons} lessons · {all.length - lessons} practice
          </p>
          <p className="mb-8 text-[0.95rem]" style={{ color: "var(--ink-soft)" }}>Tap a session to pick it up. Each keeps its transcript, lesson map, and progress.</p>
          <div className="grid gap-[14px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {all.length === 0 && (
              <button className="card-feature flex min-h-[190px] flex-col px-4 pb-3.5 pt-4 text-left" onClick={() => inputRef.current?.focus()}>
                <span className="ui flex justify-between text-[0.68rem] uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>Lesson 01</span>
                <span className="card-name mb-1.5 mt-3">Your first lesson</span>
                <span className="mb-3.5 flex-1 text-[0.92rem] leading-[1.4]" style={{ color: "var(--ink-soft)" }}>Type anything you want to understand above. The rest is planned for you.</span>
                <span className="ui flex justify-between text-[0.68rem] uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>
                  <span>0 steps</span>
                  <span style={{ color: "var(--blue)" }}>Start here</span>
                </span>
              </button>
            )}
            {all.map((r, i) => (
              <div key={r.id} className={`group flex min-h-[190px] flex-col px-4 pb-3.5 pt-4 transition-colors hover:border-[var(--blue)] ${i === 0 ? "card-feature" : "card"}`}>
                <div className="ui flex items-center justify-between gap-2.5 text-[0.68rem] uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>
                  <span>
                    {r.kind === "practice" ? "Practice" : "Lesson"} {String(all.length - i).padStart(2, "0")}
                  </span>
                  <button
                    className="ui text-[0.66rem] uppercase tracking-[0.1em] transition-colors hover:text-[var(--bad)]"
                    style={{ color: "var(--ink-mute)" }}
                    title="Delete this session"
                    onClick={() => setConfirmDelete(r.id)}
                  >
                    Delete
                  </button>
                </div>
                <Link href={`/session/${r.id}`} className="flex flex-1 flex-col">
                  <span className="card-name mb-1.5 mt-3">{r.title}</span>
                  <span className="mb-3.5 block flex-1">
                    <span className="line-clamp-3 text-[0.92rem] leading-[1.4]" style={{ color: "var(--ink-soft)" }}>{r.states?.goal ?? r.topic}</span>
                  </span>
                  <span className="ui flex items-center justify-between gap-2.5 text-[0.68rem] uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>
                    <span>{r.plan ? `${r.plan.nodes.length} steps` : r.kind === "practice" ? "Practice" : PHASE_LABEL[r.phase]}</span>
                    <span style={{ color: i === 0 ? "var(--blue)" : "var(--ink-mute)" }}>{i === 0 ? "Continue" : relTime(r.updatedAt)}</span>
                  </span>
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── how every lesson works ─────────────────────── */}
      <section id="how" className="section">
        <div className="container-x">
          <p className="ui mb-8 text-[0.74rem] uppercase tracking-[0.16em]" style={{ color: "var(--blue)" }}>How every lesson works</p>
          <div className="text-[1rem] leading-[1.7] md:columns-2 md:gap-12" style={{ columnRule: "1px solid var(--rule-soft)" }}>
            <p className="dropcap mb-4 break-inside-avoid-column">
              Most material teaches in scattered pieces. A video here, a textbook chapter there, a clever explanation somewhere else. The pieces rarely line
              up. You can recite a formula but can&apos;t say why it&apos;s true. You recognise a word but can&apos;t rebuild the idea behind it.
            </p>
            <p className="mb-4 break-inside-avoid-column">
              Sapien starts from what already feels obvious to you and adds one small step at a time. Every step is checked before the next is built on it,
              so a gap shows up the moment you step on it. What you learn becomes claims and reasoning chains in a knowledge graph that later lessons and
              practice build on.
            </p>
          </div>

          <div className="ui mt-12 flex justify-between gap-4 border-b px-2 pb-3 text-[0.7rem] uppercase tracking-[0.16em]" style={{ borderColor: "var(--blue-tint-strong)" }}>
            <span style={{ color: "var(--blue)" }}>Fig_001 · one lesson, four agents</span>
            <span className="hidden sm:inline" style={{ color: "var(--ink-soft)" }}>Example · why the sky is blue</span>
          </div>
          <div className="mt-11 grid items-center gap-y-6 px-2 md:grid-cols-[1fr_56px_1fr_56px_1fr_56px_1fr]">
            {FIG_STEPS.map((s, i) => (
              <div key={s.n} className="contents">
                <div className="fig-box self-stretch px-7 py-7">
                  <div className="num text-[2.3rem]">{s.n}</div>
                  <div className="ui mt-4 text-[1rem] font-medium uppercase tracking-[0.12em]">{s.title}</div>
                  <div className="mt-1 text-[1rem]" style={{ color: "var(--ink-soft)" }}>{s.sub}</div>
                  <div className="my-5 border-t border-dashed" style={{ borderColor: "var(--blue-tint-strong)" }} />
                  <div className="ui whitespace-pre-line text-[0.88rem] leading-[1.75]">{s.body}</div>
                </div>
                {i < FIG_STEPS.length - 1 && (
                  <svg className="hidden justify-self-center md:block" width="32" height="12" viewBox="0 0 32 12" aria-hidden>
                    <path d="M0 6h26" stroke="var(--blue)" strokeWidth="1.5" />
                    <path d="M24 1l7 5-7 5z" fill="var(--blue)" />
                  </svg>
                )}
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-[68ch] text-[0.98rem]" style={{ color: "var(--ink-soft)" }}>
            Learn the small version first, then see the idea do real work. Every lesson follows the same{" "}
            <a href="#start" className="link">four agents</a> from your first question to practice.
          </p>
        </div>
      </section>

      {/* ── knowledge graph ────────────────────────────── */}
      <section className="section">
        <div className="container-x">
          <div className="px-0 md:px-12">
            <h2 className="h-cream" style={{ fontSize: "clamp(2rem, 4vw, 3.2rem)" }}>What you know, and why</h2>
            <p className="mt-6 max-w-[56ch] text-[1.02rem] leading-[1.6]" style={{ color: "var(--ink-soft)" }}>
              Everything you&apos;re taught is stored as claims and the reasoning steps between them, each linked back to the lesson it came from. It
              records ideas, not scores, and later lessons build on it.
            </p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              <Link href="/graph" className="btn-sm" data-primary="true">Open knowledge graph</Link>
              <Link href="/graph?import=1" className="btn-sm">Import notes</Link>
              <Link href="/graph?practice=1" className="btn-sm">Practice from graph</Link>
            </div>
            <div className="mt-8 border" style={{ ...borderSoft, background: "var(--bg)" }}>
              <div className="ui flex justify-between gap-4 border-b px-6 py-3.5 text-[0.72rem] uppercase tracking-[0.14em]" style={borderSoft}>
                <span style={{ color: "var(--blue)" }}>Fig_002 · your knowledge graph</span>
                <span style={{ color: "var(--ink-soft)" }}>
                  {props} propositions · {graph?.chains.length ?? 0} chains
                </span>
              </div>
              <div className="h-[440px]">
                {graph && graph.propositions.length > 0 ? (
                  <GraphCanvas compact graph={graph} highlight={null} selected={new Set()} focused={null} onNodeClick={(id) => router.push(`/graph?node=${encodeURIComponent(id)}`)} />
                ) : (
                  <div className="ui flex h-full items-center justify-center text-sm" style={{ color: "var(--ink-mute)" }}>
                    Your graph grows here as you finish lessons<span className="cursor-blink ml-1" />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {deleting && (
        <DeleteSessionDialog
          session={{ id: deleting.id, title: deleting.title, running: deleting.status === "running" }}
          onClose={() => setConfirmDelete(null)}
          onDeleted={() => (setConfirmDelete(null), loadRows(), notifySidebar())}
        />
      )}

      <footer className="border-t py-8" style={borderSoft}>
        <div className="container-x ui flex justify-between text-[0.7rem] uppercase tracking-[0.12em]" style={{ color: "var(--ink-mute)" }}>
          <span>Sapien · MIT · runs locally</span>
          <span>Measure → plan → teach → practice</span>
        </div>
      </footer>
    </div>
  );
}
