/** Build and download a previously live-generated project, then compile the extracted ZIP independently. */
import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SimulationController } from '../server/simulation-controller.js';
import { HardwareProjectService } from '../server/hardware-project.js';
import { hardwareProjectRoutes } from '../server/hardware-routes.js';
import { getDeviceProfile, hardwareEnvironment } from '../server/hardware-adapters.js';
import type { HardwareBinding, HardwareConfiguration } from '../shared/hardware-project.js';
import type { SimulationRun } from '../shared/simulation-run.js';

const root = path.resolve(process.env.PORTABLE_SMOKE_DIRECTORY ?? '.artifacts/live-hardware');
const name = process.argv[2] ?? 'keyboard-car', fqbn = process.argv[3] ?? 'arduino:avr:uno';
if (!/^[a-z-]+$/.test(name)) throw new Error('Provide a smoke artifact name');
const input = JSON.parse(await readFile(path.join(root, `${name}.json`), 'utf8')) as SimulationRun;
const simulations = new SimulationController({ directory: path.join(root, 'simulations') });
const run = await simulations.get(input.id);
if (!run?.candidate?.controller || !['READY', 'DRAFT'].includes(run.status)) throw new Error(`Run ${input.id} is not a current portable candidate (${run?.status})`);
const profile = await getDeviceProfile(fqbn, { install: true });
const usedPins = new Set<number>();
const bindings: HardwareBinding[] = [];
for (const direction of ['input', 'output'] as const) {
  for (const signal of direction === 'input' ? run.candidate.controller.inputs : run.candidate.controller.outputs) {
    const kind = signal.hardware.kind;
    let pin: string | undefined;
    if (kind !== 'serial') {
      const preferences = kind === 'pwm-output' ? [5, 6, 9, 10, 11, 3] : kind === 'analog-input' ? [14, 15, 16, 17, 18, 19] : [7, 8, 2, 4, 12, 13];
      const available = profile.pins.filter(pin => !pin.reserved && !usedPins.has(pin.number) && (kind === 'pwm-output' ? pin.pwm : kind === 'analog-input' ? pin.analog : pin.digital));
      const selected = preferences.map(number => available.find(pin => pin.number === number)).find(Boolean) ?? available[0];
      if (!selected) throw new Error(`No compatible unallocated pin for ${signal.id}`);
      usedPins.add(selected.number); pin = selected.id;
    }
    bindings.push({ signalId: signal.id, direction, kind, ...(pin ? { pin } : {}), component: signal.hardware.component ?? (kind === 'serial' ? 'Computer USB serial connection' : signal.label),
      ...(signal.hardware.description ? { notes: signal.hardware.description } : {}),
      ...(kind === 'analog-input' ? { minimum: signal.hardware.min ?? 0, maximum: signal.hardware.max ?? 1023 } : {}),
    });
  }
}
const configuration: HardwareConfiguration = { fqbn, bindings, libraries: [], baudRate: 115200, serialTimeoutMs: 500 };
const hardware = new HardwareProjectService(simulations, { directory: path.join(root, 'hardware-projects') });
const app = express(); app.use(express.json()); app.use('/api/simulations', hardwareProjectRoutes(hardware));
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/simulations/${run.id}`;
function execute(executable: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: hardwareEnvironment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', chunk => { log = (log + chunk).slice(-200000); });
    child.stderr.on('data', chunk => { log = (log + chunk).slice(-200000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Command timed out: ${log}`)); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(log) : reject(new Error(`Command failed (${code}): ${log}`)); });
  });
}
try {
  const configure = await fetch(`${base}/hardware`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(configuration) });
  const configured = await configure.json();
  if (!configure.ok || configured.issues?.length) throw new Error(JSON.stringify(configured));
  console.log(`${name}: configured ${fqbn}; ${JSON.stringify(bindings.map(binding => ({ signal: binding.signalId, interface: binding.kind, pin: binding.pin ?? 'USB serial' })))}`);
  const response = await fetch(`${base}/hardware/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error(await response.text());
  const built = await hardware.wait(run.id);
  if (built.status !== 'COMPILED') throw new Error(built.error ?? built.log ?? 'Build failed');
  console.log(`${name}: selected-target compilation complete; simulation checked=${built.evidence?.simulationChecked}; downloading ZIP`);
  const downloaded = await fetch(`${base}/hardware/export`);
  if (!downloaded.ok) throw new Error(await downloaded.text());
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  const zipPath = path.join(root, `${name}-hardware.zip`);
  await writeFile(zipPath, bytes);
  const extracted = path.join(root, `${name}-extracted-${randomUUID()}`);
  await mkdir(extracted);
  await execute('unzip', ['-q', zipPath, '-d', extracted], root);
  const cli = process.env.ARDUINO_CLI_PATH ?? path.resolve('.arduino/bin/arduino-cli');
  const args = ['compile', '--fqbn', fqbn, '--warnings', 'all', '--jobs', '2', '--build-path', path.join(extracted, 'independent-build'), '--output-dir', path.join(extracted, 'independent-firmware'), 'device'];
  const log = await execute(cli, args, extracted);
  const independentArtifacts = (await readdir(path.join(extracted, 'independent-firmware'))).filter(name => /\.(hex|bin|uf2)$/.test(name));
  if (!independentArtifacts.length) throw new Error('Independent compiler returned no firmware');
  let hostChecked = false;
  if (bindings.some(binding => binding.kind === 'serial' && binding.direction === 'input')) {
    await execute('python3', ['-m', 'py_compile', path.join(extracted, 'host', 'controller.py')], extracted); hostChecked = true;
  }
  const report = { name, revisionId: run.id, projectId: run.projectId, fqbn, architecture: built.profile?.architecture, core: built.profile?.core, coreVersion: built.profile?.version,
    generated: true, compiled: built.evidence?.compiled, simulationChecked: built.evidence?.simulationChecked, simulationAssertions: run.evidence?.results.flatMap(result => result.checks).length ?? 0,
    controllerParityChecks: built.evidence?.parityChecks, downloadedZipRecompiled: true, zipPath, zipSha256: createHash('sha256').update(bytes).digest('hex'), extracted, independentArtifacts,
    independentCommand: [cli, ...args], bindings, hostPythonSyntaxChecked: hostChecked, physicalTested: false, uploaded: false, checkedAt: new Date().toISOString(), evidence: built.evidence };
  await writeFile(path.join(root, `${name === 'keyboard-car' ? 'car' : name}-hardware-report.json`), JSON.stringify(report, null, 2));
  await writeFile(path.join(root, `${name}-independent-compile.log`), log);
  console.log(JSON.stringify(report));
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
