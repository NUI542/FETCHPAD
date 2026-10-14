import {
  Background, Controls, MarkerType, MiniMap, Panel, ReactFlow, useNodesState, useReactFlow, useStoreApi,
  type Edge, type EdgeMouseHandler, type Node, type NodeMouseHandler, type OnNodeDrag,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EdgeKind, SourceRange } from '../model/types';
import { ActionsContext, HighlightContext, type Highlight, type MapActions } from './context';
import { LeaderEdge, RoutedEdge, type RoutedEdgeData } from './edges';
import { layoutView, type Box, type Layout } from './layout';
import { BlockNode, ColumnNode, OverlayNode } from './nodes';
import type { GraphIndex, ViewEdge, ViewModel } from './views';

const OVERLAY_WIDTH = 560;
const OVERLAY_MAX_HEIGHT = 420;
const NODE_TYPES = { block: BlockNode, column: ColumnNode, overlay: OverlayNode };
const EDGE_TYPES = { routed: RoutedEdge, leader: LeaderEdge };
const EDGE_COLOUR: Record<EdgeKind, string> = {
  calls: 'var(--fp-edge-calls)', handles: 'var(--fp-edge-calls)', middleware: 'var(--fp-edge-calls)',
  references: 'var(--fp-edge-calls)', renders: 'var(--fp-edge-renders)', requests: 'var(--fp-edge-requests)',
  reads: 'var(--fp-edge-reads)', writes: 'var(--fp-edge-writes)',
};

interface Overlay {
  /** Node whose code is shown. */
  id: string;
  /** Block the preview is pinned to. */
  anchor: string;
  dx: number;
  dy: number;
  z: number;
}

interface Props {
  view: ViewModel;
  index: GraphIndex;
  onFocus(id: string): void;
  onOpen(range: SourceRange): void;
}

