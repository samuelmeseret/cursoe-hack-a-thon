/** Give a live draft an independent verifier pass without rewriting its controller. */
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SimulationController } from '../server/simulation-controller.js';
import { SimulationAgents } from '../server/simulation-agents.js';
import { checkControllerParity } from '../server/controller-parity.js';
import type { SimulationRun, SimulationRunEvent } from '../shared/simulation-run.js';
const root = path.resolve(process.env.PORTABLE_SMOKE_DIRECTORY ?? '.artifacts/live-hardware');
const name = process.argv[2] ?? 'thermostat';
if (!/^[a-z-]+$/.test(name)) throw new Error('Provide a smoke artifact name');
const previous = JSON.parse(await readFile(path.join(root, `${name}.json`), 'utf8')) as SimulationRun;
if (!previous.spec || !previous.candidate?.controller || previous.scenarios?.length) throw new Error('A live portable draft with no frozen acceptance suite is required');
const agents = new SimulationAgents();
const controller = new SimulationController({ directory: path.join(root, 'simulations'), agents: {
  model: agents.model, validateModel: signal => agents.validateModel(signal),
  specify: async () => structuredClone(previous.spec!),
  verify: (spec, signal) => agents.verify(spec, signal), // receives no implementation
  build: async (_spec, _scenarios, context) => {
    if (context.attempt > 1) throw new Error('The unchanged live draft failed its new independent checks; no automatic weakening or source rewrite in this recheck.');
    return structuredClone(previous.candidate!);
  },
} });
const run = await controller.start({ prompt: previous.prompt });
console.log(`${name}: independent recheck ${run.id}; unchanged candidate from ${previous.id}`);
controller.events.on(run.id, (event: SimulationRunEvent) => console.log(`${name} [${event.phase}] ${event.message}`));
const result = (await controller.wait(run.id))!;
await writeFile(path.join(root, `${name}.json`), JSON.stringify(result, null, 2));
let parity: unknown;
if (result.candidate?.controller && result.spec) {
  try { parity = await checkControllerParity(result.candidate.controller, result.spec, result.scenarios ?? [], path.join(root, name, 'native-parity')); }
  catch (error) { parity = { passed: false, error: error instanceof Error ? error.message : String(error) }; }
}
const summary = { name, id: result.id, candidateRevision: previous.id, status: result.status, portableController: !!result.candidate?.controller, attempts: result.attempts.length,
  checks: result.evidence?.results.flatMap(result => result.checks).length ?? 0, error: result.error, warning: result.warning, parity, physicalTested: false };
await writeFile(path.join(root, `${name}-summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (result.status !== 'READY' || !result.candidate?.controller || !(parity as { passed?: boolean })?.passed) process.exitCode = 1;
