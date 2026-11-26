"use client";

import { useMemo, useState } from "react";
import { sanitizeSvg, svgDataUrl, wrapDemoHtml } from "@/src/core/sanitize";
import type { DemoResult, Job, ResearchResult, VisualResult } from "@/src/core/types";
import { Markdown } from "./markdown";

const KIND_LABEL = { research: "Research", visual: "Visual", demo: "Interactive demo" } as const;

export function JobCard({ job }: { job: Job }) {
  return (
    <div className="card-feature overflow-hidden">
      <div className="flex items-center gap-2 border-b px-4 py-2 text-sm" style={{ borderColor: "var(--line)" }}>
        <span className="pill">{KIND_LABEL[job.kind]}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{job.title}</span>
        {job.status === "running" && (
          <span className="muted flex items-center gap-1 text-xs">
            <span className="dot" /> working in the background
          </span>
        )}
      </div>
      <div className="p-4">
        {job.status === "running" && <p className="muted text-sm">This will appear here when ready. Keep going with the lesson.</p>}
        {job.status === "failed" && <p className="text-sm" style={{ color: "var(--bad)" }}>Could not finish: {job.error}</p>}
        {job.status === "done" && job.kind === "research" && <Research r={job.result as ResearchResult} />}
        {job.status === "done" && job.kind === "visual" && <Visual r={job.result as VisualResult} />}
        {job.status === "done" && job.kind === "demo" && <Demo r={job.result as DemoResult} title={job.title} />}
      </div>
    </div>
  );
}

function Research({ r }: { r: ResearchResult }) {
  return (
    <div>
      <Markdown>{r.answer}</Markdown>
      {r.sources.length > 0 && (
        <ul className="muted mt-2 space-y-0.5 text-xs">
          {r.sources.map((s, i) => (
            <li key={i}>
              {/^https?:\/\//.test(s.url) ? (
                <a href={s.url} target="_blank" rel="noreferrer noopener" className="underline">{s.title || s.url}</a>
              ) : (
                s.title
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Visual({ r }: { r: VisualResult }) {
  const src = useMemo(() => {
    const svg = sanitizeSvg(r.svg);
    return svg ? svgDataUrl(svg) : null;
  }, [r.svg]);
  if (!src) return <p className="muted text-sm">The diagram could not be displayed.</p>;
  return (
    <figure>
      {/* <img> never executes script inside the SVG. */}
      <img src={src} alt={r.caption} className="mx-auto max-h-[520px] w-full bg-white object-contain" />
      <figcaption className="muted mt-2 text-sm">{r.caption}</figcaption>
    </figure>
  );
}

function Demo({ r, title }: { r: DemoResult; title: string }) {
  const [tall, setTall] = useState(false);
  const doc = useMemo(() => wrapDemoHtml(r.html), [r.html]);
  return (
    <div>
      <p className="mb-2 text-sm">{r.instructions}</p>
      <iframe
        title={title}
        srcDoc={doc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="w-full border bg-white"
        style={{ height: tall ? 720 : 440, borderColor: "var(--line)" }}
      />
      <button className="muted mt-1 text-xs underline" onClick={() => setTall((t) => !t)}>{tall ? "Smaller" : "Taller"}</button>
    </div>
  );
}
