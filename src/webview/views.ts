import type { EdgeKind, Layer, MapEdge, MapGraph, MapNode } from '../model/types';

/** Edges that make up a feature's chain, from page down to table. */
const CHAIN: ReadonlySet<EdgeKind> = new Set(['renders', 'calls', 'requests', 'handles', 'reads', 'writes']);
const MAX_DEPTH = 12;

export interface Chip {
  label: string;
  /** Unit ID of app-defined middleware; library middleware has none. */
  fn?: string;
}

export interface ViewNode {
  id: string;
  node: MapNode;
  column: number;
  /** App-defined middleware a route runs, in order. */
  chips: Chip[];
  /** Library middleware (cors, express.json), shown only as a count. */
  libraryMiddleware: string[];
  /** Helper functions folded into this block. */
  helpers: number;
  focus: boolean;
}

export interface ViewEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  resolved: boolean;
  /** The graph edge itself, when the view edge is not a summary. */
  edge?: MapEdge;
  /** For summary edges: the blocks the real path passes through. */
  via?: string[];
}

export interface ViewModel {
  key: string;
  title: string;
  columns: string[];
  nodes: ViewNode[];
  edges: ViewEdge[];
}

export const FEATURE_COLUMNS: { layer: Layer; title: string }[] = [
  { layer: 'page', title: 'Pages' },
  { layer: 'ui', title: 'Components' },
  { layer: 'client', title: 'API client' },
  { layer: 'route', title: 'Endpoints' },
  { layer: 'handler', title: 'Handlers' },
  { layer: 'service', title: 'Logic' },
  { layer: 'data', title: 'Data access' },
  { layer: 'table', title: 'Tables' },
];

export class GraphIndex {
  readonly byId = new Map<string, MapNode>();
  private out = new Map<string, MapEdge[]>();
  private in = new Map<string, MapEdge[]>();
  private clientReach = new Map<string, boolean>();

  constructor(readonly graph: MapGraph) {
    for (const n of graph.nodes) this.byId.set(n.id, n);
    for (const e of graph.edges) {
      push(this.out, e.from, e);
      push(this.in, e.to, e);
    }
  }

  node(id: string): MapNode | undefined {
    return this.byId.get(id);
  }

  outgoing(id: string, kinds: ReadonlySet<EdgeKind> = CHAIN): MapEdge[] {
    return (this.out.get(id) ?? []).filter((e) => kinds.has(e.kind));
  }

  incoming(id: string, kinds: ReadonlySet<EdgeKind> = CHAIN): MapEdge[] {
    return (this.in.get(id) ?? []).filter((e) => kinds.has(e.kind));
  }

  /** Does this function lead, through calls, to code that makes a request? (custom hooks, API helpers) */
  reachesClient(id: string): boolean {
    const cached = this.clientReach.get(id);
    if (cached !== undefined) return cached;
    const seen = new Set([id]);
    const queue = [id];
    let found = false;
    while (queue.length && !found) {
      for (const e of this.outgoing(queue.pop()!, CALLS)) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        if (this.node(e.to)?.layer === 'client') found = true;
        queue.push(e.to);
      }
    }
    this.clientReach.set(id, found);
    return found;
  }
}

const CALLS: ReadonlySet<EdgeKind> = new Set(['calls']);
const FRONTEND_STEPS: ReadonlySet<EdgeKind> = new Set(['renders', 'calls']);
const REQUESTS: ReadonlySet<EdgeKind> = new Set(['requests']);
const HANDLES: ReadonlySet<EdgeKind> = new Set(['handles']);
const DATA: ReadonlySet<EdgeKind> = new Set(['reads', 'writes']);

/**
 * The whole app on one screen: which pages call which endpoints, and which
 * tables each endpoint writes (and, optionally, reads).
 */
