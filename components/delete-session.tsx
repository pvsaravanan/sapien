"use client";

import { useState } from "react";
import { api } from "./api";
import { Modal } from "./graph-panels";
import { Toggle } from "./controls";

/** Confirmation dialog for deleting a session (optionally with its graph contributions). */
export function DeleteSessionDialog({
  session,
  onClose,
  onDeleted,
}: {
  session: { id: string; title: string; running?: boolean };
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [removeGraph, setRemoveGraph] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const del = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/sessions/${session.id}${removeGraph ? "?graph=remove" : ""}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Delete session" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[1rem]">
          Delete <span className="font-semibold">{session.title}</span>? Its transcript, lesson map, files and background results will be removed. This
          can&apos;t be undone.
        </p>
        {session.running && <p className="ui text-xs" style={{ color: "var(--warn)" }}>An agent is working on this session right now; it will be stopped.</p>}
        <label className="flex items-start gap-3 text-[0.9rem]">
          <Toggle label="Also remove from knowledge graph" value={removeGraph} onChange={setRemoveGraph} />
          <span>
            Also remove what this session added to my knowledge graph
            <span className="block text-[0.8rem]" style={{ color: "var(--ink-mute)" }}>
              Claims also supported by other lessons or notes are kept.
            </span>
          </span>
        </label>
        {error && <p className="ui text-xs" style={{ color: "var(--bad)" }}>{error}</p>}
        <div className="flex justify-end gap-3 pt-1">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" style={{ borderColor: "var(--bad)", color: "var(--bad)" }} onClick={del} disabled={busy}>
            {busy ? "Deleting…" : "Delete session"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
