"use client";

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from "d3-force";
import { useEffect, useRef, useState } from "react";
import type { Graph } from "@/src/core/types";

/** Obsidian-style knowledge graph: a live force layout on a canvas. Nodes are circles
 *  sized by how many reasoning links touch them; hovering lights up a node and its
 *  neighbours; labels fade in as you zoom; nodes can be dragged. */

interface N extends SimulationNodeDatum {
  id: string;
  label: string;
  degree: number;
  group: number;
}
interface L {
  source: N;
  target: N;
}

export interface GraphSettings {
  showOrphans: boolean;
  arrows: boolean;
  colorGroups: boolean;
  textFade: number; // zoom level at which labels are fully visible
  nodeSize: number;
  lineWidth: number;
  center: number;
  repel: number;
  linkForce: number;
  linkDistance: number;
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  showOrphans: true,
  arrows: false,
  colorGroups: true,
  textFade: 1.2,
  nodeSize: 1,
  lineWidth: 1,
  center: 0.06,
  repel: 240,
  linkForce: 0.6,
  linkDistance: 85,
};

const GROUP_COLORS = ["#6b8eff", "#5fc4b8", "#c58cff", "#e8b45c", "#ff8fa3", "#8fd16f", "#5aa9ff", "#d9a3ff"];
const NODE = "#a8acc2";
const ACCENT = "#6b8eff";
const STORAGE_KEY = "sapien:graph-settings";

