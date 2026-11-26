import { handle } from "@/src/server/http";
import { getGraph, listNotesSources, listSessions, saveGraph, saveNotesSources } from "@/src/server/store";
import { removeProposition, removeSource } from "@/src/core/graph";

export async function GET(req: Request) {
  return handle(req, () => ({
    graph: getGraph(),
    sources: [
      ...listSessions().map((s) => ({ id: s.id, name: s.title, kind: s.kind })),
      ...listNotesSources().map((n) => ({ id: `notes:${n.id}`, name: n.name, kind: "notes" as const })),
    ],
  }));
}

/** ?node=<id> deletes one proposition; ?source=<id> removes a source's contributions. */
export async function DELETE(req: Request) {
  return handle(req, () => {
    const q = new URL(req.url).searchParams;
    const node = q.get("node");
    const source = q.get("source");
    if (node) saveGraph(removeProposition(getGraph(), node));
    if (source) {
      saveGraph(removeSource(getGraph(), source));
      if (source.startsWith("notes:")) saveNotesSources(listNotesSources().filter((n) => `notes:${n.id}` !== source));
    }
  });
}
