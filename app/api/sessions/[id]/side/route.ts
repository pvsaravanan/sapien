import { body, handle } from "@/src/server/http";
import { askSide } from "@/src/server/orchestrator";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, async () => {
    const b = await body<{ question?: string }>(req);
    const s = await askSide(id, String(b.question ?? "").slice(0, 4000));
    return { side: s.side };
  });
}
