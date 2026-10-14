import * as path from 'path';
import { Worker } from 'worker_threads';
import type { MapGraph } from '../model/types';
import type { WorkerRequest, WorkerResponse } from '../shared/protocol';

export interface AnalysisResult {
  graph: MapGraph;
  ms: number;
}

/**
 * Runs the analyzer in a worker thread. Requests made while a run is in
 * flight are folded into a single follow-up run, so a burst of saves (an
 * agent writing ten files) costs at most one extra analysis.
 */
export class AnalysisService {
  private worker: Worker;
  private nextId = 1;
  private running?: Promise<AnalysisResult>;
  private queued?: Promise<AnalysisResult>;
  private pending = new Map<number, { resolve: (r: AnalysisResult) => void; reject: (e: Error) => void }>();

  constructor(extensionPath: string, private root: string) {
    this.worker = new Worker(path.join(extensionPath, 'dist', 'worker.js'));
    this.worker.on('message', (res: WorkerResponse) => {
      const waiter = this.pending.get(res.id);
      if (!waiter) return;
      this.pending.delete(res.id);
      if (res.type === 'graph') waiter.resolve({ graph: res.graph, ms: res.ms });
      else waiter.reject(new Error(res.message));
    });
    this.worker.on('error', (err) => {
      for (const waiter of this.pending.values()) waiter.reject(err);
      this.pending.clear();
    });
  }

  analyze(): Promise<AnalysisResult> {
    if (!this.running) {
      this.running = this.send().finally(() => (this.running = undefined));
      return this.running;
    }
    if (!this.queued) {
      this.queued = this.running.catch(() => undefined).then(() => {
        this.queued = undefined;
        return this.analyze();
      });
    }
    return this.queued;
  }

  private send(): Promise<AnalysisResult> {
    const id = this.nextId++;
    const req: WorkerRequest = { type: 'analyze', id, root: this.root };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(req);
    });
  }

  dispose(): void {
    void this.worker.terminate();
  }
}
