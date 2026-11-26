import { body, handle } from "@/src/server/http";
import { cleanDictation } from "@/src/server/orchestrator";

/** Clean up dictated text (punctuation, fillers, misheard terms) with the scribe. */
export async function POST(req: Request) {
  return handle(req, async () => {
    const b = await body<{ text?: string; sessionId?: string; topic?: string }>(req);
    return cleanDictation(String(b.text ?? ""), b.sessionId || undefined, b.topic);
  });
}
