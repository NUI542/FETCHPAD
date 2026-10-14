import * as fs from 'fs';
import * as path from 'path';
import { analyze } from '../engine/analyze';
import type { MiddlewareRef } from '../engine/adapters/express';
import type { MapEdge, MapGraph, MapNode } from '../model/types';

const USAGE = `Usage: npm run analyze -- <project-dir> [--route <text>] [--json <out.json>]

  --route <text>   show the full chain for routes whose "METHOD /path" contains <text>
  --json <file>    also write the whole graph as JSON`;

function main(argv: string[]): void {
  const args = [...argv];
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const routeFilter = take('--route');
  const jsonOut = take('--json');
  const dir = args[0];
  if (!dir) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  const graph = analyze(dir);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(graph, null, 2));

  const view = new GraphView(graph);
  const count = (kind: MapNode['kind']) => graph.nodes.filter((n) => n.kind === kind).length;
  const routes = graph.nodes.filter((n) => n.kind === 'route' && n.meta?.defined !== false)
    .sort((a, b) => (a.meta!.order as number) - (b.meta!.order as number));

  console.log(`Fetchpad · ${graph.root}`);
  console.log(`  ${count('file')} files · ${count('function') + count('component')} functions · ${count('page')} pages · `
    + `${routes.length} routes · ${count('table')} tables · ${graph.edges.length} edges · ${seconds}s`);

  if (routeFilter) {
    const picked = routes.filter((r) => r.name.toLowerCase().includes(routeFilter.toLowerCase()));
    if (!picked.length) console.log(`\nNo route matches "${routeFilter}".`);
    for (const route of picked) printRouteDetail(view, route);
  } else {
    printRouteSummaries(view, routes);
    printGaps(view, graph);
  }
  if (jsonOut) console.log(`\nGraph written to ${path.resolve(jsonOut)}`);
}

/** Index over a graph for walking edges in both directions. */
class GraphView {
  readonly byId = new Map<string, MapNode>();
  private out = new Map<string, MapEdge[]>();
  private in = new Map<string, MapEdge[]>();

  constructor(readonly graph: MapGraph) {
    for (const n of graph.nodes) this.byId.set(n.id, n);
    for (const e of graph.edges) {
      push(this.out, e.from, e);
      push(this.in, e.to, e);
    }
  }

  outgoing(id: string, kind?: MapEdge['kind']): MapEdge[] {
    return (this.out.get(id) ?? []).filter((e) => !kind || e.kind === kind);
  }

  incoming(id: string, kind?: MapEdge['kind']): MapEdge[] {
    return (this.in.get(id) ?? []).filter((e) => !kind || e.kind === kind);
  }

  /** Every function reachable from `start` through calls, `start` included. */
  reachable(start: string): string[] {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      for (const e of this.outgoing(queue.pop()!, 'calls')) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    }
    return [...seen];
  }

  tablesTouched(start: string): { writes: string[]; reads: string[] } {
    const writes = new Set<string>();
    const reads = new Set<string>();
    for (const id of this.reachable(start)) {
      for (const e of this.outgoing(id, 'writes')) writes.add(this.name(e.to));
      for (const e of this.outgoing(id, 'reads')) reads.add(this.name(e.to));
    }
    return { writes: [...writes].sort(), reads: [...reads].filter((t) => !writes.has(t)).sort() };
  }

  /** Nearest components above a function, and the pages that show them. */
  usedBy(id: string): string[] {
    const found: string[] = [];
    const seen = new Set([id]);
    let frontier = [id];
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const e of [...this.incoming(f, 'calls'), ...this.incoming(f, 'renders')]) {
          if (seen.has(e.from)) continue;
          seen.add(e.from);
          const caller = this.byId.get(e.from);
          if (caller?.kind === 'component') {
            const pages = this.incoming(caller.id, 'renders').map((p) => this.byId.get(p.from)).filter((p) => p?.kind === 'page');
            found.push(pages.length ? `${caller.name} (${pages.map((p) => p!.meta!.path).join(', ')})` : caller.name);
          } else if (caller) {
            next.push(caller.id);
          }
        }
      }
      frontier = next;
    }
    return found;
  }

  name(id: string): string {
    return this.byId.get(id)?.name ?? id;
  }

  isTest(id: string): boolean {
    return this.byId.get(id)?.layer === 'test';
  }

  where(id: string): string {
    const r = this.byId.get(id)?.ranges[0];
    return r ? `${r.file}:${r.startLine}` : '';
  }

  /** `name (file)` for functions, so same-named functions in different files can be told apart. */
  label(id: string): string {
    const n = this.byId.get(id);
    if (!n) return id;
    if (n.kind !== 'function' && n.kind !== 'component') return n.name;
    const file = n.ranges[0]?.file.split('/').pop();
    return file ? `${n.name} (${file})` : n.name;
  }
}

