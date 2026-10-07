import type { TaskView } from "./types";

const NODE_W = 220;
const NODE_H = 78;
const COL_STRIDE = 290;
const ROW_STRIDE = 100;

/** Colonne = longueur du plus long chemin de dépendances. */
function computeColumns(views: TaskView[]): TaskView[][] {
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
  return cols;
}

export function PipelineView(props: {
  views: TaskView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const { views, selectedId, onSelect } = props;
  if (views.length === 0) {
    return <p className="muted dag-empty">Le plan apparaîtra ici une fois le prompt décomposé.</p>;
  }

  const cols = computeColumns(views);
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, c) => col.forEach((v, i) => pos.set(v.task.id, { x: c * COL_STRIDE, y: i * ROW_STRIDE })));
  const width = (cols.length - 1) * COL_STRIDE + NODE_W;
  const height = (Math.max(...cols.map((c) => c.length)) - 1) * ROW_STRIDE + NODE_H;

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
            const active = v.status === "running";
            return (
              <path
                key={`${depId}-${v.task.id}`}
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 6},${y2}`}
                className={`edge ${active ? "edge-active" : ""}`}
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
              <span className={`tier tier-${v.task.tier}`}>{v.task.tier}</span>
              <span className="node-type">{v.task.type}</span>
              <span className={`dot dot-${v.status}`} />
            </div>
            <div className="node-desc">{v.task.description}</div>
            <div className="node-foot">
              <span className="node-model">
                {v.model ?? "—"}
                {v.fallbackFrom !== undefined ? " ↺" : ""}
              </span>
              {m !== undefined ? (
                <span className="node-cost">{m.billedCost > 0 ? `$${m.billedCost.toFixed(4)}` : `${(m.durationMs / 1000).toFixed(1)} s`}</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
