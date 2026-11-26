"use client";

import { useEffect, useState } from "react";
import type { Attachment, Figure, FigureMark } from "@/src/core/types";

type Source = { src: string; w: number; h: number };

const fileUrl = (id: string) => `/api/files/${id}`;

// ─── loading the picture ────────────────────────────────────────────────────

const pdfCache = new Map<string, Promise<Source>>();

/** Render one PDF page to an image in the browser (pdf.js, loaded on demand). The
 *  page is rendered sharp enough that a cropped region still fills the figure. */
function renderPdfPage(id: string, page: number, cropW: number): Promise<Source> {
  const key = `${id}:${page}:${cropW.toFixed(2)}`;
  let p = pdfCache.get(key);
  if (!p) {
    p = (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/api/pdfjs/worker";
      const doc = await pdfjs.getDocument({ url: fileUrl(id), isEvalSupported: false }).promise;
      try {
        const pg = await doc.getPage(page);
        const base = pg.getViewport({ scale: 1 });
        // ~1400px across the visible region, capped to keep the canvas reasonable.
        let scale = Math.min(6, Math.max(1.5, 1400 / (base.width * cropW)));
        if (base.width * base.height * scale * scale > 24e6) scale = Math.sqrt(24e6 / (base.width * base.height));
        const vp = pg.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        await pg.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
        if (!blob) throw new Error("Could not render the page.");
        return { src: URL.createObjectURL(blob), w: canvas.width, h: canvas.height };
      } finally {
        void doc.destroy();
      }
    })();
    p.catch(() => pdfCache.delete(key));
    pdfCache.set(key, p);
  }
  return p;
}

function loadImage(id: string): Promise<Source> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ src: img.src, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not load the image."));
    img.src = fileUrl(id);
  });
}

// ─── drawing ────────────────────────────────────────────────────────────────

/** Pill label with dark text on the mark colour: legible over any picture. */
function Pill({ x, y, text, u, anchor = "middle" }: { x: number; y: number; text: string; u: number; anchor?: "middle" | "start" }) {
  const fs = 2.5 * u;
  const w = text.length * fs * 0.56 + 2 * u;
  const h = fs * 1.55;
  const left = anchor === "middle" ? x - w / 2 : x;
  return (
    <g>
      <rect x={left} y={y - h / 2} width={w} height={h} fill="var(--mark)" stroke="var(--mark-halo)" strokeWidth={0.25 * u} />
      <text x={left + w / 2} y={y} fontSize={fs} fontWeight={600} textAnchor="middle" dominantBaseline="central" fill="var(--mark-ink)" style={{ fontFamily: "var(--font-ui)" }}>
        {text}
      </text>
    </g>
  );
}

function Mark({ m, W, H, u, view }: { m: FigureMark; W: number; H: number; u: number; view: { x: number; y: number; w: number; h: number } }) {
  const sw = 0.5 * u;
  const line = { stroke: "var(--mark)", strokeWidth: sw, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const halo = { ...line, stroke: "var(--mark-halo)", strokeWidth: sw * 2.2, strokeOpacity: 0.35 };
  const X = (v: number) => v * W;
  const Y = (v: number) => v * H;
  // Keep labels inside the visible region.
  const keepX = (v: number) => Math.min(view.x + view.w - 6 * u, Math.max(view.x + 6 * u, v));
  const keepY = (v: number) => Math.min(view.y + view.h - 2 * u, Math.max(view.y + 2 * u, v));

  if (m.kind === "arrow" && m.x2 != null && m.y2 != null) {
    const [x1, y1, x2, y2] = [X(m.x), Y(m.y), X(m.x2), Y(m.y2)];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [dx, dy] = [(x2 - x1) / len, (y2 - y1) / len];
    const head = 2.4 * u;
    const bx = x2 - dx * head;
    const by = y2 - dy * head;
    const pts = `${x2},${y2} ${bx - dy * head * 0.6},${by + dx * head * 0.6} ${bx + dy * head * 0.6},${by - dx * head * 0.6}`;
    return (
      <g>
        <line x1={x1} y1={y1} x2={bx} y2={by} {...halo} />
        <polygon points={pts} fill="var(--mark-halo)" fillOpacity={0.35} stroke="var(--mark-halo)" strokeOpacity={0.35} strokeWidth={sw * 1.6} strokeLinejoin="round" />
        <line x1={x1} y1={y1} x2={bx} y2={by} {...line} />
        <polygon points={pts} fill="var(--mark)" />
        {m.text && <Pill x={keepX(x1 - dx * 3 * u)} y={keepY(y1 - dy * 2.4 * u)} text={m.text} u={u} />}
      </g>
    );
  }
  if ((m.kind === "box" || m.kind === "circle") && m.w && m.h) {
    const [x, y, w, h] = [X(m.x), Y(m.y), X(m.w), Y(m.h)];
    const shape =
      m.kind === "box"
        ? (p: object) => <rect x={x} y={y} width={w} height={h} {...p} />
        : (p: object) => <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...p} />;
    const above = y - 2.6 * u > view.y;
    return (
      <g>
        {shape(halo)}
        {shape(line)}
        {m.text && <Pill x={keepX(x)} y={above ? y - 2.4 * u : y + h + 2.4 * u} text={m.text} u={u} anchor="start" />}
      </g>
    );
  }
  if (m.kind === "label" && m.text) return <Pill x={keepX(X(m.x))} y={keepY(Y(m.y))} text={m.text} u={u} />;
  return null;
}

