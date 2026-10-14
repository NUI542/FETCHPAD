import { parentPort } from 'worker_threads';
import { Analyzer } from '../engine/analyze';
import type { WorkerRequest, WorkerResponse } from '../shared/protocol';

// Analysis runs here, off the extension host thread, so VS Code stays
// responsive. The Analyzer keeps parsed files between runs.
let analyzer: Analyzer | undefined;

parentPort?.on('message', (req: WorkerRequest) => {
  if (req.type !== 'analyze') return;
  let res: WorkerResponse;
  try {
    if (!analyzer || analyzer.root !== req.root) analyzer = new Analyzer(req.root);
    const started = Date.now();
    const graph = analyzer.run();
    res = { type: 'graph', id: req.id, graph, ms: Date.now() - started };
  } catch (err) {
    res = { type: 'error', id: req.id, message: err instanceof Error ? err.stack ?? err.message : String(err) };
  }
  parentPort?.postMessage(res);
});
