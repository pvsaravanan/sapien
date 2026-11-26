import { body, handle } from "@/src/server/http";
import { submitInput, type LearnerInput } from "@/src/server/orchestrator";
import { sessionView } from "@/src/server/views";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, async () => {
    const input = await body<LearnerInput>(req);
    submitInput(id, input);
    return sessionView(id);
  });
}
