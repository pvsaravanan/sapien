import fs from "node:fs";
import path from "node:path";
import { PROVIDERS } from "../core/provider-info";
import type { Attachment, AttachmentKind, Settings } from "../core/types";
import { DATA_DIR } from "./store";

/** Learner files live in data/files/<id>/{file,meta.json}. They reach the model only as
 *  content blocks inside the request; agents never get filesystem tools. */
const FILES_DIR = path.join(DATA_DIR, "files");

export class FileError extends Error {}

const LIMITS: Record<AttachmentKind, number> = {
  pdf: 20 * 1024 * 1024,
  image: 5 * 1024 * 1024,
  text: 1024 * 1024,
};
/** Raw bytes of files sent with one model request (the API caps whole requests). */
const REQUEST_BUDGET = 22 * 1024 * 1024;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|tex|py|js|ts|tsx|jsx|java|c|h|cpp|hpp|cs|go|rs|rb|php|swift|kt|scala|sql|sh|r|m|jl|html|css|xml|ipynb|org|rst)$/i;

function sniff(name: string, buf: Buffer): { kind: AttachmentKind; mime: string } {
  const head = buf.subarray(0, 16);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return { kind: "image", mime: "image/png" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return { kind: "image", mime: "image/gif" };
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return { kind: "image", mime: "image/webp" };
  if (TEXT_EXT.test(name) && !buf.subarray(0, 8192).includes(0)) return { kind: "text", mime: "text/plain" };
  throw new FileError(`Unsupported file "${name}". Use PDF, PNG/JPEG/GIF/WEBP images, or text/Markdown/code files.`);
}

/** Best-effort page count (uncompressed page objects); undefined when unknown. */
function pdfPages(buf: Buffer): number | undefined {
  const n = (buf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  return n > 0 ? n : undefined;
}

const SAFE_ID = /^[a-f0-9]{16}$/;

export function saveFile(rawName: string, buf: Buffer): Attachment {
  const name = path.basename(rawName || "file").replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file";
  if (!buf.length) throw new FileError(`"${name}" is empty.`);
  const { kind, mime } = sniff(name, buf);
  if (buf.length > LIMITS[kind]) throw new FileError(`"${name}" is too large (limit ${LIMITS[kind] / 1024 / 1024} MB for ${kind} files).`);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const dir = path.join(FILES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "file"), buf);
  const meta: Attachment = { id, name, kind, mime, size: buf.length, createdAt: new Date().toISOString(), pages: kind === "pdf" ? pdfPages(buf) : undefined };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export function getFile(id: string): Attachment | null {
  if (!SAFE_ID.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(FILES_DIR, id, "meta.json"), "utf8")) as Attachment;
  } catch {
    return null;
  }
}

export function readFileBytes(id: string): Buffer | null {
  if (!SAFE_ID.test(id)) return null;
  try {
    return fs.readFileSync(path.join(FILES_DIR, id, "file"));
  } catch {
    return null;
  }
}

/** Extract and cache a PDF's text (data/files/<id>/text.txt). Best effort. */
export async function ensurePdfText(id: string): Promise<string | null> {
  const meta = getFile(id);
  if (!meta || meta.kind !== "pdf") return null;
  const cache = path.join(FILES_DIR, id, "text.txt");
  if (fs.existsSync(cache)) return fs.readFileSync(cache, "utf8");
  const buf = readFileBytes(id);
  if (!buf) return null;
  try {
    const { extractPdfText } = await import("./pdf");
    const { text, pages, emptyPages } = await extractPdfText(buf);
    fs.writeFileSync(cache, text);
    if (!meta.pages || meta.pages !== pages) fs.writeFileSync(path.join(FILES_DIR, id, "meta.json"), JSON.stringify({ ...meta, pages }, null, 2));
    if (emptyPages === pages) fs.writeFileSync(cache, `${text}

(This PDF has no extractable text; it is probably scanned.)`);
    return fs.readFileSync(cache, "utf8");
  } catch (err) {
    console.warn(`[sapien] PDF text extraction failed for ${id}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function cachedPdfText(id: string): string | null {
  try {
    return fs.readFileSync(path.join(FILES_DIR, id, "text.txt"), "utf8");
  } catch {
    return null;
  }
}

export function deleteFiles(ids: string[]) {
  for (const id of ids) if (SAFE_ID.test(id)) fs.rmSync(path.join(FILES_DIR, id), { recursive: true, force: true });
}

/** Message content blocks (Anthropic format) for a set of files, newest kept first
 *  when the request budget runs out. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string };

/** pdf: "native" sends PDFs as documents; "text" sends their extracted text (call
 *  ensurePdfText first) for CLIs that cannot read PDFs. */
export function fileBlocks(ids: string[], opts: { pdf?: "native" | "text" } = {}): { blocks: ContentBlock[]; omitted: string[] } {
  const metas = ids.map(getFile).filter((m): m is Attachment => !!m);
  const blocks: ContentBlock[] = [];
  const omitted: string[] = [];
  let used = 0;
  // Newest last in the list → iterate newest first, then restore order.
  const chosen: { meta: Attachment; buf: Buffer }[] = [];
  for (const meta of [...metas].reverse()) {
    const buf = readFileBytes(meta.id);
    if (!buf) continue;
    if (used + buf.length > REQUEST_BUDGET) {
      omitted.push(meta.name);
      continue;
    }
    used += buf.length;
    chosen.unshift({ meta, buf });
  }
  chosen.forEach(({ meta, buf }) => {
    const n = metas.indexOf(meta) + 1;
    blocks.push({ type: "text", text: `=== LEARNER FILE ${n}: ${meta.name} (${meta.kind}${meta.pages ? `, ~${meta.pages} pages` : ""}) ===` });
    if (meta.kind === "image") blocks.push({ type: "image", source: { type: "base64", media_type: meta.mime, data: buf.toString("base64") } });
    else if (meta.kind === "pdf" && opts.pdf === "text")
      blocks.push({ type: "text", text: cachedPdfText(meta.id) ?? "(The text of this PDF could not be extracted. Ask the learner to paste the relevant part.)" });
    else if (meta.kind === "pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") }, title: meta.name });
    else blocks.push({ type: "text", text: buf.toString("utf8").slice(0, 400_000) });
  });
  return { blocks, omitted };
}

/** Learner files as content blocks for the selected CLI: PDFs natively, or as extracted
 *  text for CLIs that cannot read them. */
export async function filesFor(ids: string[], settings: Settings) {
  const mode = PROVIDERS[settings.provider].pdf;
  if (mode === "text") for (const id of ids) if (getFile(id)?.kind === "pdf") await ensurePdfText(id);
  return fileBlocks(ids, { pdf: mode });
}
