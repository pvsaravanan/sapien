"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Graph } from "@/src/core/types";
import { api } from "./api";
import { GraphCanvas } from "./graph-canvas";
import { ChainsModal, ImportModal, PropositionCard, type Source } from "./graph-panels";
import { IconChains, IconSearch, IconUpload } from "./icons";
import { notifySidebar } from "./top-nav";

export function GraphExplorer() {
  const router = useRouter();
  const params = useSearchParams();
  const [data, setData] = useState<{ graph: Graph; sources: Source[] } | null>(null);
  const [search, setSearch] = useState("");
  const [focused, setFocused] = useState<string | null>(params.get("node"));
  const [practice, setPractice] = useState(params.get("practice") === "1");
  const [seeds, setSeeds] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<"chains" | "import" | null>(params.get("import") === "1" ? "import" : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<{ graph: Graph; sources: Source[] }>("/api/graph").then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  // Ranked search by meaning (server, debounced) plus instant substring matches.
  const [ranked, setRanked] = useState<{ mode: string; results: { id: string; score: number }[] } | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  useEffect(() => {
    const q = search.trim();
    if (!q) return setRanked(null);
    const t = setTimeout(() => {
      api<{ mode: string; results: { id: string; score: number }[] }>(`/api/graph/search?q=${encodeURIComponent(q)}&k=15`)
        .then(setRanked)
        .catch(() => setRanked(null));
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  const substring = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !data) return [] as string[];
    return data.graph.propositions.filter((p) => `${p.name} ${p.statement} ${p.aliases.join(" ")}`.toLowerCase().includes(q)).map((p) => p.id);
  }, [search, data]);
  const highlight = useMemo(() => {
    if (!search.trim()) return null;
    return new Set([...substring, ...(ranked?.results ?? []).slice(0, 8).map((r) => r.id)]);
  }, [search, substring, ranked]);
  const resultList = useMemo(() => {
    const byId = new Map((data?.graph.propositions ?? []).map((p) => [p.id, p]));
    const scored = new Map((ranked?.results ?? []).map((r) => [r.id, r.score]));
    const ids = [...new Set([...(ranked?.results ?? []).map((r) => r.id), ...substring])];
    return ids.map((id) => ({ p: byId.get(id)!, score: scored.get(id) })).filter((r) => r.p).slice(0, 12);
  }, [ranked, substring, data]);

  const click = (id: string) => {
    if (practice)
      setSeeds((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    setFocused(id);
  };

  async function startPractice() {
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>("/api/sessions", { method: "POST", json: { kind: "practice", topic: "", seedNodeIds: [...seeds] } });
      notifySidebar();
      router.push(`/session/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const graph = data?.graph;
  const fp = graph?.propositions.find((p) => p.id === focused);
  return (
    <div className="container-x flex h-[calc(100vh-4rem)] flex-col py-5">
      <div className="flex flex-wrap items-end gap-4 pb-4">
        <div className="min-w-0 flex-1">
          <div className="label whitespace-nowrap">{graph?.propositions.length ?? 0} propositions · {graph?.chains.length ?? 0} chains</div>
          <h1 className="title-serif mt-2 text-[2.4rem] leading-none" style={{ color: "var(--accent)" }}>What you know, and why</h1>
        </div>
        <div className="relative w-80">
          <label className="ui flex items-center gap-2 border px-3 py-2 text-sm" style={{ borderColor: "var(--line-strong)", background: "var(--panel)" }}>
            <IconSearch size={15} />
            <input
              className="w-full bg-transparent outline-none placeholder:text-[var(--faint)]"
              placeholder="Search by meaning…"
              value={search}
              onChange={(e) => (setSearch(e.target.value), setResultsOpen(true))}
              onFocus={() => setResultsOpen(true)}
              onKeyDown={(e) => e.key === "Escape" && setResultsOpen(false)}
            />
            {ranked && <span className="faint whitespace-nowrap text-[0.64rem] uppercase tracking-[0.1em]">{ranked.mode === "meaning" ? "meaning" : "words"}</span>}
          </label>
          {resultsOpen && search.trim() && (
            <div className="card-lift absolute left-0 right-0 top-full z-20 mt-1 max-h-80 overflow-y-auto">
              {resultList.length === 0 ? (
                <div className="ui px-3 py-2.5 text-xs" style={{ color: "var(--ink-mute)" }}>{ranked ? "No matching claims." : "Searching…"}</div>
              ) : (
                resultList.map(({ p, score }) => (
                  <button
                    key={p.id}
                    className="block w-full border-b px-3 py-2 text-left hover:bg-[var(--blue-tint)]"
                    style={{ borderColor: "var(--rule-soft)" }}
                    onClick={() => (setFocused(p.id), setResultsOpen(false))}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[0.88rem]">{p.name}</span>
                      {score !== undefined && (
                        <span className="h-1 w-12 shrink-0" style={{ background: "var(--rule-soft)" }}>
                          <span className="block h-1" style={{ width: `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`, background: "var(--blue)" }} />
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[0.76rem]" style={{ color: "var(--ink-mute)" }}>{p.statement}</div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <button className="btn" onClick={() => setModal("chains")}><IconChains /> Chains</button>
        <button className="btn" onClick={() => setModal("import")}><IconUpload /> Import notes</button>
        <button className="btn" data-on={practice} style={practice ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined} onClick={() => (setPractice((p) => !p), setSeeds(new Set()))}>
          {practice ? "Selecting for practice" : "Practice from graph"}
        </button>
      </div>
      {error && <p className="ui pb-2 text-xs" style={{ color: "var(--bad)" }}>{error}</p>}

      <div className="relative min-h-0 flex-1 border" style={{ borderColor: "var(--frame)", background: "var(--bg)" }}>
        {graph && graph.propositions.length > 0 ? (
          <GraphCanvas graph={graph} highlight={highlight} selected={seeds} focused={focused} onNodeClick={click} />
        ) : (
          <div className="ui faint flex h-full items-center justify-center text-sm">
            {graph ? "Nothing yet. Finish a lesson or import notes." : "Loading…"}
            <span className="cursor-blink ml-1" />
          </div>
        )}
        {fp && graph && (
          <div className="absolute left-4 top-4 w-[340px]">
            <PropositionCard
              p={fp}
              graph={graph}
              sources={data!.sources}
              onSelect={setFocused}
              onClose={() => setFocused(null)}
              onDelete={async () => {
                await api(`/api/graph?node=${encodeURIComponent(fp.id)}`, { method: "DELETE" }).catch((e) => setError(e.message));
                setFocused(null);
                load();
              }}
            />
          </div>
        )}
        {practice && (
          <div className="card-lift absolute bottom-4 left-4 flex items-center gap-4 px-4 py-3">
            <span className="ui text-xs">
              {seeds.size ? `${seeds.size} node${seeds.size > 1 ? "s" : ""} selected` : "Click nodes to choose practice material"}
            </span>
            {seeds.size > 0 && <button className="ui faint text-xs underline" onClick={() => setSeeds(new Set())}>clear</button>}
            <button className="btn btn-primary" disabled={!seeds.size || busy} onClick={startPractice}>{busy ? "Starting…" : "Start practice →"}</button>
          </div>
        )}
      </div>

      {modal === "chains" && data && (
        <ChainsModal
          graph={data.graph}
          sources={data.sources}
          onClose={() => setModal(null)}
          onSelect={(id) => (setFocused(id), setModal(null))}
          onRemoveSource={async (id) => {
            await api(`/api/graph?source=${encodeURIComponent(id)}`, { method: "DELETE" }).catch((e) => setError(e.message));
            load();
          }}
        />
      )}
      {modal === "import" && <ImportModal onClose={() => setModal(null)} onDone={() => (load(), setModal(null))} />}
    </div>
  );
}
