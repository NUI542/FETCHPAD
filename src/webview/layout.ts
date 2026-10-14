import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { ViewModel, ViewNode } from './views';

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
}

export interface Layout {
  key: string;
  nodes: Map<string, Box>;
  edges: Map<string, Point[]>;
  columns: { title: string; x: number; width: number; y: number }[];
}

export const BLOCK_WIDTH = 240;

/** Block height follows its content, so layout and rendering agree exactly. */
export function blockHeight(v: ViewNode): number {
  return 70 + (v.chips.length ? 26 : 0);
}

const elk = new ELK();

export async function layoutView(view: ViewModel): Promise<Layout> {
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.partitioning.activate': 'true',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      'elk.spacing.nodeNode': '20',
      'elk.spacing.edgeNode': '16',
      'elk.spacing.edgeEdge': '8',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      // Unconnected blocks (an endpoint nothing calls) stay in their column.
      'elk.separateConnectedComponents': 'false',
      // Respect input order where possible, so the same view lays out the same way.
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // The overview keeps its sorted order outright: endpoints stay grouped by
      // resource and blocks keep their place from one save to the next.
      ...(view.key === 'overview' ? { 'elk.layered.crossingMinimization.forceNodeModelOrder': 'true' } : {}),
    },
    children: view.nodes.map((n) => ({
      id: n.id,
      width: BLOCK_WIDTH,
      height: blockHeight(n),
      layoutOptions: { 'elk.partitioning.partition': String(n.column) },
    })),
    edges: view.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };

  const result = await elk.layout(graph);
  const nodes = new Map<string, Box>();
  for (const c of result.children ?? []) {
    nodes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? BLOCK_WIDTH, height: c.height ?? 70 });
  }
  const edges = new Map<string, Point[]>();
  for (const e of result.edges ?? []) {
    const points: Point[] = [];
    for (const s of e.sections ?? []) {
      points.push(s.startPoint, ...(s.bendPoints ?? []), s.endPoint);
    }
    if (points.length) edges.set(e.id, points);
  }

  const top = Math.min(...[...nodes.values()].map((b) => b.y), 0);
  const columns: Layout['columns'] = [];
  view.columns.forEach((title, i) => {
    const boxes = view.nodes.filter((n) => n.column === i).map((n) => nodes.get(n.id)).filter((b): b is Box => !!b);
    if (!boxes.length) return;
    const left = Math.min(...boxes.map((b) => b.x));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    columns.push({ title, x: left, width: right - left, y: top - 44 });
  });

  return { key: view.key, nodes, edges, columns };
}
