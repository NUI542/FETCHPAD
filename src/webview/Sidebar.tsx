import { useMemo, useState, type ReactNode } from 'react';
import type { MapNode, SourceRange } from '../model/types';
import type { GraphIndex } from './views';

interface Props {
  index: GraphIndex;
  current: string;
  onSelect(id: string): void;
  onOpen(range: SourceRange): void;
}

const MAX_FUNCTIONS = 40;

export function Sidebar({ index, current, onSelect, onOpen }: Props) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (n: MapNode) => !q || n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q);

  const { groups, pages, tables, functions } = useMemo(() => {
    const nodes = index.graph.nodes;
    const routes = nodes.filter((n) => n.kind === 'route' && matches(n))
      .sort((a, b) => String(a.meta?.path).localeCompare(String(b.meta?.path)) || a.name.localeCompare(b.name));
    const groups = new Map<string, MapNode[]>();
    for (const r of routes) {
      const group = '/' + String(r.meta?.path ?? '').split('/').filter(Boolean).slice(0, 2).join('/');
      groups.set(group, [...(groups.get(group) ?? []), r]);
    }
    return {
      groups: [...groups.entries()],
      pages: nodes.filter((n) => n.kind === 'page' && matches(n)).sort((a, b) => a.name.localeCompare(b.name)),
      tables: nodes.filter((n) => n.kind === 'table' && matches(n)).sort((a, b) => a.name.localeCompare(b.name)),
      functions: q
        ? nodes.filter((n) => (n.kind === 'function' || n.kind === 'component') && n.layer !== 'test' && matches(n))
          .sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_FUNCTIONS)
        : [],
    };
  }, [index, q]);

  const item = (n: MapNode, label: ReactNode = n.name, hint?: string) => (
    <li key={n.id}>
      <button className={`fp-item${current === n.id ? ' is-current' : ''}`} onClick={() => onSelect(n.id)}
        title={hint ?? n.name} aria-current={current === n.id ? 'true' : undefined}>
        {label}
      </button>
    </li>
  );
  const routeCount = groups.reduce((sum, [, list]) => sum + list.length, 0);

  return (
    <aside className="fp-sidebar" aria-label="Map contents">
      <input className="fp-search" type="search" placeholder="Search endpoints, pages, tables, code"
        aria-label="Search the map" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="fp-list">
        <li>
          <button className={`fp-item fp-item-top${current === 'overview' ? ' is-current' : ''}`} onClick={() => onSelect('overview')}>
            Overview
          </button>
        </li>
      </ul>

      <Section title="Endpoints" count={routeCount}>
        {groups.map(([group, list]) => (
          <li key={group}>
            <div className="fp-group">{group}</div>
            <ul className="fp-list">
              {list.map((r) => item(r, <RouteLabel node={r} group={group} />, r.name))}
            </ul>
          </li>
        ))}
      </Section>
      <Section title="Pages" count={pages.length}>{pages.map((p) => item(p))}</Section>
      <Section title="Tables" count={tables.length}>{tables.map((t) => item(t))}</Section>
      {q && (
        <Section title="Code" count={functions.length}>
          {functions.map((f) => item(f, <>{f.name} <span className="fp-item-hint">{f.ranges[0]?.file.split('/').pop()}</span></>, f.id))}
        </Section>
      )}
      {!q && index.graph.gaps.length > 0 && (
        <Section title="Gaps" count={index.graph.gaps.length} open={false}>
          {index.graph.gaps.map((g, i) => (
            <li key={i}>
              <button className="fp-item fp-gap" title={`${g.message}\n${g.evidence.file}:${g.evidence.startLine}`} onClick={() => onOpen(g.evidence)}>
                {g.message}
              </button>
            </li>
          ))}
        </Section>
      )}
    </aside>
  );
}

function Section({ title, count, open = true, children }: { title: string; count: number; open?: boolean; children: ReactNode }) {
  if (!count) return null;
  return (
    <details className="fp-section" open={open}>
      <summary>{title} <span className="fp-count">{count}</span></summary>
      <ul className="fp-list">{children}</ul>
    </details>
  );
}

function RouteLabel({ node, group }: { node: MapNode; group: string }) {
  const method = String(node.meta?.method ?? '');
  const path = String(node.meta?.path ?? '');
  const rest = path.startsWith(group) ? path.slice(group.length) || '/' : path;
  return (
    <>
      <span className={`fp-method fp-method-${method.toLowerCase()}`}>{method}</span>
      <span className={node.meta?.defined === false ? 'fp-missing' : undefined}>{rest}</span>
    </>
  );
}
