import { handle } from "@/src/server/http";
import { abortTurn, isRunning, mutate, InputError } from "@/src/server/orchestrator";
import { body } from "@/src/server/http";
import { MODELS, EFFORTS } from "@/src/server/defaults";
import type { Effort, ModelAlias } from "@/src/core/types";
import { deleteSession, getGraph, getSession, saveGraph } from "@/src/server/store";
import { deleteFiles } from "@/src/server/files";
import { removeSource } from "@/src/core/graph";
import { sessionView } from "@/src/server/views";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(req, () => sessionView(id));
}

export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(req, () => {
    sessionView(id); // 404 if missing
    if (isRunning(id)) abortTurn(id);
    if (new URL(req.url).searchParams.get("graph") === "remove") saveGraph(removeSource(getGraph(), id));
    deleteFiles(getSession(id)?.attachments ?? []);
    deleteSession(id);
  });
}

/** Change this session's model/effort for its interactive agents. Takes effect next turn. */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(req, async () => {
    const b = await body<{ model?: string | null; effort?: string | null; title?: string }>(req);
    if (b.model && !MODELS.includes(b.model as ModelAlias)) throw new InputError("Invalid model.");
    if (b.effort && !EFFORTS.includes(b.effort as Effort)) throw new InputError("Invalid effort.");
    mutate(id, (s) => {
      if (b.model !== undefined) s.model = (b.model || undefined) as ModelAlias | undefined;
      if (b.effort !== undefined) s.effort = (b.effort || undefined) as Effort | undefined;
      if (b.title?.trim()) (s.title = b.title.trim().slice(0, 80)), (s.titleSet = true);
    });
    return sessionView(id);
  });
}
