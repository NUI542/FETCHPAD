import { useSyncExternalStore } from 'react';
import type { CodeFile, HostMessage, WebviewMessage } from '../shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();
const listeners = new Set<(msg: HostMessage) => void>();
const waiting = new Map<number, { resolve: (code: CodeFile) => void; reject: (err: Error) => void }>();
const codeCache = new Map<string, Promise<CodeFile>>();
let nextRequest = 1;
let codeVersion = 0;
const versionListeners = new Set<() => void>();

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (msg.type === 'code') {
    const waiter = waiting.get(msg.requestId);
    waiting.delete(msg.requestId);
    if (msg.code) waiter?.resolve(msg.code);
    else waiter?.reject(new Error(msg.error ?? 'Could not read the file'));
    return;
  }
  if (msg.type === 'graph' || msg.type === 'themeChanged') {
    // Files or colours may have changed: previews fetch their code again.
    codeCache.clear();
    codeVersion++;
    for (const l of versionListeners) l();
  }
  for (const l of listeners) l(msg);
});

export function post(msg: WebviewMessage): void {
  api.postMessage(msg);
}

export function onHostMessage(listener: (msg: HostMessage) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function loadCode(file: string): Promise<CodeFile> {
  let pending = codeCache.get(file);
  if (!pending) {
    const requestId = nextRequest++;
    pending = new Promise<CodeFile>((resolve, reject) => waiting.set(requestId, { resolve, reject }));
    codeCache.set(file, pending);
    post({ type: 'code', requestId, file });
  }
  return pending;
}

/** Changes whenever cached code goes stale, so previews know to reload. */
export function useCodeVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      versionListeners.add(cb);
      return () => versionListeners.delete(cb);
    },
    () => codeVersion,
  );
}

export function loadState<T>(): Partial<T> {
  return (api.getState() as Partial<T> | undefined) ?? {};
}

export function saveState<T>(state: T): void {
  api.setState(state);
}
