"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { planStatus } from "@/src/core/plan";
import { activeProblem, pendingQuestion } from "@/src/core/transcript";
import type { AgentRole, Answer, Attachment, Effort, Job, ModelAlias, ProviderId, Session, SessionEvent, Settings } from "@/src/core/types";
import { api } from "./api";
import { AnnotatedFigure } from "./annotated-figure";
import { AttachButton, DropZone, FileChips, PaperclipIcon, PendingFiles, useAttachments, type AttachmentsState } from "./attachments";
import { IconAsk, IconEnter, IconPlan } from "./icons";
import { JobCard } from "./job-card";
import { Markdown } from "./markdown";
import { ModelPills } from "./model-pills";
import { PlanMap } from "./plan-map";
import { ConfidenceRow, QuestionCard, ThinkingBox } from "./question-card";
import { SidePanel } from "./side-panel";
import { DeleteSessionDialog } from "./delete-session";
import { DictateButton, DictationScope } from "./dictation";
import { useRouter } from "next/navigation";
import { StatesCard } from "./states-card";
import { notifySidebar } from "./top-nav";

interface View {
  session: Session;
  jobs: Job[];
  running: boolean;
  extracting: boolean;
  live: { agent: AgentRole; text: string; status?: string } | null;
  turn: "normal" | "delivery" | null;
  files: Attachment[];
  provider?: ProviderId;
}

const PHASE_LABEL: Record<string, string> = {
  probing: "Measuring",
  planning: "Planning",
  teaching: "Teaching",
  complete: "Complete",
  practice: "Practice",
};

