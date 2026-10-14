/** Workspace-relative location of a piece of source. Lines and columns are 1-based. */
export interface SourceRange {
  file: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export type NodeKind =
  | 'file'
  | 'function'
  | 'component'
  | 'page'
  | 'route'
  | 'table'
  | 'column';

/**
 * Column a node sits in on the feature map. Derived from the node's role in
 * the graph (what it calls and what calls it), never from folder names.
 */
export type Layer =
  | 'page'
  | 'ui'
  | 'client'
  | 'route'
  | 'middleware'
  | 'handler'
  | 'service'
  | 'data'
  | 'table'
  | 'test'
  | 'other';

export interface MapNode {
  /** Stable ID, e.g. `js:Backend/src/models/taskModel.js#insertTask:function`. */
  id: string;
  kind: NodeKind;
  name: string;
  /** Containment: file > function, table > column. */
  parent?: string;
  ranges: SourceRange[];
  lang: string;
  layer?: Layer;
  /** Kind-specific facts, e.g. a route's method, path and middleware chain. */
  meta?: Record<string, unknown>;
}

export type EdgeKind =
  | 'calls'
  | 'renders'
  | 'requests'
  | 'handles'
  | 'middleware'
  | 'reads'
  | 'writes'
  | 'references';

export interface MapEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** The exact code that proves the edge. */
  evidence: SourceRange;
  /** false = could not be proven statically; drawn dashed, never guessed. */
  resolved: boolean;
  label?: string;
  /** Assumption the edge depends on, e.g. which env-var fallback was used. */
  note?: string;
}

/** Something the analyzer saw but could not turn into a resolved edge. */
export interface Gap {
  kind: 'unmatched-request' | 'dynamic-sql' | 'duplicate-route' | 'unmounted-router' | 'unknown-table';
  message: string;
  evidence: SourceRange;
}

export interface MapGraph {
  root: string;
  nodes: MapNode[];
  edges: MapEdge[];
  gaps: Gap[];
}
