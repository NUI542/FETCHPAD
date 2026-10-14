import type { MapGraph, SourceRange } from '../model/types';

/** One highlighted run of text. `fontStyle` is a bit set: 1 italic, 2 bold, 4 underline. */
export interface CodeToken {
  text: string;
  color?: string;
  fontStyle?: number;
}

export interface CodeFile {
  file: string;
  lang: string;
  lines: CodeToken[][];
  /** Editor colours of the theme the tokens were coloured with. */
  background?: string;
  foreground?: string;
}

export interface AnalysisStats {
  ms: number;
  /** Epoch milliseconds of the run. */
  at: number;
}

/** Extension host → map webview. */
export type HostMessage =
  | { type: 'graph'; graph: MapGraph; stats: AnalysisStats }
  | { type: 'status'; state: 'analyzing' | 'idle' | 'error'; message?: string }
  | { type: 'code'; requestId: number; code?: CodeFile; error?: string }
  | { type: 'themeChanged' }
  /** Show the map focused on this node (picked in the sidebar). */
  | { type: 'focus'; id: string };

/** Map webview → extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'open'; range: SourceRange }
  | { type: 'code'; requestId: number; file: string };

/** Extension host ↔ analysis worker. */
export type WorkerRequest = { type: 'analyze'; id: number; root: string };
export type WorkerResponse =
  | { type: 'graph'; id: number; graph: MapGraph; ms: number }
  | { type: 'error'; id: number; message: string };
