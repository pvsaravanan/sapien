import { body, handle } from "@/src/server/http";
import { boot, createSession, isRunning } from "@/src/server/orchestrator";
import { listSessions } from "@/src/server/store";
import { statusLine } from "@/src/core/transcript";
import { MODELS, EFFORTS } from "@/src/server/defaults";
import type { Effort, ModelAlias, SessionKind } from "@/src/core/types";

export async function GET(req: Request) {
  return handle(req, () => {
    boot();
    return {
      sessions: listSessions().map((s) => {
        const { events, side, ...rest } = s;
        return { ...rest, eventCount: events.length, statusLine: statusLine(s, isRunning(s.id)) };
      }),
    };
  });
}

export async function POST(req: Request) {
  return handle(req, async () => {
    const b = await body<{ kind?: SessionKind; topic?: string; seedNodeIds?: string[]; model?: string; effort?: string; attachmentIds?: string[] }>(req);
    const kind = b.kind === "practice" ? "practice" : "teach";
    const s = createSession({
      kind,
      topic: String(b.topic ?? "").slice(0, 4000),
      seedNodeIds: Array.isArray(b.seedNodeIds) ? b.seedNodeIds.map(String) : [],
      model: MODELS.includes(b.model as ModelAlias) ? (b.model as ModelAlias) : undefined,
      effort: EFFORTS.includes(b.effort as Effort) ? (b.effort as Effort) : undefined,
      attachmentIds: Array.isArray(b.attachmentIds) ? b.attachmentIds.map(String) : [],
    });
    return { id: s.id };
  });
}
