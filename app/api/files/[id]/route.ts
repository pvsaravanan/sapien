import { getFile, readFileBytes } from "@/src/server/files";

/** Serve a learner file back for previews. Text is always served as plain text. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = getFile(id);
  const bytes = meta && readFileBytes(id);
  if (!meta || !bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": meta.kind === "text" ? "text/plain; charset=utf-8" : meta.mime,
      "content-disposition": `inline; filename="${meta.name.replace(/"/g, "")}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; plugin-types application/pdf",
      "cache-control": "private, max-age=3600",
    },
  });
}
