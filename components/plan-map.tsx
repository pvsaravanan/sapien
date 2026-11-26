"use client";

import { useState } from "react";
import { layoutPlan } from "@/src/core/plan";
import { Markdown } from "./markdown";
import type { Plan } from "@/src/core/types";

const W = 120;
const H = 42;

/** Boxed dependency tree with right-angle connectors; the current step is highlighted. */
export function PlanMap({ plan, current, visited }: { plan: Plan; current: string | null; visited: Set<string> }) {
  const [hover, setHover] = useState<string | null>(null);
  const { nodes, width, height } = layoutPlan(plan, W + 16, H + 34);
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const shown = nodes.find((n) => n.id === (hover ?? current));
  const pad = 8;
  return (
    <div>
      <svg viewBox={`${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`} width="100%" role="img" aria-label="Lesson map">
        {plan.edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const y1 = a.y + H / 2;
          const y2 = b.y - H / 2;
          const my = y2 - 12;
          const on = visited.has(e.from) && (visited.has(e.to) || current === e.to);
          return (
            <path
              key={`${e.from}-${e.to}`}
              d={`M${a.x},${y1} V${my} H${b.x} V${y2}`}
              fill="none"
              stroke={on ? "#6b8eff" : "#4a5580"}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          );
        })}
        {nodes.map((n) => {
          const isCur = n.id === current;
          const isVis = visited.has(n.id);
          return (
            <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
              {isCur && <rect x={n.x - W / 2 + 4} y={n.y - H / 2 + 4} width={W} height={H} fill="#2a3a80" />}
              <rect
                x={n.x - W / 2}
                y={n.y - H / 2}
                width={W}
                height={H}
                fill={isCur ? "#1b2450" : "#0b0d1a"}
                stroke={isCur ? "#6b8eff" : isVis ? "#9aa1bb" : "#4a5580"}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <foreignObject x={n.x - W / 2 + 4} y={n.y - H / 2 + 2} width={W - 8} height={H - 4}>
                <div
                  style={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                    fontSize: 9.5,
                    lineHeight: 1.2,
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontFamily: "var(--font-ui), monospace",
                    color: isCur ? "#c9d4ff" : isVis ? "#c4c9dc" : "#7d86a8",
                    overflow: "hidden",
                  }}
                >
                  {isVis && !isCur ? "✓ " : ""}
                  {n.title}
                </div>
              </foreignObject>
            </g>
          );
        })}
      </svg>
      {shown?.summary && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--line)" }}>
          <div className="label !text-[0.62rem]">{hover ? "Step" : "Now"}</div>
          <div className="heading mt-1 !text-[0.78rem]">{shown.title}</div>
          <Markdown className="md-tight mt-1 !text-[0.88rem] !leading-snug" >{shown.summary}</Markdown>
        </div>
      )}
    </div>
  );
}
