import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskView } from "./types";

const NODE_W = 200;
const NODE_H = 76;
const COL_STRIDE = 250;
const ROW_STRIDE = 94;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

interface DagLayout {
  pos: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/** Colonne = longueur du plus long chemin de dépendances. */
function computeLayout(views: TaskView[]): DagLayout {
  const byId = new Map(views.map((v) => [v.task.id, v]));
  const cache = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const v = byId.get(id);
    if (v === undefined || v.task.dependsOn.length === 0 || seen.has(id)) return 0;
    seen.add(id);
    const d = 1 + Math.max(...v.task.dependsOn.map((x) => depth(x, seen)));
    cache.set(id, d);
    return d;
  };
  const cols: TaskView[][] = [];
  for (const v of views) (cols[depth(v.task.id, new Set())] ??= []).push(v);

  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, c) => col.forEach((v, i) => pos.set(v.task.id, { x: c * COL_STRIDE, y: i * ROW_STRIDE })));
  return {
    pos,
    width: Math.max(0, (cols.length - 1) * COL_STRIDE + NODE_W),
    height: Math.max(0, (Math.max(0, ...cols.map((c) => c.length)) - 1) * ROW_STRIDE + NODE_H),
  };
}

interface DagProps {
  views: TaskView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function PipelineView({ views, selectedId, onSelect, layout }: DagProps & { layout: DagLayout }): React.JSX.Element {
  const { pos, width, height } = layout;
  return (
    <div className="dag" style={{ width, height }}>
      <svg className="dag-edges" width={width} height={height}>
        <defs>
          <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6 Z" className="arrow-head" />
          </marker>
        </defs>
        {views.flatMap((v) =>
          v.task.dependsOn.map((depId) => {
            const from = pos.get(depId);
            const to = pos.get(v.task.id);
            if (from === undefined || to === undefined) return null;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x - 2;
            const y2 = to.y + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={`${depId}-${v.task.id}`}
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 6},${y2}`}
                className={`edge ${v.status === "running" ? "edge-active" : ""}`}
                markerEnd="url(#arrow)"
              />
            );
          }),
        )}
      </svg>
      {views.map((v) => {
        const p = pos.get(v.task.id);
        if (p === undefined) return null;
        const m = v.metrics;
        return (
          <div
            key={v.task.id}
            role="button"
            tabIndex={0}
            className={`node node-${v.status} ${selectedId === v.task.id ? "node-selected" : ""}`}
            style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
            onClick={() => onSelect(v.task.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(v.task.id)}
            title={v.task.description}
          >
            <div className="node-head">
              {v.userError !== undefined ? (
                <span className="tier tier-error">erreur</span>
              ) : (
                <span className={`tier tier-${v.task.tier}`}>{v.task.tier}</span>
              )}
              <span className="node-type">{v.task.type}</span>
              <span className={`dot dot-${v.status}`} />
            </div>
            <div className="node-desc">{v.task.description}</div>
            <div className="node-foot">
              <span className="node-model" title={v.provider !== undefined ? `${v.provider} · ${v.model ?? ""}` : undefined}>
                {v.provider !== undefined ? `${v.provider} · ` : ""}
                {v.model ?? "—"}
                {v.fallbackFrom !== undefined ? " ↺" : ""}
              </span>
              {m !== undefined ? (
                <span className="node-cost">
                  {m.billedCost > 0 ? `$${m.billedCost.toFixed(4)}` : `${(m.durationMs / 1000).toFixed(1)} s`}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const clamp = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Graphe du pipeline avec zoom (molette, autour du curseur), déplacement (glisser le fond) et cadrage. */
export function ZoomableDag(props: DagProps): React.JSX.Element {
  const { views } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [view, setView] = useState({ scale: 1, x: 24, y: 24 });

  // La géométrie ne change qu'avec la forme du plan (pas avec les statuts) → pas de recadrage intempestif.
  const shapeKey = views.map((v) => `${v.task.id}:${v.task.dependsOn.join(",")}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => computeLayout(views), [shapeKey]);

  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (el === null || layout.width === 0) return;
    const pad = 32;
    const scale = clamp(
      Math.min((el.clientWidth - pad * 2) / layout.width, (el.clientHeight - pad * 2) / layout.height, 1.2),
    );
    setView({ scale, x: (el.clientWidth - layout.width * scale) / 2, y: (el.clientHeight - layout.height * scale) / 2 });
  }, [layout]);

  // Nouveau plan : recadrage. L'utilisateur reprend la main dès qu'il zoome ou déplace.
  const userAdjusted = useRef(false);
  const refit = useCallback(() => {
    userAdjusted.current = false;
    fit();
  }, [fit]);
  useEffect(() => refit(), [refit]);

  const hasPlan = views.length > 0;

  // Panneau redimensionné : on recadre tant que l'utilisateur n'a pas ajusté lui-même.
  useEffect(() => {
    const el = viewportRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!userAdjusted.current) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, hasPlan]);

  useEffect(() => {
    const el = viewportRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      userAdjusted.current = true;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const s = clamp(v.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        return { scale: s, x: px - (px - v.x) * (s / v.scale), y: py - (py - v.y) * (s / v.scale) };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasPlan]);

  const zoomBy = (factor: number): void => {
    userAdjusted.current = true;
    const el = viewportRef.current;
    const cx = (el?.clientWidth ?? 0) / 2;
    const cy = (el?.clientHeight ?? 0) / 2;
    setView((v) => {
      const s = clamp(v.scale * factor);
      return { scale: s, x: cx - (cx - v.x) * (s / v.scale), y: cy - (cy - v.y) * (s / v.scale) };
    });
  };

  if (!hasPlan) {
    return <p className="muted dag-empty">Le plan apparaîtra ici une fois le prompt décomposé.</p>;
  }

  return (
    <div className="zoom-wrap">
      <div className="zoom-tools">
        <button onClick={() => zoomBy(1.2)} aria-label="Zoomer">
          +
        </button>
        <button onClick={() => zoomBy(1 / 1.2)} aria-label="Dézoomer">
          −
        </button>
        <button onClick={refit}>Ajuster</button>
        <span className="muted small">{Math.round(view.scale * 100)} %</span>
      </div>
      <div
        ref={viewportRef}
        className="zoom-viewport"
        onPointerDown={(e) => {
          if ((e.target as Element).closest(".node, .zoom-tools") !== null) return;
          userAdjusted.current = true;
          drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d === null) return;
          setView((v) => ({ ...v, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onDoubleClick={(e) => (e.target as Element).closest(".node") === null && refit()}
      >
        <div
          className="zoom-content"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          <PipelineView {...props} layout={layout} />
        </div>
      </div>
    </div>
  );
}
