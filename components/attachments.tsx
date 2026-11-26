"use client";

import { useCallback, useRef, useState } from "react";
import type { Attachment } from "@/src/core/types";

export const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.markdown,.csv,.json,.tex,.py,.js,.ts,.java,.c,.cpp,.go,.rs,.sql,.html,.css,.ipynb";

/** Upload state for files the learner is about to send. */
export function useAttachments() {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(async (list: FileList | File[]) => {
    const picked = [...list];
    if (!picked.length) return;
    setError(null);
    setUploading((n) => n + picked.length);
    try {
      const form = new FormData();
      for (const f of picked) form.append("file", f);
      const res = await fetch("/api/files", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as { files?: Attachment[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
      setFiles((cur) => [...cur, ...(data.files ?? [])]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading((n) => n - picked.length);
    }
  }, []);

  return {
    files,
    ids: files.map((f) => f.id),
    uploading: uploading > 0,
    error,
    add,
    remove: (id: string) => setFiles((cur) => cur.filter((f) => f.id !== id)),
    clear: () => (setFiles([]), setError(null)),
  };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

function kindLabel(f: Attachment) {
  return f.kind === "pdf" ? `PDF${f.pages ? ` · ${f.pages}p` : ""}` : f.kind === "image" ? "IMG" : "TXT";
}

export function PaperclipIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 11.5 12.6 19.9a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6L15.3 7" />
    </svg>
  );
}

/** Paperclip button that opens the file picker. */
export function AttachButton({ state, label = "Attach" }: { state: AttachmentsState; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="copy-chip" data-on="false" title="Attach PDFs, slides, images or notes" onClick={() => input.current?.click()} disabled={state.uploading}>
        <PaperclipIcon size={12} /> {state.uploading ? "Uploading…" : label}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          if (e.target.files) void state.add(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** Chips for files queued to send (removable). */
export function PendingFiles({ state }: { state: AttachmentsState }) {
  if (!state.files.length && !state.error) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {state.files.map((f) => (
        <span key={f.id} className="ui inline-flex items-center gap-2 border px-2 py-1 text-[0.72rem]" style={{ borderColor: "var(--blue)", color: "var(--ink)", background: "var(--bg)" }}>
          <span style={{ color: "var(--blue)" }}>{kindLabel(f)}</span>
          <span className="max-w-[220px] truncate">{f.name}</span>
          <button type="button" className="faint hover:text-[var(--ink)]" title="Remove" onClick={() => state.remove(f.id)}>
            ×
          </button>
        </span>
      ))}
      {state.error && <span className="ui text-[0.72rem]" style={{ color: "var(--bad)" }}>{state.error}</span>}
    </div>
  );
}

/** Read-only chips linking to stored files. */
export function FileChips({ ids, files }: { ids: string[]; files: Attachment[] }) {
  const list = ids.map((id) => files.find((f) => f.id === id)).filter((f): f is Attachment => !!f);
  if (!list.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {list.map((f) => (
        <a
          key={f.id}
          href={`/api/files/${f.id}`}
          target="_blank"
          rel="noreferrer"
          className="ui inline-flex items-center gap-2 border px-2 py-1 text-[0.72rem] hover:border-[var(--blue)]"
          style={{ borderColor: "var(--rule-soft)", color: "var(--ink)" }}
        >
          <PaperclipIcon size={11} />
          <span style={{ color: "var(--blue)" }}>{kindLabel(f)}</span>
          <span className="max-w-[240px] truncate">{f.name}</span>
        </a>
      ))}
    </div>
  );
}

/** Drag-and-drop wrapper: drop files anywhere inside to attach them. */
export function DropZone({ state, children, className = "" }: { state: AttachmentsState; children: React.ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`relative ${className}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setOver(false);
        void state.add(e.dataTransfer.files);
      }}
    >
      {children}
      {over && (
        <div className="ui pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed text-sm uppercase tracking-[0.14em]" style={{ borderColor: "var(--blue)", background: "rgba(10,13,26,0.85)", color: "var(--blue)" }}>
          Drop files to attach
        </div>
      )}
    </div>
  );
}
