import { createContext, useContext } from 'react';
import type { SourceRange } from '../model/types';
import type { GraphIndex } from './views';

export interface MapActions {
  index: GraphIndex;
  focus(id: string): void;
  /** Open or close the code preview of `id`, pinned to block `anchor` (defaults to `id`). */
  toggleOverlay(id: string, anchor?: string): void;
  isOverlayOpen(id: string): boolean;
  closeOverlay(id: string): void;
  /** Bring a preview to the front. */
  touchOverlay(id: string): void;
  open(range: SourceRange): void;
}

export const ActionsContext = createContext<MapActions | null>(null);

export function useActions(): MapActions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error('useActions outside the map');
  return actions;
}

/** What hovering or selecting a block lights up. Empty `active` means nothing is lit. */
export interface Highlight {
  active?: string;
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

export const HighlightContext = createContext<Highlight>({ nodes: new Set(), edges: new Set() });
