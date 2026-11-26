import { body, handle } from "@/src/server/http";
import { importNotes } from "@/src/server/extraction";

export async function POST(req: Request) {
  return handle(req, async () => {
    const b = await body<{ name?: string; text?: string; fileId?: string }>(req);
    return importNotes(String(b.name ?? ""), String(b.text ?? ""), b.fileId ? String(b.fileId) : undefined);
  });
}
