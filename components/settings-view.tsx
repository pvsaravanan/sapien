"use client";

import { useEffect, useMemo, useState } from "react";
import { PROVIDER_IDS, PROVIDERS } from "@/src/core/provider-info";
import type { AgentRole, Effort, ModelAlias, ProviderId, Settings } from "@/src/core/types";
import { api } from "./api";
import { Segmented, Toggle } from "./controls";
import { Dropdown } from "./dropdown";

const GROUPS: { title: string; note: string; roles: { role: AgentRole; label: string; help: string }[] }[] = [
  {
    title: "Interactive",
    note: "The agents you talk to. These use the strongest model by default; a session can override them from its status bar.",
    roles: [
      { role: "prober", label: "Prober", help: "Measures your current understanding and goal" },
      { role: "planner", label: "Planner", help: "Searches the minimal dependency map" },
      { role: "teacher", label: "Teacher", help: "Teaches one step at a time, with checks" },
      { role: "practitioner", label: "Practice coach", help: "Poses and coaches practice problems" },
    ],
  },
  {
    title: "Bookkeeping",
    note: "Quieter jobs that keep the session and graph in order.",
    roles: [
      { role: "grader", label: "Grader", help: "Grades free-text answers against the committed answer" },
      { role: "helper", label: "Side helper", help: "Answers quick side questions" },
      { role: "summarizer", label: "Summarizer", help: "Condenses long sessions so agents keep their context" },
      { role: "extractor", label: "Extractor", help: "Turns lessons and notes into graph claims" },
      { role: "auditor", label: "Identity auditor", help: "Merges duplicate claims in the graph" },
      { role: "scribe", label: "Dictation clean-up", help: "Fixes punctuation and misheard words after you dictate" },
    ],
  },
  {
    title: "Background workers",
    note: "Run alongside the lesson and deliver results when ready.",
    roles: [
      { role: "research", label: "Researcher", help: "Web research with sources" },
      { role: "visual", label: "Visual maker", help: "Static SVG diagrams" },
      { role: "demo", label: "Demo builder", help: "Small interactive simulations" },
    ],
  },
];

const MODELS: ModelAlias[] = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const SECTIONS = [
  { id: "cli", label: "Provider" },
  { id: "models", label: "Models" },
  { id: "research", label: "Research" },
  { id: "teaching", label: "Teaching" },
  { id: "graph", label: "Knowledge graph" },
  { id: "long", label: "Long sessions" },
];

