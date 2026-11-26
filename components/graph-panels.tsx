"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Graph, Proposition } from "@/src/core/types";
import { api } from "./api";
import { IconClose } from "./icons";

export interface Source {
  id: string;
  name: string;
  kind: "teach" | "practice" | "notes";
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(5,6,14,0.75)] p-6" onMouseDown={onClose}>
      <div className={`card-lift flex max-h-[85vh] w-full flex-col ${wide ? "max-w-3xl" : "max-w-xl"}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3" style={{ borderColor: "var(--line)" }}>
          <span className="label">{title}</span>
          <button className="muted hover:text-white" onClick={onClose}><IconClose /></button>
        </div>
        <div className="scroll-thin overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function PropositionCard({
  p,
  graph,
  sources,
  onSelect,
  onClose,
  onDelete,
}: {
  p: Proposition;
  graph: Graph;
  sources: Source[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const byId = new Map(graph.propositions.map((x) => [x.id, x]));
  const because = graph.chains.filter((c) => c.conclusion === p.id);
  const leadsTo = graph.chains.filter((c) => c.premises.includes(p.id));
  const srcName = (id: string) => sources.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="card space-y-3 p-4 text-[0.95rem]" style={{ background: "var(--panel)" }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{p.name}</div>
          {p.aliases.length > 0 && <div className="ui faint text-xs">also: {p.aliases.join(", ")}</div>}
        </div>
        <button className="muted hover:text-white" onClick={onClose}><IconClose size={14} /></button>
      </div>
      <p className="muted">{p.statement}</p>
      {because.length > 0 && (
        <div>
          <div className="label">Follows from</div>
          {because.map((c) => (
            <div key={c.id} className="mt-1 text-sm">
              {c.premises.map((x, i) => (
                <span key={x}>
                  {i > 0 && <span className="faint"> + </span>}
                  <button className="underline decoration-[var(--faint)] underline-offset-2" onClick={() => onSelect(x)}>{byId.get(x)?.name ?? x}</button>
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
      {leadsTo.length > 0 && (
        <div>
          <div className="label">Leads to</div>
          {leadsTo.map((c) => (
            <div key={c.id} className="mt-1 text-sm">
              <button className="underline decoration-[var(--faint)] underline-offset-2" onClick={() => onSelect(c.conclusion)}>{byId.get(c.conclusion)?.name ?? c.conclusion}</button>
            </div>
          ))}
        </div>
      )}
      <div>
        <div className="label">Sources</div>
        {p.provenance.map((pr, i) => (
          <div key={i} className="mt-1 text-sm">
            {pr.source.startsWith("notes:") ? srcName(pr.source) : <Link href={`/session/${pr.source}`} className="underline decoration-[var(--faint)] underline-offset-2">{srcName(pr.source)}</Link>}
          </div>
        ))}
      </div>
      <button className="ui faint text-xs hover:text-white" onClick={onDelete}>Delete proposition</button>
    </div>
  );
}

export function ChainsModal({
  graph,
  sources,
  onClose,
  onSelect,
  onRemoveSource,
}: {
  graph: Graph;
  sources: Source[];
  onClose: () => void;
  onSelect: (id: string) => void;
  onRemoveSource: (id: string) => void;
}) {
  const [tab, setTab] = useState<"chains" | "sources">("chains");
  const [confirm, setConfirm] = useState<string | null>(null);
  const byId = new Map(graph.propositions.map((p) => [p.id, p]));
  const counts = new Map<string, number>();
  for (const p of graph.propositions) for (const pr of p.provenance) counts.set(pr.source, (counts.get(pr.source) ?? 0) + 1);
  return (
    <Modal title="Knowledge" onClose={onClose} wide>
      <div className="seg mb-4">
        <button data-on={tab === "chains"} onClick={() => setTab("chains")}>Chains</button>
        <button data-on={tab === "sources"} onClick={() => setTab("sources")}>Sources</button>
      </div>
      {tab === "chains" && (
        <div className="space-y-2">
          {graph.chains.length === 0 && <p className="muted text-sm">No reasoning chains yet.</p>}
          {graph.chains.map((c) => (
            <div key={c.id} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }}>
              {c.premises.map((p, i) => (
                <span key={p}>
                  {i > 0 && <span className="faint"> + </span>}
                  <button className="hover:underline" onClick={() => onSelect(p)}>{byId.get(p)?.name ?? p}</button>
                </span>
              ))}
              <span className="faint px-2">⇒</span>
              <button className="font-semibold hover:underline" onClick={() => onSelect(c.conclusion)}>{byId.get(c.conclusion)?.name ?? c.conclusion}</button>
            </div>
          ))}
        </div>
      )}
      {tab === "sources" && (
        <div className="space-y-2">
          {sources.filter((s) => counts.get(s.id)).map((s) => (
            <div key={s.id} className="flex items-center gap-3 border px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }}>
              <span className="pill">{s.kind}</span>
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="ui faint text-xs">{counts.get(s.id)}</span>
              {confirm === s.id ? (
                <>
                  <button className="ui text-xs" style={{ color: "var(--bad)" }} onClick={() => (onRemoveSource(s.id), setConfirm(null))}>confirm remove</button>
                  <button className="ui faint text-xs" onClick={() => setConfirm(null)}>cancel</button>
                </>
              ) : (
                <button className="ui faint text-xs hover:text-white" onClick={() => setConfirm(s.id)} title="Remove what this source contributed; knowledge supported elsewhere is kept">remove</button>
              )}
            </div>
          ))}
          {!sources.some((s) => counts.get(s.id)) && <p className="muted text-sm">No sources have contributed yet.</p>}
        </div>
      )}
    </Modal>
  );
}

export function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const readFile = async (f: File) => {
    setMsg(null);
    setName(f.name);
    if (/\.(pdf|png|jpe?g|gif|webp)$/i.test(f.name)) {
      // PDFs and images are read by the extractor directly, figures included.
      const form = new FormData();
      form.append("file", f);
      setBusy(true);
      try {
        const res = await fetch("/api/files", { method: "POST", body: form });
        const data = (await res.json()) as { files?: { id: string }[]; error?: string };
        if (!res.ok || !data.files?.[0]) throw new Error(data.error ?? "Upload failed");
        setFileId(data.files[0].id);
        setText("");
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (f.size > 2_000_000) return setMsg("Text files up to 2 MB are supported.");
    setFileId(null);
    setText(await f.text());
  };
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ stats: { added: number; linked: number; chainsAdded: number } }>("/api/graph/import", {
        method: "POST",
        json: fileId ? { name, fileId } : { name, text },
      });
      setMsg(`Added ${r.stats.added} propositions, matched ${r.stats.linked} existing, ${r.stats.chainsAdded} chains.`);
      setTimeout(onDone, 1200);
    } catch (e) {
      setMsg((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Import notes" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="muted text-sm">Paste notes, or choose a PDF, slide image, or text/Markdown file. An extractor agent adds their claims and reasoning to your graph.</p>
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.markdown,text/plain,text/markdown" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} className="ui text-xs" />
        {fileId && <p className="ui text-xs" style={{ color: "var(--blue)" }}>Ready to extract from {name}.</p>}
        <input className="field" placeholder="Name (e.g. Linear algebra, lecture 3)" value={name} onChange={(e) => setName(e.target.value)} />
        {!fileId && <textarea className="field ui min-h-56 text-sm" placeholder="Notes…" value={text} onChange={(e) => setText(e.target.value)} />}
        <div className="flex items-center gap-3">
          <button className="btn btn-primary" disabled={busy || (!text.trim() && !fileId)} onClick={submit}>{busy ? "Extracting…" : "Import"}</button>
          {msg && <span className="text-sm">{msg}</span>}
        </div>
      </div>
    </Modal>
  );
}