export function overviewView(index: GraphIndex, { showReads }: { showReads: boolean }): ViewModel {
  const nodes: ViewNode[] = [];
  const edges = new Map<string, ViewEdge>();
  const all = index.graph.nodes;

  const pages = all.filter((n) => n.kind === 'page').sort(byMeta('path'));
  const routes = all.filter((n) => n.kind === 'route').sort((a, b) => routeSortKey(a).localeCompare(routeSortKey(b)));
  const tables = all.filter((n) => n.kind === 'table').sort((a, b) => a.name.localeCompare(b.name));

  // Walk each entry point's component tree to the API calls it makes.
  const reached = new Set<string>();
  const linkRequests = (entry: MapNode): void => {
    const parent = new Map<string, string>([[entry.id, '']]);
    const queue: [string, number][] = [[entry.id, 0]];
    while (queue.length) {
      const [id, depth] = queue.shift()!;
      reached.add(id);
      for (const req of index.outgoing(id, REQUESTS)) {
        const key = `requests|${entry.id}|${req.to}`;
        if (!edges.has(key)) {
          edges.set(key, { id: key, from: entry.id, to: req.to, kind: 'requests', resolved: req.resolved, via: pathTo(parent, id) });
        }
      }
      if (depth >= MAX_DEPTH) continue;
      for (const e of index.outgoing(id, FRONTEND_STEPS)) {
        const next = index.node(e.to);
        if (!next || parent.has(e.to) || next.kind === 'route' || next.layer === 'test') continue;
        parent.set(e.to, id);
        queue.push([e.to, depth + 1]);
      }
    }
  };
  for (const page of pages) {
    nodes.push(viewNode(page, 0));
    linkRequests(page);
  }

  // Requests no page leads to (a context provider, a component outside the
  // router) still need a caller on the map: use the nearest component above.
  const extra = new Map<string, MapNode>();
  for (const route of routes) {
    for (const req of index.incoming(route.id, REQUESTS)) {
      if (reached.has(req.from) || index.node(req.from)?.layer === 'test') continue;
      for (const entry of nearestComponents(index, req.from)) {
        if (!reached.has(entry.id)) extra.set(entry.id, entry);
      }
    }
  }
  for (const entry of [...extra.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    nodes.push(viewNode(entry, 0));
    linkRequests(entry);
  }

  for (const route of routes) {
    nodes.push(viewNode(route, 1));
    const touched = new Map<string, 'writes' | 'reads'>();
    for (const fn of reachable(index, index.outgoing(route.id, HANDLES).map((e) => e.to))) {
      for (const e of index.outgoing(fn, DATA)) {
        if (e.kind === 'writes' || !touched.has(e.to)) touched.set(e.to, e.kind as 'writes' | 'reads');
      }
    }
    for (const [table, kind] of touched) {
      if (kind === 'reads' && !showReads) continue;
      const key = `${kind}|${route.id}|${table}`;
      edges.set(key, { id: key, from: route.id, to: table, kind, resolved: true });
    }
  }

  for (const table of tables) nodes.push(viewNode(table, 2));
  return {
    key: 'overview',
    title: 'Overview',
    columns: ['Pages and callers', 'Endpoints', 'Tables'],
    nodes,
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * Everything a block takes part in: the chain above it (who calls it, up to
 * the pages) and below it (what it calls, down to the tables). Starting
 * anywhere but an endpoint, the walk stops at endpoints, so focusing on a
 * page shows the API it uses rather than the whole backend behind it.
 */
export function focusView(index: GraphIndex, focusId: string, { showHelpers }: { showHelpers: boolean }): ViewModel | undefined {
  const start = index.node(focusId);
  if (!start) return undefined;
  const stopsAt = (id: string) => id !== focusId && start.kind !== 'route' && index.node(id)?.kind === 'route';
  const skip = (id: string) => index.node(id)?.layer === 'test' && start.layer !== 'test';

  const walk = (dir: 'up' | 'down'): Set<string> => {
    const found = new Set<string>();
    let frontier = [focusId];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        const steps = dir === 'up' ? index.incoming(id).map((e) => e.from) : index.outgoing(id).map((e) => e.to);
        for (const other of steps) {
          if (other === focusId || found.has(other) || skip(other) || !index.node(other)) continue;
          found.add(other);
          if (!stopsAt(other)) next.push(other);
        }
      }
      frontier = next;
    }
    return found;
  };
  const up = walk('up');
  const down = walk('down');

  // Below the focus, keep what leads to an endpoint or a table; the rest are helpers.
  const leads = new Set<string>();
  const queue = [...down].filter((id) => ['route', 'table'].includes(index.node(id)!.kind));
  for (const id of queue) leads.add(id);
  while (queue.length) {
    for (const e of index.incoming(queue.pop()!)) {
      if (down.has(e.from) && !leads.has(e.from)) {
        leads.add(e.from);
        queue.push(e.from);
      }
    }
  }
  const hidden = new Set(showHelpers ? [] : [...down].filter((id) => !leads.has(id) && !up.has(id)));
  const shown = new Set([focusId, ...up, ...down].filter((id) => !hidden.has(id)));

  const helpers = new Map<string, Set<string>>();
  for (const h of hidden) {
    for (const e of index.incoming(h)) {
      if (!shown.has(e.from)) continue;
      const set = helpers.get(e.from) ?? new Set<string>();
      set.add(h);
      helpers.set(e.from, set);
    }
  }

  const nodes = [...shown].map((id) => {
    const n = index.node(id)!;
    const v = viewNode(n, columnOf(index, n), id === focusId);
    v.helpers = helpers.get(id)?.size ?? 0;
    return v;
  }).sort((a, b) => a.column - b.column || a.node.name.localeCompare(b.node.name) || a.id.localeCompare(b.id));

  const edges: ViewEdge[] = [];
  for (const id of shown) {
    for (const e of index.outgoing(id)) {
      if (!shown.has(e.to)) continue;
      const key = `${e.kind}|${e.from}|${e.to}`;
      edges.push({ id: key, from: e.from, to: e.to, kind: e.kind, resolved: e.resolved, edge: e });
    }
  }
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return {
    key: `focus:${focusId}`,
    title: start.name,
    columns: FEATURE_COLUMNS.map((c) => c.title),
    nodes,
    edges,
  };
}

function columnOf(index: GraphIndex, n: MapNode): number {
  const at = (layer: Layer) => FEATURE_COLUMNS.findIndex((c) => c.layer === layer);
  switch (n.layer) {
    case 'test': return at('page');
    case 'middleware': return at('service');
    case 'other': return index.reachesClient(n.id) ? at('client') : at('service');
    case undefined: return at('service');
    default: {
      const i = at(n.layer);
      return i >= 0 ? i : at('service');
    }
  }
}

function viewNode(node: MapNode, column: number, focus = false): ViewNode {
  const middleware = (node.meta?.middleware as Chip[] | undefined) ?? [];
  return {
    id: node.id,
    node,
    column,
    chips: middleware.filter((m) => m.fn).map((m) => ({ label: m.label, fn: m.fn })),
    libraryMiddleware: middleware.filter((m) => !m.fn).map((m) => m.label),
    helpers: 0,
    focus,
  };
}

/** The first components above a function (through calls and renders); the function itself if there are none. */
function nearestComponents(index: GraphIndex, id: string): MapNode[] {
  const found = new Map<string, MapNode>();
  const seen = new Set([id]);
  let frontier = [id];
  for (let depth = 0; depth < 6 && frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const e of index.incoming(f, FRONTEND_STEPS)) {
        const caller = index.node(e.from);
        if (!caller || seen.has(caller.id) || caller.layer === 'test') continue;
        seen.add(caller.id);
        if (caller.kind === 'component' || caller.kind === 'page') found.set(caller.id, caller);
        else next.push(caller.id);
      }
    }
    frontier = next;
  }
  const self = index.node(id);
  return found.size ? [...found.values()] : self ? [self] : [];
}

function reachable(index: GraphIndex, start: string[]): string[] {
  const seen = new Set(start);
  const queue = [...start];
  while (queue.length) {
    for (const e of index.outgoing(queue.pop()!, CALLS)) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return [...seen];
}

/** Blocks between the start of a walk and `id`, excluding the start. */
function pathTo(parent: Map<string, string>, id: string): string[] {
  const out: string[] = [];
  for (let at = id; parent.get(at); at = parent.get(at)!) out.unshift(at);
  return out;
}

function routeSortKey(n: MapNode): string {
  const path = (n.meta?.path as string | undefined) ?? n.name;
  const method = (n.meta?.method as string | undefined) ?? '';
  return `${path} ${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method)}`;
}

function byMeta(key: string) {
  return (a: MapNode, b: MapNode) => String(a.meta?.[key] ?? a.name).localeCompare(String(b.meta?.[key] ?? b.name)) || a.id.localeCompare(b.id);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
