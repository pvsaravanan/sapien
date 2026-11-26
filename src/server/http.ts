import { NextResponse } from "next/server";
import { InputError } from "./orchestrator";

/** Refuse cross-site requests: a page on another origin must not be able to drive
 *  the local agents (and spend the user's quota). Same-origin fetches pass. */
export function crossSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.get("host");
  } catch {
    return true;
  }
}

export async function handle(req: Request, fn: () => Promise<unknown> | unknown) {
  if (req.method !== "GET" && crossSite(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  try {
    const out = await fn();
    return NextResponse.json(out ?? { ok: true });
  } catch (err) {
    const status = err instanceof InputError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 500) console.error(err);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new InputError("Invalid JSON body.");
  }
}
