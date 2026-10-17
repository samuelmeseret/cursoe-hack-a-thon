/** Retry only the live builder using the previously frozen, generated contract. */
import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SimulationController } from '../server/simulation-controller.js';
import { SimulationAgents } from '../server/simulation-agents.js';
import { checkControllerParity } from '../server/controller-parity.js';
import type { SimulationRun, SimulationRunEvent } from '../shared/simulation-run.js';
const root = path.resolve(process.env.PORTABLE_SMOKE_DIRECTORY ?? '.artifacts/live-hardware');
const name = process.argv[2] ?? 'keyboard-car';
if (!/^[a-z-]+$/.test(name)) throw new Error('Provide a smoke artifact name');
const previous = JSON.parse(await readFile(path.join(root, `${name}.json`), 'utf8')) as SimulationRun;
if (!previous.spec || !previous.scenarios?.length) throw new Error('A frozen live-generated specification and scenario suite are required');
let completion = 0;
const traceDirectory = path.join(root, name, 'provider-traces');
await mkdir(traceDirectory, { recursive: true });
const agents = new SimulationAgents({ fetch: async (url, options) => {
  const response = await fetch(url, options);
  if (String(url).endsWith('/chat/completions')) {
    const body = await response.clone().json() as { choices?: { message?: { content?: unknown } }[] };
    await writeFile(path.join(traceDirectory, `completion-${++completion}.json`), JSON.stringify(body.choices?.[0]?.message?.content ?? null, null, 2));
  }
  return response;
} });
const controller = new SimulationController({ directory: path.join(root, 'simulations'), agents: {
  model: agents.model,
  validateModel: signal => agents.validateModel(signal),
  specify: async () => structuredClone(previous.spec!),
  verify: async () => structuredClone(previous.scenarios!),
  build: (spec, scenarios, context, signal) => agents.build(spec, scenarios, context, signal),
} });
const run = await controller.start({ prompt: previous.prompt });
console.log(`${name}: retry live builder ${run.id}; frozen contract from ${previous.id}`);
controller.events.on(run.id, (event: SimulationRunEvent) => console.log(`${name} [${event.phase}] ${event.message}`));
const result = (await controller.wait(run.id))!;
await writeFile(path.join(root, `${name}.json`), JSON.stringify(result, null, 2));
let parity: unknown;
if (result.candidate?.controller && result.spec) {
  try { parity = await checkControllerParity(result.candidate.controller, result.spec, result.scenarios ?? [], path.join(root, name, 'native-parity')); }
  catch (error) { parity = { passed: false, error: error instanceof Error ? error.message : String(error) }; }
}
const summary = { name, id: result.id, frozenContractRevision: previous.id, status: result.status, portableController: !!result.candidate?.controller, attempts: result.attempts.length,
  checks: result.evidence?.results.flatMap(result => result.checks).length ?? 0, error: result.error, warning: result.warning, parity, physicalTested: false };
await writeFile(path.join(root, `${name}-summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (result.status !== 'READY' || !result.candidate?.controller || !(parity as { passed?: boolean })?.passed) process.exitCode = 1;
