import type { EdgeKind, Gap, MapEdge, MapGraph, MapNode, SourceRange } from '../model/types';

/** Collects nodes and edges; the first evidence seen for an edge is kept. */
export class GraphBuilder {
  private nodes = new Map<string, MapNode>();
  private edges = new Map<string, MapEdge>();
  readonly gaps: Gap[] = [];

  constructor(private root: string) {}

  addNode(node: MapNode): MapNode {
    const existing = this.nodes.get(node.id);
    if (existing) {
      existing.ranges.push(...node.ranges.filter((r) => !existing.ranges.some((e) => sameRange(e, r))));
      existing.meta = { ...node.meta, ...existing.meta };
      return existing;
    }
    this.nodes.set(node.id, node);
    return node;
  }

  getNode(id: string): MapNode | undefined {
    return this.nodes.get(id);
  }

  addEdge(edge: MapEdge): void {
    if (edge.from === edge.to) return;
    const key = edgeKey(edge.kind, edge.from, edge.to);
    if (!this.edges.has(key)) this.edges.set(key, edge);
  }

  addGap(gap: Gap): void {
    this.gaps.push(gap);
  }

  allNodes(): MapNode[] {
    return [...this.nodes.values()];
  }

  allEdges(): MapEdge[] {
    return [...this.edges.values()];
  }

  toGraph(): MapGraph {
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const edgeOrder = (a: MapEdge, b: MapEdge) => {
      const ka = edgeKey(a.kind, a.from, a.to);
      const kb = edgeKey(b.kind, b.from, b.to);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    };
    return {
      root: this.root,
      nodes: this.allNodes().sort(byId),
      edges: this.allEdges().sort(edgeOrder),
      gaps: [...this.gaps],
    };
  }
}

function edgeKey(kind: EdgeKind, from: string, to: string): string {
  return `${from}|${kind}|${to}`;
}

function sameRange(a: SourceRange, b: SourceRange): boolean {
  return a.file === b.file && a.startLine === b.startLine && a.startCol === b.startCol
    && a.endLine === b.endLine && a.endCol === b.endCol;
}
