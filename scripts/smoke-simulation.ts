import type { SimulationRun } from '../shared/simulation-run';
import { simulationTerminal } from '../shared/simulation-run';

const args = process.argv.slice(2);
const previousIndex = args.indexOf('--previous');
const previousId = previousIndex >= 0 ? args[previousIndex + 1] : undefined;
if (previousIndex >= 0) args.splice(previousIndex, 2);
const prompt = args.join(' ').trim();
if (prompt.length < 5) throw new Error('Usage: npm run demo:simulation -- "Describe your simulation" [--previous simulation-id]');
const base = process.env.API_URL || 'http://127.0.0.1:3001';
const response = await fetch(`${base}/api/simulations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, previousId }) });
const initial = await response.json() as SimulationRun & { error?: string };
if (!response.ok) throw new Error(initial.error || `HTTP ${response.status}`);
console.log(`Simulation ${initial.id}\nOpen http://127.0.0.1:5173/?simulation=${initial.id}`);
let after = 0;
while (true) {
  const current = await fetch(`${base}/api/simulations/${initial.id}`);
  if (!current.ok) throw new Error(`Could not read simulation (${current.status}).`);
  const run = await current.json() as SimulationRun;
  for (const event of run.events.filter(event => event.sequence > after)) console.log(`${event.sequence}. [${event.phase}] ${event.message}`);
  after = run.events.length;
  if (simulationTerminal(run.status)) {
    console.log(JSON.stringify({ id: run.id, status: run.status, attempts: run.attempts.length, checks: run.evidence?.results.reduce((count, result) => count + result.checks.length, 0), error: run.error, warning: run.warning }, null, 2));
    if (run.status !== 'READY') process.exitCode = 1;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 2000));
}
