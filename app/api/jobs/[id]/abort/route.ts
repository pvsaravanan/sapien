import { handle } from "@/src/server/http";
import { abortJob } from "@/src/server/orchestrator";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, () => abortJob(id));
}
