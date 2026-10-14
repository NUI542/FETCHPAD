import type { Layer, MapEdge, MapNode } from '../model/types';

/**
 * Put each node in a feature-map column based on its role in the graph:
 * what serves a route, what queries a table, what makes a request.
 * Folder names play no part, so it works for any project layout.
 */
export function assignLayers(nodes: MapNode[], edges: MapEdge[]): void {
  const targets = (kind: MapEdge['kind']) => new Set(edges.filter((e) => e.kind === kind).map((e) => e.to));
  const sources = (kind: MapEdge['kind']) => new Set(edges.filter((e) => e.kind === kind).map((e) => e.from));

  const handlers = targets('handles');
  const middleware = targets('middleware');
  const data = new Set([...sources('reads'), ...sources('writes')]);
  const requesters = sources('requests');

  const callees = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    const list = callees.get(e.from) ?? [];
    list.push(e.to);
    callees.set(e.from, list);
  }
  const reach = (start: Iterable<string>): Set<string> => {
    const seen = new Set<string>();
    const queue = [...start];
    while (queue.length) {
      const id = queue.pop()!;
      for (const next of callees.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };
  const serverSide = reach(handlers);
  const clientSide = reach(requesters);

  for (const node of nodes) {
    node.layer = layerOf(node);
  }

  function layerOf(node: MapNode): Layer {
    switch (node.kind) {
      case 'route': return 'route';
      case 'table':
      case 'column': return 'table';
      case 'page': return 'page';
      case 'file': return 'other';
    }
    if (node.meta?.test) return 'test';
    if (handlers.has(node.id)) return 'handler';
    if (middleware.has(node.id)) return 'middleware';
    if (data.has(node.id)) return 'data';
    if (node.kind === 'component') return 'ui';
    if (requesters.has(node.id)) return 'client';
    if (serverSide.has(node.id)) return 'service';
    if (clientSide.has(node.id)) return 'client';
    return 'other';
  }
}