function loadSettings(): GraphSettings {
  try {
    return { ...DEFAULT_GRAPH_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULT_GRAPH_SETTINGS;
  }
}

const radius = (n: N, size: number) => (3.2 + Math.sqrt(n.degree) * 2.2) * size;

export function GraphCanvas({
  graph,
  highlight,
  selected,
  focused,
  onNodeClick,
  compact = false,
}: {
  graph: Graph;
  /** Ids matching the search box (others dim). Null = no search. */
  highlight: Set<string> | null;
  /** Practice seeds (ringed). */
  selected: Set<string>;
  /** Node whose detail is open (stays lit like a hover). */
  focused: string | null;
  onNodeClick: (id: string) => void;
  /** Smaller chrome for previews. */
  compact?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [settings, setSettings] = useState<GraphSettings>(DEFAULT_GRAPH_SETTINGS);
  const [panelOpen, setPanelOpen] = useState(false);

  // Mutable scene state kept out of React so rendering stays cheap at 60fps.
  const scene = useRef({
    nodes: [] as N[],
    links: [] as L[],
    neighbors: new Map<string, Set<string>>(),
    sim: null as Simulation<N, undefined> | null,
    t: { x: 0, y: 0, k: 1 },
    w: 0,
    h: 0,
    hover: null as string | null,
    drag: null as null | { node: N | null; startX: number; startY: number; moved: boolean; tx: number; ty: number },
    dirty: true,
    fitted: false,
  });
  const props = useRef({ highlight, selected, focused, settings, onNodeClick });
  props.current = { highlight, selected, focused, settings, onNodeClick };

  useEffect(() => setSettings(loadSettings()), []);
  const update = (patch: Partial<GraphSettings>) =>
    setSettings((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });

  // Build nodes/links and the simulation whenever the graph or orphan filter changes.
  useEffect(() => {
    const sc = scene.current;
    const groups = new Map<string, number>();
    const degree = new Map<string, number>();
    const pairs: [string, string][] = [];
    for (const c of graph.chains)
      for (const p of c.premises) {
        pairs.push([p, c.conclusion]);
        degree.set(p, (degree.get(p) ?? 0) + 1);
        degree.set(c.conclusion, (degree.get(c.conclusion) ?? 0) + 1);
      }
    const old = new Map(sc.nodes.map((n) => [n.id, n]));
    const nodes: N[] = graph.propositions
      .filter((p) => settings.showOrphans || (degree.get(p.id) ?? 0) > 0)
      .map((p) => {
        const src = p.provenance[0]?.source ?? "?";
        if (!groups.has(src)) groups.set(src, groups.size);
        const prev = old.get(p.id);
        return { id: p.id, label: p.name, degree: degree.get(p.id) ?? 0, group: groups.get(src)!, x: prev?.x, y: prev?.y, vx: prev?.vx, vy: prev?.vy };
      });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const seen = new Set<string>();
    const links: L[] = [];
    const neighbors = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
    for (const [a, b] of pairs) {
      const s = byId.get(a);
      const t = byId.get(b);
      if (!s || !t || seen.has(`${a}>${b}`)) continue;
      seen.add(`${a}>${b}`);
      links.push({ source: s, target: t });
      neighbors.get(a)!.add(b);
      neighbors.get(b)!.add(a);
    }
    sc.sim?.stop();
    sc.nodes = nodes;
    sc.links = links;
    sc.neighbors = neighbors;
    const sim = forceSimulation<N>(nodes)
      .force("link", forceLink<N, L>(links).id((d) => d.id))
      .force("charge", forceManyBody<N>())
      .force("x", forceX<N>(0))
      .force("y", forceY<N>(0))
      .force("collide", forceCollide<N>())
      .alphaDecay(0.02)
      .on("tick", () => (sc.dirty = true));
    sc.sim = sim;
    applyForces(sim, props.current.settings);
    // Settle most of the layout before first paint, then let it breathe.
    if (!old.size) {
      sim.stop();
      for (let i = 0; i < 160; i++) sim.tick();
      sim.alpha(0.25).restart();
      sc.fitted = false;
    } else sim.alpha(0.4).restart();
    sc.dirty = true;
    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, settings.showOrphans]);

  // Live force tuning.
  useEffect(() => {
    const sim = scene.current.sim;
    if (!sim) return;
    applyForces(sim, settings);
    sim.alpha(0.5).restart();
    scene.current.dirty = true;
  }, [settings.center, settings.repel, settings.linkForce, settings.linkDistance, settings.nodeSize]);

  useEffect(() => {
    scene.current.dirty = true;
  }, [highlight, selected, focused, settings]);

  // Canvas sizing (HiDPI) and the render loop.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const sc = scene.current;
    const fit = () => {
      if (!sc.nodes.length || !sc.w) return;
      const xs = sc.nodes.map((n) => n.x ?? 0);
      const ys = sc.nodes.map((n) => n.y ?? 0);
      const pad = 60;
      const bw = Math.max(...xs) - Math.min(...xs) + pad * 2;
      const bh = Math.max(...ys) - Math.min(...ys) + pad * 2;
      const k = Math.min(sc.w / bw, sc.h / bh, 2.2);
      const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
      const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
      sc.t = { k, x: sc.w / 2 - cx * k, y: sc.h / 2 - cy * k };
      sc.fitted = true;
    };
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sc.w = r.width;
      sc.h = r.height;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      if (!sc.fitted) fit();
      sc.dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!sc.fitted && sc.nodes.length) fit();
      if (!sc.dirty) return;
      sc.dirty = false;
      draw(canvas, sc, props.current);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // ── interaction ──────────────────────────────────────────────────────────
  const toWorld = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const t = scene.current.t;
    return { x: (clientX - r.left - t.x) / t.k, y: (clientY - r.top - t.y) / t.k, sx: clientX - r.left, sy: clientY - r.top };
  };
  const hit = (wx: number, wy: number): N | null => {
    const sc = scene.current;
    let best: N | null = null;
    let bestD = Infinity;
    for (const n of sc.nodes) {
      const d = Math.hypot((n.x ?? 0) - wx, (n.y ?? 0) - wy);
      const r = radius(n, props.current.settings.nodeSize) + 4 / sc.t.k;
      if (d < r && d < bestD) (best = n), (bestD = d);
    }
    return best;
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden select-none">
      <canvas
        ref={canvasRef}
        className="block touch-none"
        style={{ cursor: "grab" }}
        onWheel={(e) => {
          const sc = scene.current;
          const { sx, sy } = toWorld(e.clientX, e.clientY);
          const f = Math.exp(-e.deltaY * 0.0015);
          const k = Math.min(8, Math.max(0.08, sc.t.k * f));
          const ratio = k / sc.t.k;
          sc.t = { k, x: sx - (sx - sc.t.x) * ratio, y: sy - (sy - sc.t.y) * ratio };
          sc.dirty = true;
        }}
        onPointerDown={(e) => {
          const sc = scene.current;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const w = toWorld(e.clientX, e.clientY);
          const node = hit(w.x, w.y);
          sc.drag = { node, startX: e.clientX, startY: e.clientY, moved: false, tx: sc.t.x, ty: sc.t.y };
          if (node) {
            node.fx = node.x;
            node.fy = node.y;
            sc.sim?.alphaTarget(0.25).restart();
          }
          if (canvasRef.current) canvasRef.current.style.cursor = node ? "grabbing" : "move";
        }}
        onPointerMove={(e) => {
          const sc = scene.current;
          const w = toWorld(e.clientX, e.clientY);
          const d = sc.drag;
          if (d) {
            if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 3) d.moved = true;
            if (d.node) {
              d.node.fx = w.x;
              d.node.fy = w.y;
            } else {
              sc.t = { ...sc.t, x: d.tx + (e.clientX - d.startX), y: d.ty + (e.clientY - d.startY) };
            }
            sc.dirty = true;
            return;
          }
          const h = hit(w.x, w.y)?.id ?? null;
          if (h !== sc.hover) {
            sc.hover = h;
            sc.dirty = true;
            if (canvasRef.current) canvasRef.current.style.cursor = h ? "pointer" : "grab";
          }
        }}
        onPointerUp={() => {
          const sc = scene.current;
          const d = sc.drag;
          sc.drag = null;
          if (canvasRef.current) canvasRef.current.style.cursor = sc.hover ? "pointer" : "grab";
          if (d?.node) {
            d.node.fx = null;
            d.node.fy = null;
            sc.sim?.alphaTarget(0);
            if (!d.moved) props.current.onNodeClick(d.node.id);
          }
        }}
        onPointerLeave={() => {
          const sc = scene.current;
          if (!sc.drag && sc.hover) {
            sc.hover = null;
            sc.dirty = true;
          }
        }}
        onDoubleClick={() => {
          scene.current.fitted = false;
        }}
      />

      {/* settings panel */}
      <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
        <button className="icon-btn !h-8 !w-8" style={{ background: "rgba(10,13,26,0.85)" }} title="Graph settings" onClick={() => setPanelOpen((o) => !o)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
            <circle cx="16" cy="6" r="2" />
            <circle cx="10" cy="12" r="2" />
            <circle cx="18" cy="18" r="2" />
          </svg>
        </button>
        {panelOpen && <SettingsPanel s={settings} update={update} compact={compact} reset={() => update(DEFAULT_GRAPH_SETTINGS)} />}
      </div>
      {!compact && (
        <div className="ui pointer-events-none absolute bottom-3 right-3 text-[0.64rem] uppercase tracking-[0.1em]" style={{ color: "var(--ink-mute)" }}>
          scroll to zoom · drag to pan · drag a node to move it · double-click to fit
        </div>
      )}
    </div>
  );
}