// ─── the figure ─────────────────────────────────────────────────────────────

/** One of the learner's own images or PDF pages, cropped to what matters, with the
 *  agent's arrows, boxes and labels drawn over it. */
export function AnnotatedFigure({ figure, file }: { figure: Figure; file?: Attachment }) {
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  const crop = figure.crop;

  const fileId = file?.id;
  const isPdf = file?.kind === "pdf";
  useEffect(() => {
    if (!fileId) return;
    let live = true;
    const load = isPdf ? renderPdfPage(fileId, figure.page ?? 1, crop?.w ?? 1) : loadImage(fileId);
    load.then(
      (s) => live && setSource(s),
      (e) => live && setError(e instanceof Error ? e.message : "Could not load the figure."),
    );
    return () => {
      live = false;
    };
  }, [fileId, isPdf, figure.page, crop?.w]);

  if (!file) return null;
  const where = `${file.name}${figure.page ? ` · page ${figure.page}` : ""}`;

  let body: React.ReactNode;
  if (error) body = <div className="ui faint px-4 py-8 text-center text-xs">{error}</div>;
  else if (!source) body = <div className="fig-loading" aria-label="Loading figure" />;
  else {
    const { w: W, h: H } = source;
    const c = !whole && crop ? crop : { x: 0, y: 0, w: 1, h: 1 };
    const view = { x: c.x * W, y: c.y * H, w: c.w * W, h: c.h * H };
    const u = view.w / 100;
    body = (
      <svg
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className="block w-full"
        style={{ aspectRatio: `${view.w} / ${view.h}`, maxHeight: "70vh" }}
        role="img"
        aria-label={[figure.caption, ...figure.marks.map((m) => m.text).filter(Boolean)].filter(Boolean).join(". ") || `Figure from ${where}`}
      >
        <image href={source.src} x={0} y={0} width={W} height={H} preserveAspectRatio="none" />
        {figure.marks.map((m, i) => (
          <g key={i} className="fig-mark" style={{ animationDelay: `${120 + i * 70}ms` }}>
            <Mark m={m} W={W} H={H} u={u} view={view} />
          </g>
        ))}
      </svg>
    );
  }

  return (
    <figure className="fig my-4 border" style={{ borderColor: "var(--rule-soft)", background: "var(--surface)" }}>
      <div className="fig-frame">{body}</div>
      <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t px-3.5 py-2.5" style={{ borderColor: "var(--rule-soft)" }}>
        {figure.caption && <span className="w-full text-[0.86rem]" style={{ color: "var(--ink-soft)" }}>{figure.caption}</span>}
        <span className="ui truncate text-[0.66rem] uppercase tracking-[0.1em]" style={{ color: "var(--ink-mute)" }}>From your file · {where}</span>
        <span className="flex-1" />
        {crop && source && (
          <button type="button" className="ui fig-link" onClick={() => setWhole((v) => !v)}>
            {whole ? "Zoom to region" : file.kind === "pdf" ? "Show whole page" : "Show whole image"}
          </button>
        )}
        <a className="ui fig-link" href={fileUrl(file.id) + (figure.page ? `#page=${figure.page}` : "")} target="_blank" rel="noreferrer">Open file ↗</a>
      </figcaption>
    </figure>
  );
}
