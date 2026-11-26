import { handle } from "@/src/server/http";
import { getGraph } from "@/src/server/store";
import { ensureIndex, getEmbedder, semanticStatus } from "@/src/server/embeddings";

export async function GET(req: Request) {
  return handle(req, () => semanticStatus());
}

/** Download the model (first time) and index every proposition now. */
export async function POST(req: Request) {
  return handle(req, async () => {
    const t = Date.now();
    try {
      await getEmbedder();
      const vectors = await ensureIndex(getGraph());
      return { ...semanticStatus(), indexed: vectors.size, ms: Date.now() - t };
    } catch (err) {
      return { ...semanticStatus(), error: err instanceof Error ? err.message : String(err) };
    }
  });
}