export function SessionView({ id }: { id: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const router = useRouter();
  const [planOpen, setPlanOpen] = useState(true);
  const [settings, setSettings] = useState<Settings | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);
  const lastLiveLen = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setView(await api<View>(`/api/sessions/${id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    lastCount.current = 0;
    refresh();
    api<{ settings: Settings }>("/api/settings").then((d) => setSettings(d.settings)).catch(() => {});
  }, [refresh]);

  // Poll quickly while an agent is writing (streamed text), slower for background work.
  const running = !!view?.running;
  const busy = !!view && (view.running || view.extracting || view.jobs.some((j) => j.status === "running"));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(refresh, running ? 500 : 1500);
    return () => clearInterval(t);
  }, [busy, running, refresh]);

  // Follow new events and streaming text, unless the learner has scrolled up.
  useEffect(() => {
    const n = view?.session.events.length ?? 0;
    const liveLen = view?.live?.text.length ?? 0;
    const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 400;
    if (n > lastCount.current || (liveLen > lastLiveLen.current && nearBottom)) {
      bottomRef.current?.scrollIntoView({ behavior: lastCount.current ? "smooth" : "auto", block: "end" });
    }
    lastCount.current = n;
    lastLiveLen.current = liveLen;
  }, [view?.session.events.length, view?.live?.text.length]);

  const send = useCallback(
    async (input: unknown) => {
      try {
        setView(await api<View>(`/api/sessions/${id}/input`, { method: "POST", json: input }));
        setError(null);
        notifySidebar();
        return true;
      } catch (e) {
        setError((e as Error).message);
        refresh();
        return false;
      }
    },
    [id, refresh],
  );

  if (!view) return <div className="ui muted container-x py-8 text-sm">{error ?? "Loading…"}</div>;
  const { session: s, jobs, live, turn, files } = view;
  const delivering = running && turn === "delivery";
  const pending = pendingQuestion(s);
  const problem = activeProblem(s);
  const status = planStatus(s.events);
  const lastProblem = [...s.events].reverse().find((e) => e.type === "problem");
  const awaitingNext =
    s.kind === "practice" && !problem && !!lastProblem && !s.events.slice(s.events.indexOf(lastProblem)).some((e) => e.type === "next_problem");
  const interactiveRole = s.kind === "practice" ? "practitioner" : "teacher";
  const canInput = !running || delivering;
  const cut = s.compaction?.throughIndex ?? -1;

  return (
    <DictationScope value={{ sessionId: s.id }}>
    <div className="container-x">
      {/* header */}
      <header className="flex flex-wrap items-end gap-4 border-b py-8" style={{ borderColor: "var(--line)" }}>
        <div className="min-w-0 flex-1">
          <div className="label flex items-center gap-2.5">
            {running ? <span className="ring-spin" /> : <span className="ring-idle" />}
            {s.kind === "practice" ? "Practice" : "Lesson"} · {running && s.phase === "planning" ? "Planning" : PHASE_LABEL[s.phase]}
            {s.plan ? ` · ${status.visited.size + (status.current ? 1 : 0)} / ${s.plan.nodes.length} steps` : ""}
          </div>
          <h1 className="title-serif mt-3 text-[3.1rem] leading-[0.95]" style={{ color: "var(--accent)" }}>{s.title}</h1>
        </div>
        <button className="pill-btn" data-on={sideOpen} onClick={() => setSideOpen((o) => !o)} title="Ask a side question">
          <IconAsk /> Ask
        </button>
        {s.plan && (
          <button className="pill-btn" data-on={planOpen} onClick={() => setPlanOpen((o) => !o)}>
            <IconPlan /> Map
          </button>
        )}
        <button className="pill-btn hover:!border-[var(--bad)] hover:!text-[var(--bad)]" onClick={() => setDeleteOpen(true)} title="Delete this session">
          Delete
        </button>
      </header>
      {deleteOpen && (
        <DeleteSessionDialog
          session={{ id, title: s.title, running }}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => (notifySidebar(), router.push("/#sessions"))}
        />
      )}

      <div className={`grid gap-10 py-8 ${(s.plan && planOpen) || files.length ? "lg:grid-cols-[minmax(0,1fr)_320px]" : ""}`}>
        {/* gap, not space-y: the per-event wrappers are display: contents, which drops margins */}
        <div className="flex min-w-0 flex-col gap-7">
          {s.events.map((e, i) => (
            <div key={e.id} className="contents">
              {i === cut && <SummaryDivider summary={s.compaction!.summary} count={s.compaction!.count} />}
              <EventItem
                e={e}
                session={s}
                jobs={jobs}
                files={files}
                interactive={canInput && pending?.id === e.id}
                submitDisabled={delivering}
                onAnswer={(answer) => send({ type: "answer", eventId: e.id, answer })}
              />
            </div>
          ))}

          {running && <LiveMessage live={live} phase={s.phase} delivering={delivering} onStop={() => api(`/api/sessions/${id}/abort`, { method: "POST" }).then(refresh)} />}

          {(error || (!running && s.lastError)) && (
            <div className="flex items-center gap-3 border px-4 py-3 text-sm" style={{ borderColor: "var(--bad)" }}>
              <span className="ui flex-1 text-xs" style={{ color: "var(--bad)" }}>{error ?? s.lastError}</span>
              {!running && s.lastError && <button className="btn" onClick={() => send({ type: "retry" })}>Retry</button>}
            </div>
          )}

          {canInput && !pending && (
            <Composer
              key={`${problem?.id ?? ""}-${awaitingNext}`}
              mode={problem ? "attempt" : awaitingNext ? "next" : "message"}
              disabled={delivering}
              onSend={(text, confidence, attachmentIds) =>
                send(
                  problem
                    ? { type: "attempt", text, attachmentIds, thinking: confidence !== undefined ? { confidence } : undefined }
                    : { type: "message", text, attachmentIds },
                )
              }
              onNext={() => send({ type: "next_problem" })}
              onGiveUp={() => send({ type: "attempt", text: "I give up — please show me the solution." })}
            />
          )}
          {canInput && pending && <AsideLink disabled={delivering} onSend={(text, attachmentIds) => send({ type: "message", text, attachmentIds })} />}

          <StatusBar
            view={view}
            defaultModel={settings?.models[interactiveRole] ?? "opus"}
            defaultEffort={settings?.effort[interactiveRole]}
            onModel={async (model, effort) => {
              try {
                setView(await api<View>(`/api/sessions/${id}`, { method: "PATCH", json: { model: model ?? null, effort: effort ?? null } }));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            onExtract={() => api(`/api/sessions/${id}/extract`, { method: "POST" }).then(refresh).catch((e) => setError(e.message))}
          />
          <div ref={bottomRef} />
        </div>

        {((s.plan && planOpen) || files.length > 0) && (
          <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
            {s.plan && planOpen && (
              <div className="card-lift">
                <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--line-strong)" }}>
                  <span className="label">Lesson map</span>
                  <span className="label-muted text-[0.62rem]">v{s.plan.version}</span>
                </div>
                <div className="scroll-thin max-h-[52vh] overflow-y-auto p-4">
                  <PlanMap plan={s.plan} current={status.current} visited={status.visited} />
                </div>
              </div>
            )}
            {files.length > 0 && <FilesCard files={files} />}
            {s.plan && planOpen && s.states && <StatesCard states={s.states} />}
          </aside>
        )}
      </div>

      {sideOpen && (
        <div className="fixed bottom-6 right-6 z-30 w-[380px]">
          <SidePanel sessionId={id} initial={s.side} onClose={() => setSideOpen(false)} />
        </div>
      )}
    </div>
    </DictationScope>
  );
}

/** What the agent is writing right now, streamed in as it arrives. */
function LiveMessage({
  live,
  phase,
  delivering,
  onStop,
}: {
  live: View["live"];
  phase: string;
  delivering: boolean;
  onStop: () => void;
}) {
  const fallback = delivering
    ? "a background result arrived — checking whether it needs a comment"
    : phase === "probing"
      ? "thinking about what to ask"
      : phase === "planning"
        ? "planning your path"
        : "preparing the next step";
  const status = live?.status ?? fallback;
  return (
    <div>
      {live?.text ? (
        <div className="relative">
          <Markdown>{live.text}</Markdown>
          <span className="cursor-blink" />
        </div>
      ) : null}
      <div className="ui muted mt-2 flex items-center gap-2 text-xs">
        <span className="dot" />
        <span className="dot" style={{ animationDelay: "0.2s" }} />
        <span className="dot" style={{ animationDelay: "0.4s" }} />
        <span className="ml-1 uppercase tracking-[0.16em]">{live?.text ? "writing" : status}</span>
        {!delivering && (
          <button className="ml-3 underline" onClick={onStop}>
            stop
          </button>
        )}
      </div>
    </div>
  );
}

function SummaryDivider({ summary, count }: { summary: string; count: number }) {
  return (
    <details className="card px-4 py-3">
      <summary className="label cursor-pointer text-[0.64rem]">
        Earlier lesson condensed for the agents{count > 1 ? ` (×${count})` : ""} · view summary
      </summary>
      <p className="faint mt-2 text-xs">
        The agents now see this summary instead of the full history above. Everything above is still saved and shown here.
      </p>
      <Markdown className="mt-2 text-[0.95rem]">{summary}</Markdown>
    </details>
  );
}

function FilesCard({ files }: { files: Attachment[] }) {
  return (
    <div className="card">
      <div className="label border-b px-4 py-3" style={{ borderColor: "var(--line-strong)" }}>
        Your files · {files.length}
      </div>
      <ul className="px-4 py-2">
        {files.map((f) => (
          <li key={f.id} className="py-1.5">
            <a href={`/api/files/${f.id}`} target="_blank" rel="noreferrer" className="ui flex items-center gap-2 text-[0.82rem] hover:text-[var(--blue)]">
              <PaperclipIcon size={12} />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="faint text-[0.68rem] uppercase">{f.kind}{f.pages ? ` · ${f.pages}p` : ""}</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="faint border-t px-4 py-2 text-[0.72rem]" style={{ borderColor: "var(--line-strong)" }}>
        Every agent in this session can read these. Attach more from the message box.
      </p>
    </div>
  );
}

function StatusBar({
  view,
  defaultModel,
  defaultEffort,
  onModel,
  onExtract,
}: {
  view: View;
  defaultModel: string;
  defaultEffort?: string;
  onModel: (m: ModelAlias | undefined, e: Effort | undefined) => void;
  onExtract: () => void;
}) {
  const { session: s, extracting, running } = view;
  const tokens = (s.usage.inputTokens + s.usage.outputTokens) / 1000;
  return (
    <div className="ui flex flex-wrap items-center gap-3 border-t pt-4 text-xs" style={{ borderColor: "var(--line)" }}>
      <span className="muted tabular-nums" title={`${s.usage.calls} model calls · CLI-reported cost; subscription billing may differ`}>
        {tokens.toFixed(1)}k tokens · ${s.usage.costUsd.toFixed(4)}
      </span>
      {extracting ? (
        <span className="faint">adding to graph…</span>
      ) : (
        <button className="faint hover:text-white" onClick={onExtract} disabled={running} title="Fold this lesson's teaching into your knowledge graph now">
          + graph
        </button>
      )}
      <span className="flex-1" />
      <ModelPills provider={view.provider} model={s.model} effort={s.effort} defaultModel={defaultModel} defaultEffort={defaultEffort} onChange={onModel} />
    </div>
  );
}

function EventItem({
  e,
  session,
  jobs,
  files,
  interactive,
  submitDisabled,
  onAnswer,
}: {
  e: SessionEvent;
  session: Session;
  jobs: Job[];
  files: Attachment[];
  interactive: boolean;
  submitDisabled: boolean;
  onAnswer: (a: Answer) => void;
}) {
  switch (e.type) {
    case "learner_message":
    case "attempt":
      return (
        <div className="flex justify-end">
          <div className="max-w-[75%] border px-4 py-2.5" style={{ borderColor: "var(--line-strong)", background: "var(--panel)" }}>
            {e.type === "attempt" && <div className="label mb-1">Attempt</div>}
            <div className="ui whitespace-pre-wrap text-[0.9rem] leading-relaxed">{e.text}</div>
            {e.thinking?.reasoning && <div className="muted mt-1 text-sm italic">{e.thinking.reasoning}</div>}
            {e.attachments?.length ? <FileChips ids={e.attachments} files={files} /> : null}
          </div>
        </div>
      );
    case "agent_message":
      return (
        <div>
          {e.text && <Markdown>{e.text}</Markdown>}
          {e.figure && <AnnotatedFigure figure={e.figure} file={files.find((f) => f.id === e.figure!.fileId)} />}
        </div>
      );
    case "question": {
      const stale = !e.answer && !interactive && pendingQuestion(session)?.id !== e.id;
      return <QuestionCard event={e} interactive={interactive} stale={stale} submitDisabled={submitDisabled} onAnswer={onAnswer} />;
    }
    case "states":
      return <Divider>measurement complete</Divider>;
    case "plan":
      // The replan reason is the teacher's brief to the planner, not learner-facing;
      // the planner's intro message explains the change to the learner.
      return <Divider>{e.plan.version > 1 ? "lesson map redrawn" : "lesson map drawn"}</Divider>;
    case "job": {
      const job = jobs.find((j) => j.id === e.jobId);
      return job ? <JobCard job={job} /> : null;
    }
    case "problem":
      return (
        <div className={`px-5 py-4 ${e.status === "active" ? "card-feature" : "card"}`}>
          <div className="mb-1 flex items-center gap-3">
            <span className="label">Problem</span>
            {e.status === "concluded" && <span className="ui text-xs" style={{ color: e.outcome?.startsWith("solved") ? "var(--good)" : "var(--muted)" }}>{outcomeLabel(e.outcome)}</span>}
          </div>
          <Markdown className="md-flush">{e.problem.statement}</Markdown>
          {e.status === "concluded" && (
            <details className="dashed mt-3 pt-3" open>
              <summary className="label cursor-pointer">Solution</summary>
              <Markdown className="mt-1">{e.problem.solution}</Markdown>
              {e.verdict && <p className="muted mt-2 text-sm italic">{e.verdict}</p>}
            </details>
          )}
        </div>
      );
    case "next_problem":
      return <Divider>next problem</Divider>;
    case "complete":
      return (
        <div className="card-feature px-5 py-4">
          <div className="label mb-1">Goal reached</div>
          <Markdown className="md-flush">{e.summary}</Markdown>
          <p className="ui faint mt-2 text-xs">Keep asking here, or practice this from your knowledge graph.</p>
        </div>
      );
    default:
      return null;
  }
}

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className="label flex items-center gap-3 text-[0.64rem]">
      <span className="h-px flex-1" style={{ background: "var(--accent-soft)" }} />
      {children}
      <span className="h-px flex-1" style={{ background: "var(--accent-soft)" }} />
    </div>
  );
}

function outcomeLabel(o?: string) {
  return o === "solved" ? "Solved" : o === "solvedWithHints" ? "Solved with hints" : o === "notSolved" ? "Not solved" : o === "skipped" ? "Skipped" : "";
}

/** While a question is pending, a quiet way to say something else instead. */
function AsideLink({ onSend, disabled }: { onSend: (text: string, attachmentIds: string[]) => Promise<boolean>; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const attach = useAttachments();
  if (!open)
    return (
      <div>
        <button className="ui faint text-xs hover:text-white" onClick={() => setOpen(true)}>not sure how to answer? send a message or a file instead</button>
      </div>
    );
  const submit = async () => {
    if ((!text.trim() && !attach.ids.length) || attach.uploading) return;
    if (await onSend(text, attach.ids)) (setText(""), attach.clear());
  };
  return <MessageBox value={text} onChange={setText} onSubmit={submit} placeholder="Message to your teacher…" attach={attach} disabled={disabled} />;
}

function MessageBox({
  value,
  onChange,
  onSubmit,
  placeholder,
  attach,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  attach: AttachmentsState;
  disabled?: boolean;
}) {
  const can = !disabled && !attach.uploading && (!!value.trim() || attach.ids.length > 0);
  return (
    <DropZone state={attach}>
      <div className="card p-2.5 pl-4">
        <div className="flex items-end gap-3">
          <textarea
            autoFocus
            rows={1}
            className="ui max-h-48 min-h-[2.4rem] flex-1 resize-none bg-transparent py-2 text-[0.95rem] outline-none placeholder:text-[var(--faint)]"
            placeholder={placeholder}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (can) onSubmit();
              }
            }}
          />
          <DictateButton value={value} onChange={onChange} compact />
          <AttachButton state={attach} label="File" />
          <button className="btn btn-primary h-10 w-10 !p-0" disabled={!can} onClick={onSubmit} title={disabled ? "Wait a moment — a background result is being added" : "Send (Enter)"}>
            <IconEnter size={18} />
          </button>
        </div>
        {(attach.files.length > 0 || attach.error) && (
          <div className="pb-1 pt-2">
            <PendingFiles state={attach} />
          </div>
        )}
      </div>
    </DropZone>
  );
}

function Composer({
  mode,
  disabled,
  onSend,
  onNext,
  onGiveUp,
}: {
  mode: "message" | "attempt" | "next";
  disabled: boolean;
  onSend: (text: string, confidence: number | undefined, attachmentIds: string[]) => Promise<boolean>;
  onNext: () => void;
  onGiveUp: () => void;
}) {
  const [text, setText] = useState("");
  const [confidence, setConfidence] = useState<number | undefined>(undefined);
  const attach = useAttachments();
  const submit = async () => {
    if ((!text.trim() && !attach.ids.length) || attach.uploading || disabled) return;
    if (await onSend(text, confidence, attach.ids)) (setText(""), attach.clear());
  };
  if (mode === "attempt")
    return (
      <DropZone state={attach}>
        <div className="card-feature overflow-hidden">
          <ConfidenceRow value={confidence} onChange={setConfidence} />
          <div className="border-t" style={{ borderColor: "var(--line)" }}>
            <ThinkingBox
              label="Your attempt"
              placeholder="Your working and answer — include your reasoning, even if unsure. You can attach a photo of handwritten work."
              value={text}
              onChange={setText}
              onSubmit={submit}
              canSubmit={!disabled && !attach.uploading && (!!text.trim() || attach.ids.length > 0)}
              submitLabel="Submit attempt"
              autoFocus
              extra={
                <>
                  <AttachButton state={attach} label="Photo / file" />
                  <button className="btn" onClick={onGiveUp} disabled={disabled}>Give up</button>
                </>
              }
            />
            {(attach.files.length > 0 || attach.error) && (
              <div className="px-4 pb-3">
                <PendingFiles state={attach} />
              </div>
            )}
          </div>
        </div>
      </DropZone>
    );
  return (
    <div className="space-y-3">
      {mode === "next" && (
        <div className="flex items-center gap-3">
          <button className="btn btn-primary" onClick={onNext} disabled={disabled}>Next problem →</button>
          <span className="ui faint text-xs">or ask about the last one</span>
        </div>
      )}
      <MessageBox value={text} onChange={setText} onSubmit={submit} placeholder={mode === "next" ? "Ask about the last problem…" : "Message, or attach notes to learn from…"} attach={attach} disabled={disabled} />
    </div>
  );
}
