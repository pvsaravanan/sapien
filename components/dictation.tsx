"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "./api";

// Minimal typings for the Web Speech API (not in the DOM lib everywhere).
interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it in your browser's site settings.",
  "service-not-allowed": "Dictation isn't available in this browser.",
  "audio-capture": "No microphone was found.",
  network: "Dictation needs a network connection in this browser.",
  "language-not-supported": "Dictation doesn't support your browser's language.",
};

/** Where dictation happens, so the scribe can use the lesson as context. */
const DictationContext = createContext<{ sessionId?: string }>({});
export const DictationScope = DictationContext.Provider;

const join = (a: string, b: string) => (!a || /\s$/.test(a) || !b ? a + b : `${a} ${b}`);

type Phase = "idle" | "listening" | "polishing";

/** Speech-to-text into a controlled text value, using the browser's built-in speech
 *  recognition. Words are appended after whatever is already typed; interim words
 *  show live. When dictation ends, the scribe (an AI pass) fixes punctuation,
 *  fillers and misheard terms in the dictated part only; Undo restores the raw text. */
export function useDictation(value: string, onChange: (v: string) => void) {
  const { sessionId } = useContext(DictationContext);
  const [supported, setSupported] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ raw: string; cleaned: string } | null>(null);
  const rec = useRef<Recognition | null>(null);
  /** Typed text before dictation, text before the current utterance, last value written. */
  const prefix = useRef("");
  const base = useRef("");
  const written = useRef<string | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const change = useRef(onChange);
  change.current = onChange;
  const listening = phase === "listening";

  useEffect(() => setSupported(!!recognitionCtor()), []);

  const stop = useCallback(() => rec.current?.stop(), []);

  // The field was changed by something else (typing, or cleared on submit).
  useEffect(() => {
    if (!listening || written.current === null || value === written.current) return;
    if (!value.trim()) rec.current?.abort();
    base.current = value;
    written.current = value;
  }, [value, listening]);

  useEffect(() => () => rec.current?.abort(), []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  // Undo is offered briefly, and only while the text is still the cleaned version.
  useEffect(() => {
    if (!undo) return;
    if (value !== undo.cleaned) return setUndo(null);
    const t = setTimeout(() => setUndo(null), 10_000);
    return () => clearTimeout(t);
  }, [undo, value]);

  const polish = useCallback(
    async (full: string, before: string) => {
      const said = full.slice(before.length).trim();
      if (!said || !full.startsWith(before)) return setPhase("idle");
      setPhase("polishing");
      try {
        const res = await api<{ text: string; cleaned: boolean }>("/api/dictation", { method: "POST", json: { text: said, sessionId } });
        // Apply only if nothing changed the field while the scribe was working.
        if (res.cleaned && res.text && res.text !== said && latest.current === full) {
          const cleaned = join(before, res.text);
          change.current(cleaned);
          setUndo({ raw: full, cleaned });
        }
      } catch (err) {
        setError(`Couldn't clean up the dictation: ${err instanceof Error ? err.message : "unknown error"}`);
      } finally {
        setPhase((p) => (p === "polishing" ? "idle" : p));
      }
    },
    [sessionId],
  );

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    prefix.current = value;
    base.current = value;
    written.current = value;
    r.onresult = (e) => {
      let finals = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.trim();
        if (e.results[i].isFinal) finals = join(finals, t);
        else interim = join(interim, t);
      }
      if (finals) base.current = join(base.current, finals);
      const next = join(base.current, interim);
      written.current = next;
      change.current(next);
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") setError(ERRORS[e.error] ?? `Dictation stopped (${e.error}).`);
    };
    r.onend = () => {
      const aborted = rec.current === null;
      rec.current = null;
      written.current = null;
      const full = base.current;
      change.current(full);
      latest.current = full;
      if (aborted || !full.trim()) setPhase("idle");
      else void polish(full, prefix.current);
    };
    setError(null);
    setUndo(null);
    try {
      r.start();
      rec.current = r;
      setPhase("listening");
    } catch {
      setError("Dictation couldn't start.");
    }
  }, [value, polish]);

  return {
    supported,
    phase,
    listening,
    error,
    undo: undo ? () => (change.current(undo.raw), setUndo(null)) : null,
    start,
    stop,
    toggle: () => (listening ? stop() : phase === "idle" ? start() : undefined),
  };
}

function MicIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}

/** Mic toggle for a text box. Hidden in browsers without speech recognition. */
export function DictateButton({ value, onChange, label = "Dictate", compact }: { value: string; onChange: (v: string) => void; label?: string; compact?: boolean }) {
  const d = useDictation(value, onChange);
  if (!d.supported) return null;
  const polishing = d.phase === "polishing";
  const text = d.listening ? "Listening" : polishing ? "Polishing…" : label;
  return (
    <span className="relative inline-flex items-center gap-1.5">
      {d.undo && (
        <button type="button" className="copy-chip dictate-undo" data-on="false" onClick={d.undo} title="Put back exactly what was heard">
          Undo clean-up
        </button>
      )}
      <button
        type="button"
        className="copy-chip dictate"
        data-on={d.listening}
        data-busy={polishing}
        aria-pressed={d.listening}
        aria-label={d.listening ? "Stop dictation" : polishing ? "Cleaning up dictation" : "Start dictation"}
        title={d.error ?? (d.listening ? "Listening… click to stop" : polishing ? "Fixing punctuation and misheard words" : "Dictate with your microphone")}
        disabled={polishing}
        onClick={d.toggle}
      >
        {d.listening ? <span className="dictate-dot" aria-hidden="true" /> : polishing ? <span className="dictate-spin" aria-hidden="true" /> : <MicIcon />}
        {(!compact || polishing) && <span>{text}</span>}
      </button>
      <span className="sr-only" aria-live="polite">{polishing ? "Cleaning up dictation" : d.undo ? "Dictation cleaned up" : ""}</span>
      {d.error && (
        <span role="alert" className="dictate-error ui">
          {d.error}
        </span>
      )}
    </span>
  );
}