function printRouteSummaries(view: GraphView, routes: MapNode[]): void {
  let group = '';
  for (const route of routes) {
    const routePath = route.meta!.path as string;
    const g = routePath.split('/').filter(Boolean).slice(0, 2).join('/');
    if (g !== group) {
      group = g;
      console.log(`\n── /${g} ${'─'.repeat(Math.max(4, 60 - g.length))}`);
    }
    console.log(`${pad(route.name, 48)} ${view.where(route.id)}`);

    const requests = view.incoming(route.id, 'requests');
    const clients = requests.filter((e) => !view.isTest(e.from));
    const tests = [...new Set(requests.filter((e) => view.isTest(e.from)).map((e) => e.evidence.file.split('/').pop()))];
    if (clients.length) {
      for (const c of clients) {
        const used = view.usedBy(c.from);
        const flag = c.resolved ? '' : '  [unconfirmed match]';
        console.log(`  client    ${view.label(c.from)}${flag}${used.length ? `  ← ${used.join(', ')}` : ''}`);
      }
    } else {
      console.log('  client    (nothing in the app calls it)');
    }
    if (tests.length) console.log(`  tests     ${tests.join(', ')}`);
    const middleware = (route.meta!.middleware as MiddlewareRef[]).map((m) => m.label);
    if (middleware.length) console.log(`  guards    ${middleware.join(' → ')}`);
    const handler = route.meta!.handler as string | undefined;
    if (handler) {
      console.log(`  handler   ${view.label(handler)}`);
      const { writes, reads } = view.tablesTouched(handler);
      const parts = [writes.length && `writes ${writes.join(', ')}`, reads.length && `reads ${reads.join(', ')}`].filter(Boolean);
      if (parts.length) console.log(`  tables    ${parts.join(' · ')}`);
    } else {
      console.log('  handler   (not resolved)');
    }
  }
}

function printRouteDetail(view: GraphView, route: MapNode): void {
  console.log(`\n${route.name}    ${view.where(route.id)}`);
  const clients = view.incoming(route.id, 'requests');
  console.log('  called from');
  if (!clients.length) console.log('    (nothing in this repo)');
  for (const c of clients) {
    console.log(`    ${view.label(c.from)}    ${c.evidence.file}:${c.evidence.startLine}${c.note ? `    (${c.note})` : ''}`);
    for (const u of view.usedBy(c.from)) console.log(`      ← ${u}`);
  }
  const middleware = route.meta!.middleware as MiddlewareRef[];
  if (middleware.length) {
    console.log('  middleware, in order');
    middleware.forEach((m, i) => console.log(`    ${i + 1}. ${pad(m.label, 40)} ${m.fn ? view.where(m.fn) : '(library)'}`));
  }
  const handler = route.meta!.handler as string | undefined;
  if (!handler) return;
  console.log('  handler');
  const printed = new Set<string>();
  const walk = (id: string, depth: number): void => {
    const tables = [
      ...view.outgoing(id, 'writes').map((e) => `writes ${view.name(e.to)}`),
      ...view.outgoing(id, 'reads').map((e) => `reads ${view.name(e.to)}`),
    ];
    const suffix = tables.length ? `  [${tables.join(', ')}]` : '';
    const indent = '    ' + '   '.repeat(depth);
    if (printed.has(id)) {
      console.log(`${indent}${depth ? '→ ' : ''}${view.label(id)}  (shown above)`);
      return;
    }
    printed.add(id);
    console.log(`${indent}${depth ? '→ ' : ''}${pad(view.label(id), Math.max(10, 44 - depth * 3))} ${view.where(id)}${suffix}`);
    if (depth >= 8) return;
    const inSourceOrder = view.outgoing(id, 'calls')
      .sort((a, b) => a.evidence.startLine - b.evidence.startLine || a.evidence.startCol - b.evidence.startCol);
    for (const e of inSourceOrder) walk(e.to, depth + 1);
  };
  walk(handler, 0);
}

function printGaps(view: GraphView, graph: MapGraph): void {
  const unusedTables = graph.nodes.filter((n) => n.kind === 'table'
    && !view.incoming(n.id, 'reads').length && !view.incoming(n.id, 'writes').length);
  if (!graph.gaps.length && !unusedTables.length) return;
  console.log(`\n── Gaps and loose ends ${'─'.repeat(44)}`);
  for (const gap of graph.gaps) console.log(`  ${pad(gap.kind, 18)} ${gap.message}    ${gap.evidence.file}:${gap.evidence.startLine}`);
  if (unusedTables.length) console.log(`  ${pad('unused-table', 18)} no query in code touches: ${unusedTables.map((t) => t.name).join(', ')}`);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

main(process.argv.slice(2));