export function MapCanvas({ view, index, onFocus, onOpen }: Props) {
  const [laid, setLaid] = useState<{ view: ViewModel; layout: Layout }>();
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [hover, setHover] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [zoomedIn, setZoomedIn] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const { fitView, setCenter, setViewport } = useReactFlow();
  const store = useStoreApi();
  const fittedKey = useRef<string>();
  const zTop = useRef(1);

  useEffect(() => {
    let live = true;
    layoutView(view).then(
      (layout) => live && setLaid({ view, layout }),
      (err) => console.error('Layout failed', err),
    );
    return () => {
      live = false;
    };
  }, [view]);

  // Previews and selection only survive while their block is still on the map.
  useEffect(() => {
    if (!laid) return;
    setOverlays((list) => (list.every((o) => laid.layout.nodes.has(o.anchor)) ? list : list.filter((o) => laid.layout.nodes.has(o.anchor))));
    setSelected((s) => (s && laid.layout.nodes.has(s) ? s : undefined));
  }, [laid]);

  const built = useMemo(() => (laid ? buildNodes(laid.view, laid.layout, overlays) : []), [laid, overlays]);
  useEffect(() => {
    // React Flow drops a node's handle positions (and so its edges) when the
    // node arrives without its measured size, so carry the size over.
    setNodes((prev) => {
      const measured = new Map(prev.map((n) => [n.id, n.measured]));
      return built.map((n) => {
        const m = measured.get(n.id);
        return m ? { ...n, measured: m } : n;
      });
    });
  }, [built, setNodes]);

  // Choose the viewport when a different view opens; a re-analysis of the same view keeps it.
  useEffect(() => {
    if (!laid || fittedKey.current === laid.layout.key) return;
    fittedKey.current = laid.layout.key;
    const timer = setTimeout(() => {
      const { width, height } = store.getState();
      const target = initialViewport(laid.view, laid.layout, width, height);
      if (target.kind === 'fit') void fitView({ padding: 0.06, maxZoom: 1, duration: 200 });
      else if (target.kind === 'center') void setCenter(target.x, target.y, { zoom: target.zoom, duration: 200 });
      else void setViewport({ x: target.x, y: target.y, zoom: target.zoom }, { duration: 200 });
    }, 30);
    return () => clearTimeout(timer);
  }, [laid, fitView, setCenter, setViewport, store]);

  const edges = useMemo<Edge[]>(() => {
    if (!laid) return [];
    const out: Edge[] = laid.view.edges.map((e): RoutedEdgeData => ({
      id: e.id,
      source: e.from,
      target: e.to,
      type: 'routed',
      selectable: false,
      focusable: false,
      data: { view: e, points: laid.layout.edges.get(e.id), tip: tipFor(e, index) },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: EDGE_COLOUR[e.kind] },
    }));
    for (const o of overlays) {
      out.push({ id: `leader:${o.id}`, source: o.anchor, target: `overlay:${o.id}`, type: 'leader', selectable: false, focusable: false });
    }
    return out;
  }, [laid, overlays, index]);

  const active = selected ?? hover;
  const highlight = useMemo<Highlight>(() => {
    if (!active || !laid) return { nodes: new Set(), edges: new Set() };
    const lit = new Set([active]);
    const litEdges = new Set<string>();
    for (const e of laid.view.edges) {
      if (e.from !== active && e.to !== active) continue;
      litEdges.add(e.id);
      lit.add(e.from);
      lit.add(e.to);
    }
    return { active, nodes: lit, edges: litEdges };
  }, [active, laid]);

  const toggleOverlay = useCallback((id: string, anchor = id) => {
    setOverlays((list) => {
      if (list.some((o) => o.id === id)) return list.filter((o) => o.id !== id);
      const box = laid?.layout.nodes.get(anchor);
      if (!laid || !box) return list;
      const heightOf = (nodeId: string) => previewHeight(index, nodeId);
      return [...list, { id, anchor, ...freeSpot(box, laid.layout, list, heightOf(id), heightOf), z: zTop.current++ }];
    });
  }, [laid, index]);

  const actions = useMemo<MapActions>(() => ({
    index,
    focus: onFocus,
    toggleOverlay,
    isOverlayOpen: (id) => overlays.some((o) => o.id === id),
    closeOverlay: (id) => setOverlays((list) => list.filter((o) => o.id !== id)),
    touchOverlay: (id) => setOverlays((list) => {
      const top = Math.max(...list.map((o) => o.z));
      return list.map((o) => (o.id === id && o.z !== top ? { ...o, z: zTop.current++ } : o));
    }),
    open: onOpen,
  }), [index, onFocus, toggleOverlay, overlays, onOpen]);

  // Escape closes the preview touched last.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !overlays.length) return;
      const top = overlays.reduce((a, b) => (b.z > a.z ? b : a));
      setOverlays((list) => list.filter((o) => o.id !== top.id));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlays]);

  const onNodeMouseEnter: NodeMouseHandler = (_, n) => n.type === 'block' && setHover(n.id);
  const onNodeMouseLeave: NodeMouseHandler = (_, n) => n.type === 'block' && setHover(undefined);
  const onNodeClick: NodeMouseHandler = (_, n) => n.type === 'block' && setSelected((s) => (s === n.id ? undefined : n.id));
  const onNodeDoubleClick: NodeMouseHandler = (_, n) => {
    const range = n.type === 'block' ? index.node(n.id)?.ranges[0] : undefined;
    if (range) onOpen(range);
  };
  const onEdgeClick: EdgeMouseHandler = (_, e) => {
    const evidence = (e.data as RoutedEdgeData['data'])?.view.edge?.evidence;
    if (evidence) onOpen(evidence);
  };
  const onNodeDragStop: OnNodeDrag = (_, n) => {
    if (n.type !== 'overlay' || !laid) return;
    const id = (n.data as { nodeId: string }).nodeId;
    setOverlays((list) => list.map((o) => {
      const box = laid.layout.nodes.get(o.anchor);
      return o.id === id && box ? { ...o, dx: n.position.x - box.x, dy: n.position.y - box.y } : o;
    }));
  };

  return (
    <ActionsContext.Provider value={actions}>
      <HighlightContext.Provider value={highlight}>
        <ReactFlow
          className={zoomedIn ? 'fp-zoomed-in' : undefined}
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeDragStop={onNodeDragStop}
          onEdgeClick={onEdgeClick}
          onPaneClick={() => setSelected(undefined)}
          onMove={(_, vp) => setZoomedIn(vp.zoom >= 0.75)}
          nodesConnectable={false}
          zoomOnDoubleClick={false}
          // Scroll moves the map like a document; Ctrl+scroll or a pinch zooms.
          panOnScroll
          zoomOnScroll={false}
          minZoom={0.05}
          maxZoom={2}
          attributionPosition="top-right"
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeClassName={miniMapClass} />
          <Panel position="bottom-left" className="fp-legend">
            <Key kind="requests" label="request" />
            <Key kind="calls" label="call" />
            <Key kind="renders" label="renders" />
            <Key kind="writes" label="writes" />
            <Key kind="reads" label="reads" />
            <Key kind="unresolved" label="not proven" />
          </Panel>
          {laid && laid.view.nodes.length === 0 && (
            <Panel position="top-center" className="fp-empty-panel">
              Nothing to show. Fetchpad currently understands Express, React Router, fetch/axios and SQL.
            </Panel>
          )}
        </ReactFlow>
      </HighlightContext.Provider>
    </ActionsContext.Provider>
  );
}

