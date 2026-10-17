/** Bounded live smoke: two unrelated prompts; no production scene or device templates. */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SimulationController } from '../server/simulation-controller.js';
import { checkControllerParity } from '../server/controller-parity.js';
import type { SimulationRunEvent } from '../shared/simulation-run.js';

const root = path.resolve(process.env.PORTABLE_SMOKE_DIRECTORY ?? '.artifacts/live-hardware');
const projects = [
  {
    name: 'keyboard-car',
    goal: 'Build an interactive top-down keyboard-controlled differential-drive car and prepare its real hardware controller. ArrowUp requests forward motion at 1 metre/second; ArrowDown requests reverse at 1 metre/second; opposing up/down cancel. ArrowLeft requests counterclockwise rotation at 1 radian/second; ArrowRight clockwise at 1 radian/second; opposing left/right cancel. Releasing a key stops its requested translation or rotation; both can happen together. The initial position x,y and heading are zero. Use a simple continuous kinematic environment with no inertia, obstacles or randomness, and state its integration convention precisely. Show the car position and heading and wheel drive signals. The portable controller should produce each real motor driver direction and PWM enable output, using a differential drive with wheel separation 0.4 metres; PWM is 0..255. Model wheel drive magnitude from requested linear/angular velocity using a declared maximum wheel speed large enough for simultaneous turning. Use two external bidirectional motor driver channels and a separate motor power supply; keyboard commands come from the generated computer serial bridge. Physical position has no sensor and must be labeled simulated. Do not require a board yet.',
  },
  {
    name: 'thermostat',
    goal: 'Build an interactive thermostat simulation and its portable hardware controller. A conditioned analog temperature sensor is represented by a temperature slider in degrees Celsius from 0 to 50, initial 20; a serial computer setting sets threshold from 10 to 40 Celsius, initial 30. A fan relay starts off. Immediately turn it on when measured temperature is at least threshold plus 1 degree, off when at most threshold minus 1 degree, otherwise preserve the previous relay state (hysteresis). Changing either setting applies immediately while paused. Show measured temperature, threshold, relay state, and cumulative seconds spent on since reset; integrate on-time with dt only while the relay is on. The physical temperature is an external sensor input and the simulation slider holds it constant; do not add a thermal plant or autonomous temperature drift. Reset restores declared initial state. Require an externally powered fan and suitable transistor/relay driver with flyback protection. The analog module outputs a linear 0..reference-voltage signal corresponding to 0..50 Celsius. Do not require a board yet.',
  },
];
await mkdir(root, { recursive: true });
const selected = process.argv.slice(2);
await Promise.all(projects.filter(project => !selected.length || selected.includes(project.name)).map(async project => {
  const controller = new SimulationController({ directory: path.join(root, 'simulations'), deadlineMs: 360000 });
  const run = await controller.start({ prompt: project.goal });
  console.log(`${project.name}: ${run.id}`);
  controller.events.on(run.id, (event: SimulationRunEvent) => console.log(`${project.name} [${event.phase}] ${event.message}`));
  const result = await controller.wait(run.id);
  if (!result) throw new Error(`Missing run ${run.id}`);
  await writeFile(path.join(root, `${project.name}.json`), JSON.stringify(result, null, 2));
  let parity: unknown;
  if (result.candidate?.controller && result.spec) {
    try { parity = await checkControllerParity(result.candidate.controller, result.spec, result.scenarios ?? [], path.join(root, project.name, 'native-parity')); }
    catch (error) { parity = { passed: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  const summary = { name: project.name, id: result.id, status: result.status, portableController: !!result.candidate?.controller,
    attempts: result.attempts.length, checks: result.evidence?.results.flatMap(result => result.checks).length ?? 0,
    error: result.error, warning: result.warning, parity, physicalTested: false };
  await writeFile(path.join(root, `${project.name}-summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (result.status !== 'READY' || !result.candidate?.controller || !(parity as { passed?: boolean })?.passed) process.exitCode = 1;
}));