function applyForces(sim: Simulation<N, undefined>, s: GraphSettings) {
  (sim.force("link") as ReturnType<typeof forceLink<N, L>>).distance(s.linkDistance).strength(s.linkForce);
  (sim.force("charge") as ReturnType<typeof forceManyBody<N>>).strength(-s.repel).distanceMax(600);
  (sim.force("x") as ReturnType<typeof forceX<N>>).strength(s.center);
  (sim.force("y") as ReturnType<typeof forceY<N>>).strength(s.center);
  (sim.force("collide") as ReturnType<typeof forceCollide<N>>).radius((d) => radius(d, s.nodeSize) + 3);
}

type Scene = {
  nodes: N[];
  links: L[];
  neighbors: Map<string, Set<string>>;
  t: { x: number; y: number; k: number };
  w: number;
  h: number;
  hover: string | null;
};

function draw(
  canvas: HTMLCanvasElement,
  sc: Scene,
  p: { highlight: Set<string> | null; selected: Set<string>; focused: string | null; settings: GraphSettings },
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const { t } = sc;
  const s = p.settings;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, sc.w, sc.h);
  ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);

  const active = sc.hover ?? p.focused;
  const lit = active ? new Set([active, ...(sc.neighbors.get(active) ?? [])]) : null;
  const matches = p.highlight;
  const nodeColor = (n: N) => (s.colorGroups ? GROUP_COLORS[n.group % GROUP_COLORS.length] : NODE);
  const dim = (n: N) => (lit ? !lit.has(n.id) : matches ? !matches.has(n.id) : false);

  // links
  const lw = s.lineWidth / t.k;
  for (const l of sc.links) {
    const on = !!active && (l.source.id === active || l.target.id === active);
    const faded = lit ? !on : matches ? !(matches.has(l.source.id) || matches.has(l.target.id)) : false;
    ctx.strokeStyle = on ? ACCENT : "#7d84a3";
    ctx.globalAlpha = on ? 0.95 : faded ? 0.06 : 0.38;
    ctx.lineWidth = on ? lw * 1.6 : lw;
    const sx = l.source.x ?? 0;
    const sy = l.source.y ?? 0;
    const tx = l.target.x ?? 0;
    const ty = l.target.y ?? 0;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    if (s.arrows) {
      const ang = Math.atan2(ty - sy, tx - sx);
      const r = radius(l.target, s.nodeSize) + 1.5;
      const ax = tx - Math.cos(ang) * r;
      const ay = ty - Math.sin(ang) * r;
      const size = 5 / Math.sqrt(t.k) + 2;
      ctx.fillStyle = on ? ACCENT : "#7d84a3";
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - Math.cos(ang - 0.45) * size, ay - Math.sin(ang - 0.45) * size);
      ctx.lineTo(ax - Math.cos(ang + 0.45) * size, ay - Math.sin(ang + 0.45) * size);
      ctx.closePath();
      ctx.fill();
    }
  }

  // nodes
  for (const n of sc.nodes) {
    const r = radius(n, s.nodeSize);
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const isActive = n.id === active;
    ctx.globalAlpha = dim(n) ? 0.18 : 1;
    ctx.fillStyle = isActive ? "#ffffff" : lit && lit.has(n.id) ? ACCENT : nodeColor(n);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (p.selected.has(n.id)) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.6 / t.k;
      ctx.beginPath();
      ctx.arc(x, y, r + 3.5 / t.k + 1, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // labels: fade in with zoom; always shown for the lit neighbourhood, search hits and seeds
  const fade = Math.max(0, Math.min(1, (t.k - (s.textFade - 0.45)) / 0.45));
  const fontPx = 11.5 / t.k;
  ctx.font = `500 ${fontPx}px "Plus Jakarta Sans", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const n of sc.nodes) {
    const forced = (lit && lit.has(n.id)) || (matches && matches.has(n.id)) || p.selected.has(n.id);
    const a = forced ? 1 : dim(n) ? 0 : fade;
    if (a <= 0.02) continue;
    ctx.globalAlpha = a;
    const label = n.label.length > 42 ? `${n.label.slice(0, 40)}…` : n.label;
    const y = (n.y ?? 0) + radius(n, s.nodeSize) + 4 / t.k;
    ctx.lineWidth = 3 / t.k;
    ctx.strokeStyle = "#0a0d1a";
    ctx.strokeText(label, n.x ?? 0, y);
    ctx.fillStyle = n.id === active ? "#ffffff" : "#d6d8e4";
    ctx.fillText(label, n.x ?? 0, y);
  }
  ctx.globalAlpha = 1;
}

function SettingsPanel({ s, update, reset, compact }: { s: GraphSettings; update: (p: Partial<GraphSettings>) => void; reset: () => void; compact: boolean }) {
  return (
    <div className="card-lift scroll-thin w-64 overflow-y-auto p-4 text-[0.8rem]" style={{ maxHeight: compact ? 380 : 520 }}>
      <Section title="Filters">
        <Toggle label="Show orphans" value={s.showOrphans} onChange={(v) => update({ showOrphans: v })} />
      </Section>
      <Section title="Display">
        <Toggle label="Arrows" value={s.arrows} onChange={(v) => update({ arrows: v })} />
        <Toggle label="Colour by source" value={s.colorGroups} onChange={(v) => update({ colorGroups: v })} />
        <Slider label="Text fade threshold" min={0.4} max={3} step={0.1} value={s.textFade} onChange={(v) => update({ textFade: v })} />
        <Slider label="Node size" min={0.5} max={2.5} step={0.1} value={s.nodeSize} onChange={(v) => update({ nodeSize: v })} />
        <Slider label="Link thickness" min={0.3} max={3} step={0.1} value={s.lineWidth} onChange={(v) => update({ lineWidth: v })} />
      </Section>
      <Section title="Forces">
        <Slider label="Center force" min={0} max={0.3} step={0.01} value={s.center} onChange={(v) => update({ center: v })} />
        <Slider label="Repel force" min={20} max={600} step={10} value={s.repel} onChange={(v) => update({ repel: v })} />
        <Slider label="Link force" min={0.05} max={1} step={0.05} value={s.linkForce} onChange={(v) => update({ linkForce: v })} />
        <Slider label="Link distance" min={20} max={250} step={5} value={s.linkDistance} onChange={(v) => update({ linkDistance: v })} />
      </Section>
      <button className="btn-sm mt-1 w-full justify-center" onClick={reset}>Reset to defaults</button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="label mb-2 !text-[0.64rem]">{title}</div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className="relative h-[18px] w-8 border transition-colors"
        style={{ borderColor: value ? "var(--blue)" : "var(--rule-soft)", background: value ? "var(--blue-tint-strong)" : "transparent" }}
      >
        <span className="absolute top-[2px] h-3 w-3 transition-all" style={{ left: value ? 16 : 2, background: value ? "var(--blue)" : "var(--ink-mute)" }} />
      </button>
    </div>
  );
}

function Slider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className="block">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums" style={{ color: "var(--ink-mute)" }}>{value}</span>
      </span>
      <input type="range" className="conf mt-1.5" min={min} max={max} step={step} value={value} style={{ ["--pct" as string]: `${pct}%` }} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