function Key({ kind, label }: { kind: string; label: string }) {
  return (
    <span className="fp-key">
      <svg width="22" height="8" aria-hidden><line className={`fp-key-line fp-key-${kind}`} x1="0" y1="4" x2="22" y2="4" /></svg>
      {label}
    </span>
  );
}

function buildNodes(view: ViewModel, layout: Layout, overlays: Overlay[]): Node[] {
  const out: Node[] = layout.columns.map((c, i) => ({
    id: `column:${i}`,
    type: 'column',
    position: { x: c.x, y: c.y },
    data: { title: c.title, width: c.width },
    draggable: false,
    selectable: false,
    focusable: false,
  }));
  for (const v of view.nodes) {
    const box = layout.nodes.get(v.id);
    if (!box) continue;
    out.push({
      id: v.id,
      type: 'block',
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      data: { view: v },
      draggable: false,
      connectable: false,
    });
  }
  for (const o of overlays) {
    const box = layout.nodes.get(o.anchor);
    if (!box) continue;
    out.push({
      id: `overlay:${o.id}`,
      type: 'overlay',
      position: { x: box.x + o.dx, y: box.y + o.dy },
      data: { nodeId: o.id },
      dragHandle: '.fp-overlay-drag',
      zIndex: 1000 + o.z,
      selectable: false,
      connectable: false,
    });
  }
  return out;
}

type Viewport =
  | { kind: 'fit' }
  | { kind: 'center'; x: number; y: number; zoom: number }
  | { kind: 'top'; x: number; y: number; zoom: number };

const READABLE_ZOOM = 0.6;
const FALLBACK_ZOOM = 0.8;
const PAD = 24;

/**
 * Fit the whole view when its text stays readable. Otherwise keep a
 * readable zoom: centre on the focused block, or for the overview start at
 * the top so it reads like a document.
 */