export function SettingsView() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  type Probe = { ok: boolean; version: string | null; path: string; note?: string };
  const [secrets, setSecrets] = useState<{ brave: boolean; tavily: boolean }>({ brave: false, tavily: false });
  const [keyInput, setKeyInput] = useState<{ brave?: string; tavily?: string }>({});
  const [health, setHealth] = useState<Record<ProviderId, Probe> | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id);

  // Highlight the section currently in view.
  useEffect(() => {
    if (!s) return;
    const els = SECTIONS.map((x) => document.getElementById(x.id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { rootMargin: "-90px 0px -55% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [!!s]);

  const checkCli = () => api<{ providers: Record<ProviderId, Probe> }>("/api/health").then((d) => setHealth(d.providers)).catch(() => {});
  useEffect(() => {
    api<{ settings: Settings; secrets: { brave: boolean; tavily: boolean } }>("/api/settings")
      .then((d) => (setS(d.settings), setSaved(d.settings), setSecrets(d.secrets)))
      .catch((e) => setMsg({ text: e.message, bad: true }));
    checkCli();
  }, []);
  const dirty = useMemo(
    () => (!!s && !!saved && JSON.stringify(s) !== JSON.stringify(saved)) || Object.values(keyInput).some((v) => v !== undefined),
    [s, saved, keyInput],
  );

  if (!s) return <div className="container-x ui py-10 text-sm" style={{ color: "var(--ink-soft)" }}>{msg?.text ?? "Loading…"}</div>;

  const save = async () => {
    setSaving(true);
    try {
      const d = await api<{ settings: Settings; secrets: { brave: boolean; tavily: boolean } }>("/api/settings", { method: "PUT", json: { ...s, secrets: keyInput } });
      setS(d.settings);
      setSaved(d.settings);
      setSecrets(d.secrets);
      setKeyInput({});
      setMsg({ text: "Saved." });
      checkCli();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setSaving(false);
    }
  };
  const set = (patch: Partial<Settings>) => (setS({ ...s, ...patch }), setMsg(null));
  const setModel = (role: AgentRole | "default", value: string) => {
    if (s.provider === "claude") return;
    const p = s.provider;
    set({ providers: { ...s.providers, [p]: { ...s.providers[p], models: { ...s.providers[p].models, [role]: value.trim() } } } });
  };

  return (
    <div className="container-x pb-28">
      <header className="border-b py-10" style={{ borderColor: "var(--rule-soft)" }}>
        <p className="ui mb-3 text-[0.78rem] uppercase tracking-[0.16em]" style={{ color: "var(--blue)" }}>Configuration</p>
        <h1 className="display" style={{ fontSize: "clamp(2.6rem, 6vw, 4rem)" }}>Settings</h1>
        <p className="mt-4 max-w-[60ch]" style={{ color: "var(--ink-soft)" }}>
          Choose which models your agents use and how lessons, the knowledge graph, and long sessions behave. Changes apply to the next agent step.
        </p>
      </header>

      <div className="grid gap-10 pt-10 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="hidden lg:block">
          <ul className="sticky top-24 space-y-1">
            {SECTIONS.map((sec) => (
              <li key={sec.id}>
                <a href={`#${sec.id}`} className="settings-nav-link ui" data-active={activeSection === sec.id} aria-current={activeSection === sec.id ? "location" : undefined}>
                  {sec.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-8">
          <Card id="cli" title="Provider" intro="Pick the coding-agent CLI that runs your agents. Each uses its own login and billing; Sapien stores no API keys.">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {PROVIDER_IDS.map((id) => {
                const on = s.provider === id;
                const h = health?.[id];
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => set({ provider: id })}
                    className="border px-4 py-3 text-left transition-colors hover:border-[var(--blue)]"
                    style={{ borderColor: on ? "var(--blue)" : "var(--rule-soft)", background: on ? "var(--blue-tint)" : "var(--bg)", boxShadow: on ? "var(--shadow-hard)" : undefined }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.95rem]" style={{ color: on ? "var(--blue)" : "var(--ink)" }}>{PROVIDERS[id].name}</span>
                      <span className="inline-block h-2 w-2 shrink-0" title={h?.ok ? "Installed" : "Not found"} style={{ background: h ? (h.ok ? "var(--good)" : "var(--ink-mute)") : "transparent" }} />
                    </div>
                    <div className="ui mt-1 truncate text-[0.68rem] uppercase tracking-[0.08em]" style={{ color: "var(--ink-mute)" }}>
                      {h ? (h.ok ? h.version : "not installed") : "checking…"}
                    </div>
                  </button>
                );
              })}
            </div>
            <ProviderDetails s={s} set={set} probe={health?.[s.provider]} />
            <Row label="If a request is declined" help="After the fallback models, try this provider once (when a safety filter declines a step).">
              <Dropdown<ProviderId | "">
                className="max-w-[320px]"
                label="Fallback provider"
                value={s.fallbackProvider}
                onChange={(v) => set({ fallbackProvider: v })}
                options={[
                  { value: "", label: "No fallback provider" },
                  ...PROVIDER_IDS.filter((p) => p !== s.provider).map((p) => ({
                    value: p,
                    label: PROVIDERS[p].name,
                    hint: health?.[p]?.ok ? undefined : "not installed",
                  })),
                ]}
              />
            </Row>
          </Card>

          <Card
            id="models"
            title="Models per agent"
            intro={
              s.provider === "claude"
                ? "Model aliases are resolved by the CLI to the latest version. Effort controls how long a model thinks before answering."
                : `Model names as ${PROVIDERS[s.provider].name} expects them${s.provider === "opencode" ? " (provider/model, e.g. anthropic/claude-sonnet-4)" : ""}. Leave a field empty to use the CLI's own default.`
            }
          >
            {s.provider !== "claude" && (
              <Row label="Fallback models" help="Comma-separated; tried in order when a model declines a request.">
                <input
                  className="field ui max-w-[420px] text-[0.86rem]"
                  placeholder="e.g. model-a, model-b"
                  value={(s.providers[s.provider].fallbackModels ?? []).join(", ")}
                  onChange={(e) => {
                    const p = s.provider as Exclude<ProviderId, "claude">;
                    set({ providers: { ...s.providers, [p]: { ...s.providers[p], fallbackModels: e.target.value.split(",").map((x) => x.trim()) } } });
                  }}
                />
              </Row>
            )}
            {s.provider === "claude" && (
              <p className="text-[0.82rem]" style={{ color: "var(--ink-mute)" }}>If a model declines a request, Sapien retries that step on the next one (opus → sonnet → haiku).</p>
            )}
            {s.provider !== "claude" && (
              <Row label="Default for all agents" help="Used for every role left empty below.">
                <input
                  className="field ui max-w-[320px] text-[0.86rem]"
                  placeholder="CLI default"
                  value={s.providers[s.provider].models.default ?? ""}
                  onChange={(e) => setModel("default", e.target.value)}
                />
              </Row>
            )}
            {GROUPS.map((g, gi) => (
              <div key={g.title} className={gi ? "border-t pt-5" : ""} style={{ borderColor: "var(--rule-soft)" }}>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="heading !text-[0.78rem]">{g.title}</h3>
                  <p className="text-[0.82rem]" style={{ color: "var(--ink-mute)" }}>{g.note}</p>
                </div>
                <div className="ui mb-1 hidden grid-cols-[minmax(0,1fr)_150px_150px] gap-3 text-[0.64rem] uppercase tracking-[0.12em] sm:grid" style={{ color: "var(--ink-mute)" }}>
                  <span>Agent</span>
                  <span>Model</span>
                  <span>Effort</span>
                </div>
                {g.roles.map(({ role, label, help }) => (
                  <div key={role} className="grid grid-cols-1 items-center gap-x-3 gap-y-2 border-t py-3 sm:grid-cols-[minmax(0,1fr)_150px_150px]" style={{ borderColor: "var(--rule-soft)" }}>
                    <div>
                      <div className="text-[0.95rem]">{label}</div>
                      <div className="text-[0.8rem]" style={{ color: "var(--ink-mute)" }}>{help}</div>
                    </div>
                    {s.provider === "claude" ? (
                      <Dropdown<ModelAlias>
                        label={`${label} model`}
                        value={s.models[role]}
                        onChange={(v) => set({ models: { ...s.models, [role]: v } })}
                        options={MODELS.map((m) => ({ value: m, label: m }))}
                      />
                    ) : (
                      <input
                        className="field ui !py-2 text-[0.82rem]"
                        aria-label={`${label} model`}
                        placeholder={s.providers[s.provider].models.default || "default"}
                        value={s.providers[s.provider].models[role] ?? ""}
                        onChange={(e) => setModel(role, e.target.value)}
                      />
                    )}
                    <Dropdown<Effort | "">
                      label={`${label} effort`}
                      value={s.effort[role] ?? ""}
                      onChange={(v) => set({ effort: { ...s.effort, [role]: v || undefined } })}
                      options={[{ value: "", label: "default" }, ...EFFORTS.map((m) => ({ value: m, label: m }))]}
                    />
                  </div>
                ))}
              </div>
            ))}
          </Card>

          <Card id="research" title="Research" intro="How the research worker finds sources. Claude Code and Gemini CLI have their own live web search; for other CLIs Sapien searches, fetches the pages, and has the agent answer from them with citations.">
            <Row label="Strategy">
              <Segmented
                value={s.research.engine}
                onChange={(v) => set({ research: { ...s.research, engine: v } })}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "sapien", label: "Sapien search" },
                  { value: "off", label: "Off" },
                ]}
              />
            </Row>
            <p className="-mt-2 text-[0.8rem] md:pl-[264px]" style={{ color: "var(--ink-mute)" }}>
              {s.research.engine === "auto"
                ? PROVIDERS[s.provider].webSearch
                  ? `${PROVIDERS[s.provider].name} will use its own web search.`
                  : `${PROVIDERS[s.provider].name} has no live web search, so Sapien's search is used.`
                : s.research.engine === "sapien"
                  ? "Sapien searches and fetches sources for every provider."
                  : "Research answers come from the model's own knowledge, with no web access."}
            </p>
            <Row label="Search backend" help="Wikipedia needs no key. Brave and Tavily search the whole web.">
              <Segmented
                value={s.research.search}
                onChange={(v) => set({ research: { ...s.research, search: v } })}
                options={[
                  { value: "wikipedia", label: "Wikipedia" },
                  { value: "brave", label: "Brave" },
                  { value: "tavily", label: "Tavily" },
                ]}
              />
            </Row>
            {(["brave", "tavily"] as const).map((k) => (
              <Row key={k} label={`${k === "brave" ? "Brave Search" : "Tavily"} API key`} help={secrets[k] ? "A key is saved. Type a new one to replace it." : "Not set."}>
                <div className="flex max-w-[460px] items-center gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    className="field ui text-[0.86rem]"
                    placeholder={secrets[k] ? "•••••••• (saved)" : "Paste API key"}
                    value={keyInput[k] ?? ""}
                    onChange={(e) => setKeyInput({ ...keyInput, [k]: e.target.value })}
                  />
                  {secrets[k] && (
                    <button type="button" className="btn-sm" onClick={() => setKeyInput({ ...keyInput, [k]: "" })}>
                      Remove
                    </button>
                  )}
                </div>
              </Row>
            ))}
            <p className="text-[0.78rem]" style={{ color: "var(--ink-mute)" }}>Keys are stored locally in data/secrets.json and never sent to the browser. Research questions are sent to the search service you choose.</p>
          </Card>

          <Card id="teaching" title="Teaching">
            <Row label="Check style" help="How the teacher verifies each step.">
              <Segmented
                value={s.quizMode}
                onChange={(v) => set({ quizMode: v })}
                options={[
                  { value: "mixed", label: "Mixed" },
                  { value: "choice", label: "Multiple choice" },
                  { value: "recall", label: "Own words" },
                ]}
              />
            </Row>
            <Row label="Background workers" help="Which helpers the teacher may dispatch during a lesson.">
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                {(["research", "visual", "demo"] as const).map((w) => (
                  <label key={w} className="flex items-center gap-2.5 text-[0.9rem] capitalize">
                    <Toggle label={w} value={s.workers[w]} onChange={(v) => set({ workers: { ...s.workers, [w]: v } })} /> {w}
                  </label>
                ))}
              </div>
            </Row>
            <Row label="Clean up dictation with AI" help="When you stop dictating, the scribe fixes punctuation, filler words and misheard terms using the lesson as context. It keeps your meaning, hedges and mistakes. The scribe's model is set under Models.">
              <Toggle label="Clean up dictation with AI" value={s.dictationCleanup} onChange={(v) => set({ dictationCleanup: v })} />
            </Row>
            <Row label="Concurrent background processes" help="Upper limit on CLI processes for workers and extraction.">
              <NumberField value={s.workerConcurrency} min={1} onChange={(v) => set({ workerConcurrency: v })} />
            </Row>
          </Card>

          <Card id="graph" title="Knowledge graph">
            <Row label="Semantic search" help="Find related claims by meaning with a small local model (all-MiniLM-L6-v2, ~23 MB, downloaded once). Runs on this machine; graph text is never sent anywhere.">
              <div className="space-y-2">
                <Toggle label="Semantic search" value={s.graphSemantic} onChange={(v) => set({ graphSemantic: v })} />
                {s.graphSemantic && <SemanticStatus />}
              </div>
            </Row>
            <Row label="Build automatically" help="Extract claims from lessons and give agents relevant prior knowledge.">
              <Toggle label="Build the graph automatically" value={s.graphEnabled} onChange={(v) => set({ graphEnabled: v })} />
            </Row>
            <Row label="Extraction threshold" help="Characters of new teaching before extracting (also runs when a lesson completes).">
              <NumberField value={s.extractionThresholdChars} min={500} step={500} suffix="chars" onChange={(v) => set({ extractionThresholdChars: v })} />
            </Row>
          </Card>

          <Card id="long" title="Long sessions" intro="Older history is condensed into a summary so agents keep their context; the recent stretch always stays word for word.">
            <Row label="Summarise after" help="About 4 characters per token.">
              <NumberField value={s.compactionThresholdChars} min={20000} step={10000} suffix="chars" onChange={(v) => set({ compactionThresholdChars: v })} />
            </Row>
          </Card>
        </div>
      </div>

      {/* sticky save bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t backdrop-blur-[10px]" style={{ borderColor: "var(--rule-soft)", background: "rgba(10,13,26,0.94)" }}>
        <div className="container-x flex items-center justify-end gap-4 py-3">
          <span className="ui text-[0.78rem]" style={{ color: msg?.bad ? "var(--bad)" : msg ? "var(--good)" : "var(--ink-mute)" }}>
            {msg?.text ?? (dirty ? "Unsaved changes" : "All changes saved")}
          </span>
          {dirty && (
            <button className="btn" onClick={() => (setS(saved), setKeyInput({}), setMsg(null))}>
              Discard
            </button>
          )}
          <button className="btn btn-primary min-w-[150px]" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({ id, title, intro, children }: { id: string; title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="card scroll-mt-24">
      <div className="border-b px-6 py-4" style={{ borderColor: "var(--rule-soft)" }}>
        <h2 className="ui text-[0.78rem] uppercase tracking-[0.16em]" style={{ color: "var(--blue)" }}>{title}</h2>
        {intro && <p className="mt-1.5 text-[0.88rem]" style={{ color: "var(--ink-soft)" }}>{intro}</p>}
      </div>
      <div className="space-y-5 px-6 py-5">{children}</div>
    </section>
  );
}

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="grid items-center gap-x-6 gap-y-2 md:grid-cols-[240px_minmax(0,1fr)]">
      <div>
        <div className="text-[0.92rem]">{label}</div>
        {help && <div className="text-[0.8rem]" style={{ color: "var(--ink-mute)" }}>{help}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function NumberField({ value, min, step = 1, suffix, onChange }: { value: number; min: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <div className="inline-flex items-stretch border" style={{ borderColor: "var(--rule-soft)" }}>
      <input
        type="number"
        min={min}
        step={step}
        className="ui w-36 bg-[var(--bg)] px-3 py-2 text-[0.86rem] outline-none"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {suffix && (
        <span className="ui flex items-center border-l px-3 text-[0.68rem] uppercase tracking-[0.1em]" style={{ borderColor: "var(--rule-soft)", color: "var(--ink-mute)" }}>
          {suffix}
        </span>
      )}
    </div>
  );
}

function ProviderDetails({ s, set, probe }: { s: Settings; set: (p: Partial<Settings>) => void; probe?: { ok: boolean; version: string | null; path: string; note?: string } }) {
  const id = s.provider;
  const info = PROVIDERS[id];
  const path = id === "claude" ? s.claudePath : s.providers[id].path;
  const setPath = (v: string) => (id === "claude" ? set({ claudePath: v }) : set({ providers: { ...s.providers, [id]: { ...s.providers[id], path: v } } }));
  return (
    <div className="mt-2 space-y-5 border-t pt-5" style={{ borderColor: "var(--rule-soft)" }}>
      <Row label="Status">
        <span className="ui inline-flex items-center gap-2 text-[0.82rem]">
          <span className="inline-block h-2 w-2" style={{ background: probe?.ok ? "var(--good)" : probe ? "var(--bad)" : "var(--ink-mute)" }} />
          {probe
            ? probe.ok
              ? `Found ${probe.version}${probe.note ? ` · ${probe.note}` : ""}`
              : probe.note
                ? `Installed, but ${probe.note}. Install a newer Node.js (e.g. nvm install 22) or set its path below.`
                : `Not found (${probe.path}). Install it and sign in once in a terminal.`
            : "Checking…"}
        </span>
      </Row>
      <Row label="Executable" help={id === "copilot" ? 'Command name or path. "gh copilot" also works.' : "Command name or absolute path."}>
        <input className="field ui max-w-[420px] text-[0.86rem]" value={path} placeholder={info.defaultPath} onChange={(e) => setPath(e.target.value)} />
      </Row>
      {id !== "claude" && id !== "opencode" && (
        <Row label="Node.js" help="For JavaScript-based CLIs. Leave empty to auto-detect a suitable version (nvm, Homebrew, Volta).">
          <input
            className="field ui max-w-[420px] text-[0.86rem]"
            placeholder="auto-detected"
            value={s.providers[id].node ?? ""}
            onChange={(e) => set({ providers: { ...s.providers, [id]: { ...s.providers[id], node: e.target.value } } })}
          />
        </Row>
      )}
      <Row label="Connection" help="Runs one tiny request through this CLI using the saved settings.">
        <TestConnection provider={id} />
      </Row>
      <Row label="What it supports">
        <div className="ui grid max-w-[520px] grid-cols-[auto_1fr] gap-x-5 gap-y-1 text-[0.8rem]">
          <span style={{ color: "var(--ink-mute)" }}>Structured replies</span>
          <span>{info.schema === "native" ? "Enforced by the CLI (JSON Schema)" : "Requested in the prompt, then validated and retried"}</span>
          <span style={{ color: "var(--ink-mute)" }}>Your files</span>
          <span>{info.files}</span>
          <span style={{ color: "var(--ink-mute)" }}>Web research</span>
          <span>{info.web}</span>
          <span style={{ color: "var(--ink-mute)" }}>Docs</span>
          <a href={info.docs} target="_blank" rel="noreferrer" className="link truncate">{info.docs.replace(/^https:\/\//, "")}</a>
        </div>
      </Row>
    </div>
  );
}

function TestConnection({ provider }: { provider: ProviderId }) {
  const [state, setState] = useState<{ busy: boolean; result?: { ok: boolean; ms: number; model?: string | null; error?: string } }>({ busy: false });
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn"
        disabled={state.busy}
        onClick={async () => {
          setState({ busy: true });
          try {
            const r = await api<{ ok: boolean; ms: number; model?: string | null; error?: string }>("/api/providers/test", { method: "POST", json: { provider } });
            setState({ busy: false, result: r });
          } catch (e) {
            setState({ busy: false, result: { ok: false, ms: 0, error: (e as Error).message } });
          }
        }}
      >
        {state.busy ? "Testing… (up to a minute)" : "Test connection"}
      </button>
      {state.result && (
        <p className="ui text-[0.78rem] leading-relaxed" style={{ color: state.result.ok ? "var(--good)" : "var(--bad)" }}>
          {state.result.ok
            ? `Working · structured reply in ${(state.result.ms / 1000).toFixed(1)}s${state.result.model ? ` · model reports "${state.result.model}"` : ""}`
            : state.result.error}
        </p>
      )}
      <p className="text-[0.75rem]" style={{ color: "var(--ink-mute)" }}>Save settings first if you changed this provider.</p>
    </div>
  );
}

function SemanticStatus() {
  type St = { state: string; error?: string; downloaded: boolean; indexed?: number; ms?: number };
  const [st, setSt] = useState<St | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<St>("/api/graph/semantic").then(setSt).catch(() => {});
  }, []);
  const label = !st
    ? "Checking…"
    : st.state === "ready"
      ? `Ready${st.indexed !== undefined ? ` · ${st.indexed} claims indexed${st.ms ? ` in ${(st.ms / 1000).toFixed(1)}s` : ""}` : ""}`
      : st.state === "error"
        ? `Unavailable: ${st.error}. Word matching is used instead.`
        : st.state === "downloading"
          ? "Downloading the model…"
          : st.state === "loading"
            ? "Loading the model…"
            : st.downloaded
              ? "Model downloaded; loads on first use."
              : "Model not downloaded yet; it downloads on first use.";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="ui text-[0.78rem]" style={{ color: st?.state === "error" ? "var(--bad)" : st?.state === "ready" ? "var(--good)" : "var(--ink-mute)" }}>{label}</span>
      {st?.state !== "ready" && (
        <button
          type="button"
          className="btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setSt(await api<St>("/api/graph/semantic", { method: "POST" }));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Preparing…" : "Prepare now"}
        </button>
      )}
    </div>
  );
}
