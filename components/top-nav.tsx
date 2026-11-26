"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { IconGear, IconSearch } from "./icons";

interface Activity {
  items: { id: string; kind: "job" | "extraction"; title: string; sessionId: string; label: string; startedAt: string; stoppable: boolean }[];
  turnsRunning: number;
  totalCostUsd: number;
}

/** Pages call this after changing sessions so nav-level data refreshes immediately. */
export function notifySidebar() {
  window.dispatchEvent(new Event("sapien:refresh"));
}

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return iso.slice(0, 10);
}

const LINKS = [
  { href: "/?mode=teach#start", label: "Learn" },
  { href: "/?mode=practice#start", label: "Practice" },
  { href: "/#sessions", label: "Sessions" },
  { href: "/graph", label: "Knowledge graph" },
];

export function TopNav() {
  const pathname = usePathname();
  const [activity, setActivity] = useState<Activity>({ items: [], turnsRunning: 0, totalCostUsd: 0 });
  const [open, setOpen] = useState(false);
  const [, setNow] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<Activity>("/api/activity").then(setActivity).catch(() => {});
  }, []);
  const busy = activity.items.length > 0 || activity.turnsRunning > 0;
  useEffect(() => {
    load();
    window.addEventListener("sapien:refresh", load);
    return () => window.removeEventListener("sapien:refresh", load);
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => (load(), setNow((n) => n + 1)), busy ? 2000 : 8000);
    return () => clearInterval(t);
  }, [load, busy]);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const count = activity.items.length + activity.turnsRunning;
  return (
    <header className="sticky top-0 z-40 border-b backdrop-blur-[10px]" style={{ borderColor: "var(--rule-soft)", background: "rgba(10,13,26,0.94)" }}>
      <div className="mx-auto flex h-16 max-w-[1360px] items-center gap-[10px] px-7">
        <Link href="/" className="mr-auto flex items-baseline gap-2 whitespace-nowrap" style={{ fontFamily: "var(--font-display)", fontSize: "1.6rem", letterSpacing: "0.04em", color: "var(--blue)" }}>
          <span className="inline-block h-3 w-3 self-center" style={{ background: "var(--blue)" }} />
          SAPIEN / FIRST PRINCIPLES
        </Link>
        <nav className="mr-2 hidden items-center gap-5 lg:flex">
          {LINKS.map((l) => (
            <Link key={l.label} href={l.href} className="navlink" data-on={l.href === "/graph" && pathname === "/graph"}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="relative" ref={ref}>
          <button className="pill-btn" data-on={open} onClick={() => setOpen((o) => !o)} title="Background agents">
            {busy ? <span className="ring-spin" /> : <span className="inline-block h-2 w-2" style={{ background: "var(--blue)" }} />}
            <span>{count ? `${count} agent${count > 1 ? "s" : ""}` : "Idle"}</span>
            <span style={{ color: "var(--rule-soft)" }}>|</span>
            <span className="tabular-nums" style={{ fontWeight: 600 }}>${activity.totalCostUsd.toFixed(2)}</span>
          </button>
          {open && (
            <div className="card-lift absolute right-0 top-12 w-80">
              <div className="label border-b px-4 py-3 !text-[0.7rem]" style={{ borderColor: "var(--rule-soft)" }}>Background agents</div>
              {activity.turnsRunning > 0 && (
                <div className="ui border-b px-4 py-2.5 text-xs" style={{ borderColor: "var(--rule-soft)" }}>
                  {activity.turnsRunning} lesson turn{activity.turnsRunning > 1 ? "s" : ""} in progress
                </div>
              )}
              {activity.items.length === 0 && activity.turnsRunning === 0 && <div className="ui faint px-4 py-3 text-xs">Nothing running.</div>}
              {activity.items.map((a) => (
                <div key={a.id} className="ui flex items-center gap-3 border-b px-4 py-2.5 text-xs" style={{ borderColor: "var(--rule-soft)" }}>
                  <Link href={a.sessionId.startsWith("notes:") ? "/graph" : `/session/${a.sessionId}`} className="min-w-0 flex-1" onClick={() => setOpen(false)}>
                    <div className="truncate">{a.title}</div>
                    <div className="faint truncate">{a.label}</div>
                  </Link>
                  <span className="faint tabular-nums">{Math.round((Date.now() - new Date(a.startedAt).getTime()) / 1000)}s</span>
                  {a.stoppable && (
                    <button className="h-3.5 w-3.5 border hover:bg-[var(--hover)]" style={{ borderColor: "var(--ink-soft)" }} title="Stop" onClick={() => api(`/api/jobs/${a.id}/abort`, { method: "POST" }).then(load)} />
                  )}
                </div>
              ))}
              <div className="ui faint px-4 py-2.5 text-[0.68rem]">CLI-reported cost, all sessions. Subscription billing may differ.</div>
            </div>
          )}
        </div>
        <Link href="/graph" className="icon-btn" title="Search your knowledge graph">
          <IconSearch size={20} />
        </Link>
        <Link href="/settings" className="icon-btn" title="Settings">
          <IconGear size={19} />
        </Link>
      </div>
    </header>
  );
}
