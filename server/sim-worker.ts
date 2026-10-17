import { parentPort, workerData } from 'node:worker_threads';
import { runScenario } from '../shared/simulator';
import type { Circuit, Scenario } from '../shared/types';

const { hex, circuit, scenarios } = workerData as { hex: string; circuit: Circuit; scenarios: Scenario[] };
try {
  const results = scenarios.map((scenario) => runScenario(hex, circuit, scenario));
  parentPort?.postMessage({ type: 'results', results });
} catch (error) {
  parentPort?.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
}
