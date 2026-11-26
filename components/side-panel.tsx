"use client";

import { useState } from "react";
import type { SideMessage } from "@/src/core/types";
import { api } from "./api";
import { DictateButton } from "./dictation";
import { Markdown } from "./markdown";

export function SidePanel({ sessionId, initial, onClose }: { sessionId: string; initial: SideMessage[]; onClose: () => void }) {
  const [messages, setMessages] = useState(initial);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    if (!q.trim() || busy) return;
    const question = q;
    setQ("");
    setBusy(true);
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, at: "", from: "learner", text: question }]);
    try {
      const d = await api<{ side: SideMessage[] }>(`/api/sessions/${sessionId}/side`, { method: "POST", json: { question } });
      setMessages(d.side);
    } catch (e) {
      setMessages((m) => [...m, { id: `err-${Date.now()}`, at: "", from: "helper", text: `⚠️ ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card-lift flex max-h-[70vh] flex-col p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="label">Side questions</span>
        <button className="muted text-xs underline" onClick={onClose}>close</button>
      </div>
      <p className="muted mb-2 text-xs">Quick answers that don't move the lesson forward. Your teacher sees these as context.</p>
      <div className="mb-2 flex-1 space-y-2 overflow-y-auto text-sm">
        {messages.map((m) => (
          <div key={m.id} className={m.from === "learner" ? "ui ml-6 border px-3 py-1.5 text-[0.85rem]" : ""} style={m.from === "learner" ? { borderColor: "var(--line-strong)", background: "var(--bg)" } : undefined}>
            {m.from === "learner" ? m.text : <Markdown className="text-sm">{m.text}</Markdown>}
          </div>
        ))}
        {busy && <span className="dot" />}
      </div>
      <div className="mb-1.5 flex justify-end">
        <DictateButton value={q} onChange={setQ} label="Dictate question" />
      </div>
      <textarea
        className="field min-h-14 text-sm"
        placeholder="e.g. What does that symbol mean?"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            ask();
          }
        }}
      />
    </div>
  );
}
