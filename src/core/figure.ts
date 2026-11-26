// Annotated learner figures: an agent points at part of the learner's own image or
// PDF page. Pure checks and mapping; rendering lives in components/annotated-figure.tsx.

import type { Figure, FigureMark } from "./types";

/** What the agent wrote: files are referenced by their LEARNER FILE number. */
export interface FigureDraft {
  file: number;
  page?: number;
  crop?: { x: number; y: number; w: number; h: number };
  marks?: FigureMark[];
  caption?: string;
}

/** What an agent can see of each learner file, indexed by LEARNER FILE number - 1. */
export interface FileView {
  id: string;
  name: string;
  kind: "pdf" | "image" | "text";
  pages?: number;
  /** False when the file was left out of the request (size budget). */
  sent: boolean;
  /** PDFs sent as extracted text: the agent cannot see layout. */
  textOnly?: boolean;
}

export const MAX_MARKS = 8;
const MAX_TEXT = 40;
const EPS = 0.02;

const frac = (v: number | undefined) => typeof v === "number" && Number.isFinite(v) && v >= -EPS && v <= 1 + EPS;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Problems with a figure, phrased for the agent's corrective retry. */
export function figureProblems(f: FigureDraft, files: FileView[]): string[] {
  const out: string[] = [];
  const file = files[f.file - 1];
  if (!file) return [`figure.file must be a LEARNER FILE number (1–${files.length}); there is no file ${f.file}.`];
  if (!file.sent) return [`LEARNER FILE ${f.file} was not included in this request; you cannot show it.`];
  if (file.kind === "text") return [`LEARNER FILE ${f.file} is a text file; figures need an image or a PDF.`];
  if (file.kind === "pdf") {
    if (!f.page) out.push("figure.page (1-based) is required for a PDF.");
    else if (f.page < 1 || (file.pages && f.page > file.pages)) out.push(`figure.page ${f.page} is out of range (1–${file.pages ?? "?"}).`);
    if (file.textOnly && (f.crop || f.marks?.length))
      out.push("You only receive this PDF's text, not its layout, so you cannot place a crop or marks. Show the whole page (crop and marks null).");
  }
  const c = f.crop;
  if (c) {
    if (![c.x, c.y, c.w, c.h].every(frac)) out.push("figure.crop values must be fractions between 0 and 1.");
    else if (c.w < 0.05 || c.h < 0.05) out.push("figure.crop is too small; include some context (w and h at least 0.05).");
    else if (c.x + c.w > 1 + EPS || c.y + c.h > 1 + EPS) out.push("figure.crop extends past the page/image edge.");
  }
  const marks = f.marks ?? [];
  if (marks.length > MAX_MARKS) out.push(`Use at most ${MAX_MARKS} marks.`);
  marks.forEach((m, i) => {
    const at = `figure.marks[${i}] (${m.kind})`;
    const pts: [number, number][] = [[m.x, m.y]];
    if (!frac(m.x) || !frac(m.y)) out.push(`${at}: x and y must be fractions between 0 and 1.`);
    if (m.kind === "arrow") {
      if (!frac(m.x2) || !frac(m.y2)) out.push(`${at}: an arrow needs x2,y2 (its head) as fractions between 0 and 1.`);
      else {
        pts.push([m.x2!, m.y2!]);
        if (Math.hypot(m.x2! - m.x, m.y2! - m.y) < 0.03) out.push(`${at}: the arrow is too short; start its tail further away.`);
      }
    }
    if (m.kind === "box" || m.kind === "circle") {
      if (!frac(m.w) || !frac(m.h) || !m.w || !m.h) out.push(`${at}: needs w and h (fractions greater than 0).`);
      else pts.push([m.x + m.w, m.y + m.h]);
    }
    if (m.kind === "label" && !m.text?.trim()) out.push(`${at}: a label needs text.`);
    if (m.text && m.text.length > MAX_TEXT) out.push(`${at}: keep mark text under ${MAX_TEXT} characters; explain in your message.`);
    if (c && pts.some(([px, py]) => px < c.x - EPS || px > c.x + c.w + EPS || py < c.y - EPS || py > c.y + c.h + EPS))
      out.push(`${at} lies outside figure.crop; widen the crop or move the mark (both use full-page fractions).`);
  });
  return out;
}

/** Validated draft → stored figure (file number resolved, values clamped). */
export function toFigure(f: FigureDraft, files: FileView[]): Figure {
  const file = files[f.file - 1];
  const crop = f.crop && { x: clamp01(f.crop.x), y: clamp01(f.crop.y), w: clamp01(f.crop.w), h: clamp01(f.crop.h) };
  return {
    fileId: file.id,
    page: file.kind === "pdf" ? f.page : undefined,
    crop: crop && { ...crop, w: Math.min(crop.w, 1 - crop.x), h: Math.min(crop.h, 1 - crop.y) },
    marks: (f.marks ?? []).slice(0, MAX_MARKS).map((m) => ({
      kind: m.kind,
      x: clamp01(m.x),
      y: clamp01(m.y),
      ...(m.kind === "arrow" ? { x2: clamp01(m.x2!), y2: clamp01(m.y2!) } : {}),
      ...(m.kind === "box" || m.kind === "circle" ? { w: clamp01(m.w!), h: clamp01(m.h!) } : {}),
      ...(m.text?.trim() ? { text: m.text.trim() } : {}),
    })),
    caption: f.caption?.trim() || undefined,
  };
}

/** How the figure appears in agent transcripts. */
export function figureText(f: Figure, fileName?: string): string {
  const where = `${fileName ?? f.fileId}${f.page ? `, page ${f.page}` : ""}`;
  const marks = f.marks.map((m) => `${m.kind}${m.text ? ` "${m.text}"` : ""}`).join(", ");
  return `[showed the learner their figure from ${where}${f.crop ? " (cropped)" : ""}${marks ? ` with marks: ${marks}` : ""}${f.caption ? `. Caption: ${f.caption}` : ""}]`;
}
