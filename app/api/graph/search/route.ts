import { handle } from "@/src/server/http";
import { getGraph, getSettings } from "@/src/server/store";
import { semanticRank, semanticStatus } from "@/src/server/embeddings";
import { similarity } from "@/src/core/graph";

/** Ranked graph search: by meaning when the local model is available, else by shared words. */
export async function GET(req: Request) {
  return handle(req, async () => {
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 300);
    const k = Math.min(50, Math.max(1, Number(new URL(req.url).searchParams.get("k")) || 20));
    const graph = getGraph();
    if (!q) return { mode: "none", results: [], status: semanticStatus() };
    const lexical = () =>
      graph.propositions
        .map((p) => ({ id: p.id, score: similarity(q, `${p.name} ${p.statement} ${p.aliases.join(" ")}`) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    if (!getSettings().graphSemantic) return { mode: "words", results: lexical(), status: semanticStatus() };
    try {
      const ranked = await semanticRank(graph, q, k);
      return {
        mode: "meaning",
        results: ranked.filter((r) => r.score > 0.2).map((r) => ({ id: r.prop.id, score: r.score, semantic: r.semantic, lexical: r.lexical })),
        status: semanticStatus(),
      };
    } catch {
      return { mode: "words", results: lexical(), status: semanticStatus() };
    }
  });
}
