import type { Gap, MapGraph, MapNode, SourceRange } from '../model/types';

/** One row of the sidebar tree, independent of the VS Code API. */
export interface Entry {
  /** Stable across re-analyses, so expanded rows stay expanded. */
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** Codicon name, and an optional theme colour id for it. */
  icon: string;
  iconColor?: string;
  /** Clicking focuses the map on this node. */
  focus?: string;
  /** Source to open: the block's code, or a gap's evidence. */
  source?: SourceRange;
  /** Clicking opens `source` instead of focusing the map. */
  opensSource?: boolean;
  children?: Entry[];
  expanded?: boolean;
}

const METHOD_COLOUR: Record<string, string> = {
  GET: 'charts.blue', POST: 'charts.green', PUT: 'charts.orange', PATCH: 'charts.orange', DELETE: 'charts.red',
};

/** Endpoints grouped by resource, pages, tables and gaps; empty sections are left out. */
export function contentsOf(graph: MapGraph): Entry[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const sections: Entry[] = [];

  const routes = graph.nodes.filter((n) => n.kind === 'route')
    .sort((a, b) => String(a.meta?.path).localeCompare(String(b.meta?.path)) || a.name.localeCompare(b.name));
  const groups = new Map<string, MapNode[]>();
  for (const r of routes) {
    const group = '/' + String(r.meta?.path ?? '').split('/').filter(Boolean).slice(0, 2).join('/');
    groups.set(group, [...(groups.get(group) ?? []), r]);
  }
  if (routes.length) {
    sections.push({
      id: 'section:endpoints',
      label: 'Endpoints',
      description: String(routes.length),
      icon: 'globe',
      expanded: true,
      children: [...groups.entries()].map(([group, list]) => ({
        id: `group:${group}`,
        label: group,
        description: String(list.length),
        icon: 'folder',
        children: list.map((r) => routeEntry(r, group, byId)),
      })),
    });
  }

  const pages = graph.nodes.filter((n) => n.kind === 'page').sort((a, b) => a.name.localeCompare(b.name));
  if (pages.length) {
    sections.push({
      id: 'section:pages',
      label: 'Pages',
      description: String(pages.length),
      icon: 'browser',
      children: pages.map((p) => ({
        id: p.id,
        label: p.name,
        description: ((p.meta?.components as string[] | undefined) ?? []).join(' › '),
        icon: p.meta?.layout ? 'layout' : 'browser',
        focus: p.id,
        source: p.ranges[0],
      })),
    });
  }

  const tables = graph.nodes.filter((n) => n.kind === 'table').sort((a, b) => a.name.localeCompare(b.name));
  if (tables.length) {
    sections.push({
      id: 'section:tables',
      label: 'Tables',
      description: String(tables.length),
      icon: 'database',
      children: tables.map((t) => {
        const columns = (t.meta?.columns as string[] | undefined) ?? [];
        const known = t.meta?.inSchema !== false;
        return {
          id: t.id,
          label: t.name,
          description: known ? `${columns.length} column${columns.length === 1 ? '' : 's'}` : 'not in any .sql file',
          tooltip: known ? columns.join(', ') : 'Used in code but not defined in any .sql file',
          icon: known ? 'database' : 'warning',
          iconColor: known ? undefined : 'problemsWarningIcon.foreground',
          focus: t.id,
          source: t.ranges[0],
        };
      }),
    });
  }

  if (graph.gaps.length) {
    sections.push({
      id: 'section:gaps',
      label: 'Gaps',
      description: String(graph.gaps.length),
      icon: 'warning',
      children: graph.gaps.map((g, i) => gapEntry(g, i)),
    });
  }
  return sections;
}

function routeEntry(r: MapNode, group: string, byId: Map<string, MapNode>): Entry {
  const method = String(r.meta?.method ?? '');
  const path = String(r.meta?.path ?? r.name);
  const rest = path.startsWith(group) ? path.slice(group.length) || '/' : path;
  if (r.meta?.defined === false) {
    return {
      id: r.id, label: `${method} ${rest}`, description: 'no server route', icon: 'warning',
      iconColor: 'problemsWarningIcon.foreground', focus: r.id,
      tooltip: `${method} ${path}\nCalled by the app, but no server route matches it.`,
    };
  }
  const handler = r.meta?.handler ? byId.get(r.meta.handler as string) : undefined;
  const guards = ((r.meta?.middleware as { label: string; fn?: string }[] | undefined) ?? []).filter((m) => m.fn).map((m) => m.label);
  const tip = [`${method} ${path}`];
  if (guards.length) tip.push(`Guards: ${guards.join(' → ')}`);
  if (handler) tip.push(`Handler: ${handler.name} (${where(handler.ranges[0])})`);
  return {
    id: r.id,
    label: `${method} ${rest}`,
    description: handler?.name,
    tooltip: tip.join('\n'),
    icon: 'circle-filled',
    iconColor: METHOD_COLOUR[method],
    focus: r.id,
    source: r.ranges[0],
  };
}

function gapEntry(g: Gap, i: number): Entry {
  return {
    id: `gap:${i}:${g.evidence.file}:${g.evidence.startLine}`,
    label: g.message,
    description: where(g.evidence),
    tooltip: `${g.message}\n${g.evidence.file}:${g.evidence.startLine}`,
    icon: 'warning',
    iconColor: 'problemsWarningIcon.foreground',
    source: g.evidence,
    opensSource: true,
  };
}

function where(r: SourceRange | undefined): string {
  return r ? `${r.file.split('/').pop()}:${r.startLine}` : '';
}