function initialViewport(view: ViewModel, layout: Layout, width: number, height: number): Viewport {
  const boxes = [...layout.nodes.values(), ...layout.columns.map((c) => ({ x: c.x, y: c.y, width: c.width, height: 30 }))];
  if (!boxes.length || !width || !height) return { kind: 'fit' };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  const fit = Math.min((width - 2 * PAD) / (maxX - minX), (height - 2 * PAD) / (maxY - minY));
  if (fit >= READABLE_ZOOM) return { kind: 'fit' };

  const focus = view.nodes.find((n) => n.focus);
  const box = focus && layout.nodes.get(focus.id);
  if (box) return { kind: 'center', x: box.x + box.width / 2, y: box.y + box.height / 2, zoom: FALLBACK_ZOOM };

  const zoom = Math.max(READABLE_ZOOM, Math.min(1, (width - 2 * PAD) / (maxX - minX)));
  const spare = Math.max(0, width - (maxX - minX) * zoom) / 2;
  return { kind: 'top', x: PAD + spare - minX * zoom, y: PAD - minY * zoom, zoom };
}

/** Rough rendered height of a preview: header, the block's lines (scrolling past a cap) and two fold bars. */
function previewHeight(index: GraphIndex, id: string): number {
  const r = index.node(id)?.ranges[0];
  const lines = r ? r.endLine - r.startLine + 1 : 10;
  return Math.min(OVERLAY_MAX_HEIGHT, 34 + lines * 19.5 + 44);
}

/**
 * Where a new preview covers the least: right of its block, below, left,
 * then above. Free space wins outright; otherwise the smallest overlap.
 */
function freeSpot(anchor: Box, layout: Layout, overlays: Overlay[], height: number, heightOf: (id: string) => number): { dx: number; dy: number } {
  const taken: Box[] = [...layout.nodes.values()].filter((b) => b !== anchor);
  for (const o of overlays) {
    const a = layout.nodes.get(o.anchor);
    if (a) taken.push({ x: a.x + o.dx, y: a.y + o.dy, width: OVERLAY_WIDTH, height: heightOf(o.id) });
  }
  const candidates = [
    { dx: anchor.width + 40, dy: 0 },
    { dx: 0, dy: anchor.height + 30 },
    { dx: -OVERLAY_WIDTH - 40, dy: 0 },
    { dx: 0, dy: -height - 30 },
  ];
  const covered = (b: Box) => taken.reduce((sum, t) => {
    const w = Math.min(b.x + b.width, t.x + t.width) - Math.max(b.x, t.x);
    const h = Math.min(b.y + b.height, t.y + t.height) - Math.max(b.y, t.y);
    return w > 0 && h > 0 ? sum + w * h : sum;
  }, 0);
  let best = candidates[0];
  let bestArea = Infinity;
  for (const c of candidates) {
    const area = covered({ x: anchor.x + c.dx, y: anchor.y + c.dy, width: OVERLAY_WIDTH, height });
    if (area === 0) return c;
    if (area < bestArea) {
      best = c;
      bestArea = area;
    }
  }
  return best;
}

const VERB: Record<EdgeKind, string> = {
  calls: 'calls', renders: 'renders', requests: 'requests', handles: 'is handled by',
  middleware: 'runs', reads: 'reads', writes: 'writes', references: 'references',
};

function tipFor(e: ViewEdge, index: GraphIndex): string {
  const name = (id: string) => index.node(id)?.name ?? id;
  const lines = [`${name(e.from)} ${VERB[e.kind]} ${name(e.to)}`];
  if (e.edge) {
    const at = `${e.edge.evidence.file}:${e.edge.evidence.startLine}`;
    lines.push(`${at}${e.edge.label ? ` · ${e.edge.label}` : ''} · click to open`);
    if (e.edge.note) lines.push(e.edge.note);
  }
  if (e.via?.length) lines.push(`via ${e.via.map(name).join(' → ')}`);
  if (!e.resolved) lines.push('Not proven from the code alone');
  return lines.join('\n');
}

function miniMapClass(n: Node): string {
  if (n.type !== 'block') return 'fp-mini-hidden';
  const layer = (n.data as { view: { node: { layer?: string } } }).view.node.layer;
  return `fp-mini fp-mini-${layer}`;
}
