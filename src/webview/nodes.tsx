import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { useContext, useEffect, useState, type MouseEvent } from 'react';
import type { MapNode } from '../model/types';
import type { CodeFile } from '../shared/protocol';
import { CodeView } from './CodeView';
import { HighlightContext, useActions } from './context';
import { loadCode, useCodeVersion } from './host';
import { MinusIcon, OpenIcon, PlusIcon, TargetIcon } from './icons';
import { BLOCK_WIDTH, blockHeight } from './layout';
import type { ViewNode } from './views';

export type BlockNodeData = Node<{ view: ViewNode }, 'block'>;
export type ColumnNodeData = Node<{ title: string; width: number }, 'column'>;
export type OverlayNodeData = Node<{ nodeId: string }, 'overlay'>;

const KIND_LABEL: Record<string, string> = {
  page: 'Page', ui: 'Component', client: 'API client', route: 'Endpoint', handler: 'Handler',
  middleware: 'Middleware', service: 'Logic', data: 'Data access', table: 'Table', test: 'Test', other: 'Function',
};

const stop = (fn: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn();
};
const noDouble = (e: MouseEvent) => e.stopPropagation();

export function BlockNode({ data }: NodeProps<BlockNodeData>) {
  const v = data.view;
  const n = v.node;
  const actions = useActions();
  const hl = useContext(HighlightContext);
  const open = actions.isOverlayOpen(v.id);
  const lit = hl.active ? (hl.nodes.has(v.id) ? 'is-lit' : 'is-dim') : '';
  const missing = n.kind === 'route' && n.meta?.defined === false;
  const unknownTable = n.kind === 'table' && n.meta?.inSchema === false;
  const classes = ['fp-block', `fp-layer-${n.layer}`, lit, v.focus && 'is-focus', open && 'has-overlay',
    (missing || unknownTable) && 'is-warning'].filter(Boolean).join(' ');

  return (
    <div className={classes} style={{ width: BLOCK_WIDTH, height: blockHeight(v) }}>
      <Handle type="target" position={Position.Left} className="fp-handle" isConnectable={false} />
      <div className="fp-block-head">
        <span className="fp-kind">{n.kind === 'page' && n.meta?.layout ? 'Layout' : KIND_LABEL[n.layer ?? 'other']}</span>
        <span className="fp-actions">
          {!v.focus && (
            <button title="Focus the map on this" aria-label={`Focus the map on ${n.name}`}
              onClick={stop(() => actions.focus(v.id))} onDoubleClick={noDouble}>
              <TargetIcon />
            </button>
          )}
          {n.ranges.length > 0 && (
            <button className={open ? 'is-on' : ''} aria-pressed={open} title={open ? 'Close code preview' : 'Preview code'}
              aria-label={`${open ? 'Close code preview for' : 'Preview code for'} ${n.name}`}
              onClick={stop(() => actions.toggleOverlay(v.id))} onDoubleClick={noDouble}>
              {open ? <MinusIcon /> : <PlusIcon />}
            </button>
          )}
        </span>
      </div>
      <div className="fp-block-name" title={n.name}>{n.kind === 'route' ? <RouteName node={n} /> : n.name}</div>
      <div className="fp-block-sub" title={subtitle(v)}>{subtitle(v)}</div>
      {v.chips.length > 0 && (
        <div className="fp-chips">
          {v.chips.map((c) => (
            <button key={c.label} className={`fp-chip${c.fn && actions.isOverlayOpen(c.fn) ? ' is-on' : ''}`}
              title={`Middleware: ${c.label}. Click to preview its code.`}
              aria-label={`Preview code for middleware ${c.label}`}
              onClick={stop(() => c.fn && actions.toggleOverlay(c.fn, v.id))} onDoubleClick={noDouble}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="fp-handle" isConnectable={false} />
    </div>
  );
}

function RouteName({ node }: { node: MapNode }) {
  const method = String(node.meta?.method ?? '');
  const path = String(node.meta?.path ?? node.name);
  return (
    <>
      <span className={`fp-method fp-method-${method.toLowerCase()}`}>{method}</span> {path}
    </>
  );
}

function subtitle(v: ViewNode): string {
  const n = v.node;
  const helpers = v.helpers ? ` · +${v.helpers} helper${v.helpers === 1 ? '' : 's'}` : '';
  const at = n.ranges[0] ? `${n.ranges[0].file.split('/').pop()}:${n.ranges[0].startLine}` : '';
  switch (n.kind) {
    case 'route':
      if (n.meta?.defined === false) return 'No matching server route';
      return at + (v.libraryMiddleware.length ? ` · ${v.libraryMiddleware.length} library middleware` : '') + helpers;
    case 'table': {
      if (n.meta?.inSchema === false) return 'Not defined in any .sql file';
      const cols = (n.meta?.columns as string[] | undefined)?.length ?? 0;
      return `${cols} column${cols === 1 ? '' : 's'}`;
    }
    case 'page':
      return ((n.meta?.components as string[] | undefined) ?? []).join(' › ') || at;
    default:
      return at + helpers;
  }
}

export function ColumnNode({ data }: NodeProps<ColumnNodeData>) {
  return <div className="fp-column-title" style={{ width: data.width }}>{data.title}</div>;
}

export function OverlayNode({ data }: NodeProps<OverlayNodeData>) {
  const actions = useActions();
  const node = actions.index.node(data.nodeId);
  const range = node?.ranges[0];
  const version = useCodeVersion();
  const [code, setCode] = useState<CodeFile>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!range) return;
    let live = true;
    setError(undefined);
    loadCode(range.file).then(
      (c) => live && setCode(c),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [range?.file, version]);

  const name = node?.name ?? data.nodeId;
  // Use the editor colours of the theme the code was highlighted with.
  const colours = code?.background ? { ['--fp-code-bg' as string]: code.background, ['--fp-code-fg' as string]: code.foreground } : undefined;
  return (
    <div className="fp-overlay" style={colours} onMouseDownCapture={() => actions.touchOverlay(data.nodeId)}>
      <Handle type="target" position={Position.Left} className="fp-handle" isConnectable={false} />
      <div className="fp-overlay-head fp-overlay-drag">
        <span className="fp-overlay-file">{range?.file.split('/').pop()}</span>
        <span className="fp-overlay-name" title={name}>{name}</span>
        {range && (
          <button title="Open in the editor" aria-label={`Open ${name} in the editor`} onClick={() => actions.open(range)}>
            <OpenIcon />
          </button>
        )}
        <button className="is-on" title="Close" aria-label={`Close code preview for ${name}`}
          onClick={() => actions.closeOverlay(data.nodeId)}>
          <MinusIcon />
        </button>
      </div>
      <div className="fp-overlay-body nowheel nodrag nopan" onDoubleClick={() => range && actions.open(range)}
        title="Double-click to open in the editor">
        {!node || !range ? <div className="fp-overlay-msg">This block is no longer in the code.</div>
          : error ? <div className="fp-overlay-msg">{error}</div>
          : !code ? <div className="fp-overlay-msg">Loading…</div>
          : <CodeView code={code} range={range} />}
      </div>
    </div>
  );
}
