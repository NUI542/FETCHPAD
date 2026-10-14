import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MapGraph, SourceRange } from '../model/types';
import type { AnalysisStats } from '../shared/protocol';
import { loadState, onHostMessage, post, saveState } from './host';
import { BackIcon, RefreshIcon, SidebarIcon } from './icons';
import { MapCanvas } from './MapCanvas';
import { Sidebar } from './Sidebar';
import { focusView, GraphIndex, overviewView } from './views';

interface Saved {
  current: string;
  history: string[];
  showReads: boolean;
  showHelpers: boolean;
  sidebar: boolean;
}

type Status = { state: 'analyzing' | 'idle' | 'error'; message?: string };

export function App() {
  const saved = useMemo(() => loadState<Saved>(), []);
  const [graph, setGraph] = useState<MapGraph>();
  const [stats, setStats] = useState<AnalysisStats>();
  const [status, setStatus] = useState<Status>({ state: 'analyzing' });
  const [current, setCurrent] = useState(saved.current ?? 'overview');
  const [history, setHistory] = useState<string[]>(saved.history ?? []);
  const [showReads, setShowReads] = useState(saved.showReads ?? false);
  const [showHelpers, setShowHelpers] = useState(saved.showHelpers ?? false);
  const [sidebar, setSidebar] = useState(saved.sidebar ?? true);

  const currentRef = useRef(current);
  currentRef.current = current;
  const go = useCallback((id: string) => {
    const from = currentRef.current;
    if (id === from) return;
    setHistory((h) => [...h.slice(-49), from]);
    setCurrent(id);
  }, []);

  useEffect(() => onHostMessage((msg) => {
    if (msg.type === 'graph') {
      setGraph(msg.graph);
      setStats(msg.stats);
    } else if (msg.type === 'status') {
      setStatus({ state: msg.state, message: msg.message });
    } else if (msg.type === 'focus') {
      go(msg.id);
    }
  }), [go]);
  useEffect(() => post({ type: 'ready' }), []);
  useEffect(() => saveState<Saved>({ current, history, showReads, showHelpers, sidebar }),
    [current, history, showReads, showHelpers, sidebar]);

  const index = useMemo(() => (graph ? new GraphIndex(graph) : undefined), [graph]);
  const view = useMemo(() => {
    if (!index) return undefined;
    const focused = current !== 'overview' ? focusView(index, current, { showHelpers }) : undefined;
    return focused ?? overviewView(index, { showReads });
  }, [index, current, showReads, showHelpers]);
  const back = () => {
    const prev = history[history.length - 1];
    if (prev === undefined) return;
    setHistory(history.slice(0, -1));
    setCurrent(prev);
  };
  const open = useCallback((range: SourceRange) => post({ type: 'open', range }), []);
  const isOverview = view?.key === 'overview';
  const focusNode = !isOverview && index ? index.node(current) : undefined;

  return (
    <ReactFlowProvider>
      <div className="fp-app">
        <header className="fp-toolbar">
          <button className="fp-icon-button" aria-label={sidebar ? 'Hide the sidebar' : 'Show the sidebar'}
            aria-pressed={sidebar} title="Sidebar" onClick={() => setSidebar(!sidebar)}>
            <SidebarIcon />
          </button>
          <button className="fp-icon-button" aria-label="Back" title="Back" disabled={!history.length} onClick={back}>
            <BackIcon />
          </button>
          <h1 className="fp-title">
            {isOverview ? 'Overview' : view?.title}
            {focusNode && <span className="fp-title-kind">{focusNode.kind === 'route' ? 'endpoint' : focusNode.layer}</span>}
          </h1>
          {view && (isOverview ? (
            <label className="fp-toggle" title="Also draw the tables each endpoint reads">
              <input type="checkbox" checked={showReads} onChange={(e) => setShowReads(e.target.checked)} /> Show reads
            </label>
          ) : (
            <label className="fp-toggle" title="Show functions that lead to no endpoint or table">
              <input type="checkbox" checked={showHelpers} onChange={(e) => setShowHelpers(e.target.checked)} /> Show helpers
            </label>
          ))}
          <span className={`fp-status is-${status.state}`} title={status.message} role="status">
            {statusText(status, stats, graph)}
          </span>
          <button className="fp-icon-button" aria-label="Analyze again" title="Analyze again"
            onClick={() => post({ type: 'refresh' })} disabled={status.state === 'analyzing'}>
            <RefreshIcon />
          </button>
        </header>
        <div className="fp-main">
          {sidebar && index && <Sidebar index={index} current={isOverview ? 'overview' : current} onSelect={go} onOpen={open} />}
          <main className="fp-canvas">
            {view && index ? (
              <MapCanvas view={view} index={index} onFocus={go} onOpen={open} />
            ) : (
              <div className="fp-empty">
                {status.state === 'error' ? `The analysis failed. ${status.message?.split('\n')[0] ?? ''}` : 'Analyzing the workspace…'}
              </div>
            )}
          </main>
        </div>
      </div>
    </ReactFlowProvider>
  );
}

function statusText(status: Status, stats: AnalysisStats | undefined, graph: MapGraph | undefined): string {
  if (status.state === 'error') return `Analysis failed: ${status.message?.split('\n')[0] ?? 'unknown error'}`;
  if (status.state === 'analyzing') return graph ? 'Updating…' : 'Analyzing…';
  if (!graph || !stats) return '';
  const endpoints = graph.nodes.filter((n) => n.kind === 'route' && n.meta?.defined !== false).length;
  const tables = graph.nodes.filter((n) => n.kind === 'table').length;
  const time = new Date(stats.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${endpoints} endpoints · ${tables} tables · updated ${time} in ${(stats.ms / 1000).toFixed(1)}s`;
}
