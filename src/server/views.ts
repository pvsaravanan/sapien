import type { Session } from "../core/types";
import { isExtracting } from "./extraction";
import { boot, getLive, getTurnKind, InputError, isRunning } from "./orchestrator";
import { getFile } from "./files";
import { getSession, getSettings, listJobs } from "./store";

/** Hide answer keys of unanswered questions and solutions of active problems:
 *  the browser only learns them once they are meant to be revealed. */
export function redact(s: Session): Session {
  return {
    ...s,
    events: s.events.map((e) => {
      if (e.type === "question" && e.interaction.kind === "recall" && e.interaction.gradingNotes) {
        const { gradingNotes: _hidden, ...interaction } = e.interaction;
        e = { ...e, interaction };
      }
      if (e.type === "question" && !e.answer) {
        const i = e.interaction;
        if (i.kind === "choice") return { ...e, interaction: { ...i, correct: [], explanation: undefined, optionNotes: undefined } };
        if (i.kind === "recall") return { ...e, interaction: { ...i, committedAnswer: "" } };
      }
      if (e.type === "problem" && e.status === "active") return { ...e, problem: { ...e.problem, solution: "" } };
      return e;
    }),
  };
}

/** What the browser receives for one session. */
export function sessionView(id: string) {
  boot();
  const session = getSession(id);
  if (!session) throw new InputError("Session not found", 404);
  const files = (session.attachments ?? []).map(getFile).filter((f) => !!f);
  return {
    session: redact(session),
    jobs: listJobs(id),
    running: isRunning(id),
    extracting: isExtracting(id),
    live: getLive(id),
    turn: getTurnKind(id),
    files,
    provider: getSettings().provider,
  };
}
