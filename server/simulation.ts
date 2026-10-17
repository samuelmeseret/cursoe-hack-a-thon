import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import type { Circuit, Scenario, ScenarioResult } from '../shared/types';

/** Authoritative simulation is isolated so a wall deadline/cancellation can kill it. */
export function runSimulation(
  hex: string,
  circuit: Circuit,
  scenarios: Scenario[],
  { signal, timeoutMs = 60000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ScenarioResult[]> {
  return new Promise((resolveResults, reject) => {
    if (signal?.aborted) { reject(new Error('Simulation cancelled')); return; }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { reject(new Error('Simulation timeout')); return; }
    if (!scenarios.length) { reject(new Error('Cannot simulate an empty test suite')); return; }
    const worker = new Worker(resolve(process.cwd(), 'dist/server/sim-worker.js'), {
      workerData: { hex, circuit, scenarios },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    let finished = false;
    const finish = (error?: Error, results?: ScenarioResult[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      void worker.terminate();
      if (error) reject(error); else resolveResults(results!);
    };
    const cancel = () => finish(new Error('Simulation cancelled'));
    const timer = setTimeout(() => finish(new Error(`Simulation exceeded wall-clock timeout (${timeoutMs} ms)`)), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => { if (!finished) finish(new Error(`Simulator worker exited before producing evidence (code ${code})`)); });
    worker.on('message', (message: { type: string; results?: ScenarioResult[]; message?: string }) => {
      if (message.type === 'results' && Array.isArray(message.results)) {
        const results = message.results;
        if (results.length !== scenarios.length || results.some((result, index) => result.scenarioId !== scenarios[index].id || result.checks.length !== scenarios[index].assertions.length)) {
          finish(new Error('Simulator returned incomplete expected-check evidence'));
        } else finish(undefined, results);
      } else finish(new Error(message.message ?? 'Malformed simulator worker response'));
    });
  });
}
