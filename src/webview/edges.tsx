import { useInternalNode, type Edge, type EdgeProps } from '@xyflow/react';
import { useContext } from 'react';
import { HighlightContext } from './context';
import type { Point } from './layout';
import type { ViewEdge } from './views';

export type RoutedEdgeData = Edge<{ view: ViewEdge; points?: Point[]; tip: string }, 'routed'>;
export type LeaderEdgeData = Edge<Record<string, never>, 'leader'>;

/** An edge drawn along the route the layout engine chose, with rounded corners. */
export function RoutedEdge({ id, data, sourceX, sourceY, targetX, targetY, markerEnd }: EdgeProps<RoutedEdgeData>) {
  const hl = useContext(HighlightContext);
  if (!data) return null;
  const d = data.points && data.points.length > 1 ? roundedPath(data.points, 8) : `M${sourceX},${sourceY} L${targetX},${targetY}`;
  const lit = hl.active ? (hl.edges.has(id) ? ' is-lit' : ' is-dim') : '';
  const unresolved = data.view.resolved ? '' : ' is-unresolved';
  return (
    <g className={`fp-edge fp-edge-${data.view.kind}${unresolved}${lit}`}>
      <path className="fp-edge-line" d={d} markerEnd={markerEnd} />
      <path className="fp-edge-hit" d={d}>
        <title>{data.tip}</title>
      </path>
    </g>
  );
}

/** The thin line from a code preview back to its block. */
export function LeaderEdge({ source, target }: EdgeProps<LeaderEdgeData>) {
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  if (!a || !b) return null;
  const ax = a.internals.positionAbsolute.x;
  const ay = a.internals.positionAbsolute.y;
  const aw = a.measured.width ?? 0;
  const ah = a.measured.height ?? 0;
  const bx = b.internals.positionAbsolute.x;
  const by = b.internals.positionAbsolute.y;
  const bw = b.measured.width ?? 0;
  const rightOf = bx + bw / 2 >= ax + aw / 2;
  const from = { x: rightOf ? ax + aw : ax, y: ay + ah / 2 };
  const to = { x: rightOf ? bx : bx + bw, y: by + 18 };
  return <path className="fp-leader" d={`M${from.x},${from.y} L${to.x},${to.y}`} />;
}

/** Polyline through `points` with each corner rounded by up to `radius`. */
export function roundedPath(points: Point[], radius: number): string {
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const at = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(at.x - prev.x, at.y - prev.y);
    const outLen = Math.hypot(next.x - at.x, next.y - at.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += ` L${at.x},${at.y}`;
      continue;
    }
    const before = { x: at.x - ((at.x - prev.x) / inLen) * r, y: at.y - ((at.y - prev.y) / inLen) * r };
    const after = { x: at.x + ((next.x - at.x) / outLen) * r, y: at.y + ((next.y - at.y) / outLen) * r };
    d += ` L${before.x},${before.y} Q${at.x},${at.y} ${after.x},${after.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}
