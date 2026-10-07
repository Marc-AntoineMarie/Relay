import type { TaskView } from "./types";

const NODE_W = 210;
const NODE_H = 72;
const COL_STRIDE = 300;
const ROW_STRIDE = 100;

/** Profondeur = plus long chemin de dépendances (⇒ colonne). */
function computeColumns(views: TaskView[]): TaskView[][] {
  const byId = new Map(views.map((v) => [v.task.id, v]));
  const depthCache = new Map<string, number>();

  const depth = (id: string, seen: Set<string>): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const v = byId.get(id);
    if (v === undefined || v.task.dependsOn.length === 0) {
      depthCache.set(id, 0);
      return 0;
    }
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = 1 + Math.max(...v.task.dependsOn.map((x) => depth(x, seen)));
    depthCache.set(id, d);
    return d;
  };

  const cols: TaskView[][] = [];
  for (const v of views) {
    const d = depth(v.task.id, new Set());
    (cols[d] ??= []).push(v);
  }
  return cols;
}

export function PipelineView({ views }: { views: TaskView[] }): React.JSX.Element {
  if (views.length === 0) {
    return <p className="muted">Le plan apparaîtra ici une fois le prompt décomposé.</p>;
  }

  const cols = computeColumns(views);
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, c) => {
    col.forEach((v, i) => {
      pos.set(v.task.id, { x: c * COL_STRIDE, y: i * ROW_STRIDE });
    });
  });

  const width = Math.max(1, cols.length) * COL_STRIDE;
  const tallest = Math.max(1, ...cols.map((c) => c.length));
  const height = tallest * ROW_STRIDE;

  return (
    <div className="dag" style={{ width, height }}>
      <svg className="dag-edges" width={width} height={height}>
        <defs>
          <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6 Z" fill="var(--edge)" />
          </marker>
        </defs>
        {views.flatMap((v) =>
          v.task.dependsOn.map((depId) => {
            const from = pos.get(depId);
            const to = pos.get(v.task.id);
            if (from === undefined || to === undefined) return null;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={`${depId}-${v.task.id}`}
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 8},${y2}`}
                className="edge"
                markerEnd="url(#arrow)"
              />
            );
          }),
        )}
      </svg>
      {views.map((v) => {
        const p = pos.get(v.task.id);
        if (p === undefined) return null;
        return (
          <div
            key={v.task.id}
            className={`node node-${v.status}`}
            style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
            title={v.task.description}
          >
            <div className="node-head">
              <span className={`tier tier-${v.task.tier}`}>{v.task.tier}</span>
              <span className="node-type">{v.task.type}</span>
              <span className={`dot dot-${v.status}`} />
            </div>
            <div className="node-desc">{v.task.description}</div>
            <div className="node-foot">
              {v.model ? <span className="node-model">{v.model}</span> : null}
              {v.cost !== undefined ? (
                <span className="node-cost">
                  {v.billed && v.billed > 0 ? `$${v.billed.toFixed(4)}` : `$${v.cost.toFixed(4)} éq.`}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
