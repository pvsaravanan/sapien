import { handle } from "@/src/server/http";
import { boot, isRunning } from "@/src/server/orchestrator";
import { extractionsInFlight } from "@/src/server/extraction";
import { listJobs, listSessions } from "@/src/server/store";

const KIND = { research: "Research", visual: "Visual", demo: "Demo" } as const;

/** Background work across all sessions, for the sidebar's agents panel. */
export async function GET(req: Request) {
  return handle(req, () => {
    boot();
    const sessions = listSessions();
    const title = (id: string) => sessions.find((s) => s.id === id)?.title ?? (id.startsWith("notes:") ? "Notes import" : id);
    const items = [
      ...listJobs()
        .filter((j) => j.status === "running")
        .map((j) => ({ id: j.id, kind: "job" as const, title: title(j.sessionId), sessionId: j.sessionId, label: `${KIND[j.kind]}: ${j.title}`, startedAt: j.createdAt, stoppable: true })),
      ...extractionsInFlight().map((e) => ({ id: `x:${e.source}`, kind: "extraction" as const, title: title(e.source), sessionId: e.source, label: "Extraction", startedAt: e.startedAt, stoppable: false })),
    ];
    return {
      items,
      turnsRunning: sessions.filter((s) => isRunning(s.id)).length,
      totalCostUsd: sessions.reduce((n, s) => n + s.usage.costUsd, 0),
    };
  });
}
