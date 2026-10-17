import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { SimulationController } from '../server/simulation-controller';
import { HardwareProjectService } from '../server/hardware-project';
import { simulationRoutes } from '../server/simulation-routes';
import { hardwareCatalogRoutes } from '../server/hardware-routes';
import { buildHardwareProject, hardwareEnvironment } from '../server/hardware-adapters';
import { generateCircuit } from '../shared/circuit';
import { UnoMachine } from '../shared/simulator';
import type { HardwareProjectState } from '../shared/hardware-project';
import { HardwareFixtureAgents, hardwareFixtures, keyboardCar, timedLight } from './hardware-fixtures';

const evidenceDirectory = path.resolve('.artifacts/hardware-verification');
const sha = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');

function command(executable: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: hardwareEnvironment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', chunk => { log = (log + chunk).slice(-120000); });
    child.stderr.on('data', chunk => { log = (log + chunk).slice(-120000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Independent tool invocation timed out: ${log}`)); }, 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(log) : reject(new Error(`Independent tool invocation failed (${code}): ${log}`)); });
  });
}

/** Read actual downloaded ZIP bytes, including binary firmware and data descriptors. */
export function hardwareZipEntries(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('ZIP central directory is absent');
  const count = bytes.readUInt16LE(end + 10); let cursor = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const method = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20), nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) throw new Error('Unsafe ZIP entry');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression');
    entries.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const body = (method: string, data: unknown = {}) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

describe('complete simulation to downloadable real hardware project', () => {
  let directory: string, base: string, server: Server, simulations: SimulationController, hardware: HardwareProjectService;
  const agents = new HardwareFixtureAgents(keyboardCar);
  const reports: Record<string, unknown>[] = [];

  beforeAll(async () => {
    await mkdir('.artifacts/tests', { recursive: true });
    await mkdir(evidenceDirectory, { recursive: true });
    directory = await mkdtemp(path.resolve('.artifacts/tests/hardware-workflow-'));
    simulations = new SimulationController({ agents, directory: path.join(directory, 'simulations') });
    hardware = new HardwareProjectService(simulations, { directory: path.join(directory, 'hardware') });
    const app = express(); app.use(express.json());
    app.use('/api/hardware', hardwareCatalogRoutes()); app.use('/api/simulations', simulationRoutes(simulations, hardware));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    if (reports.length) await writeFile(path.join(evidenceDirectory, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), physicalTests: [], uploadedDevices: [], method: 'Deterministic generation fixtures; real browser verification, native C++ parity, selected-board compilation, HTTP ZIP download, extraction, independent Arduino CLI rebuild, and downloaded AVR firmware emulation where applicable.', results: reports }, null, 2));
    if (server) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  for (const fixture of hardwareFixtures) it(`builds and independently recompiles downloaded ${fixture.name} for ${fixture.configuration.fqbn}`, async () => {
    agents.fixture = fixture;
    const start = await fetch(`${base}/api/simulations`, body('POST', { prompt: fixture.spec.goal }));
    expect(start.status).toBe(202);
    const { id } = await start.json() as { id: string };
    const simulation = await simulations.wait(id);
    expect(simulation?.status, simulation?.error ?? simulation?.warning).toBe('READY');
    expect(simulation?.evidence?.passed).toBe(true);
    const catalog = await fetch(`${base}/api/hardware/catalog?q=${encodeURIComponent(fixture.configuration.fqbn)}`).then(response => response.json());
    expect(catalog.boards.some((board: { fqbn: string }) => board.fqbn === fixture.configuration.fqbn)).toBe(true);
    const configureResponse = await fetch(`${base}/api/simulations/${id}/hardware`, body('PUT', fixture.configuration));
    expect(configureResponse.status).toBe(200);
    const configured = await configureResponse.json() as HardwareProjectState;
    expect(configured.issues).toEqual([]);
    const beforeBuild = await fetch(`${base}/api/simulations/${id}/hardware/export`);
    expect(beforeBuild.status).toBe(409);
    const buildResponse = await fetch(`${base}/api/simulations/${id}/hardware/build`, body('POST'));
    expect(buildResponse.status).toBe(202);
    const built = await hardware.wait(id);
    expect(built.status, built.error ?? built.log).toBe('COMPILED');
    expect(built.evidence).toMatchObject({ generated: true, compiled: true, simulationChecked: true, controllerParity: true, physicalTested: false });
    expect(built.evidence!.parityChecks).toBeGreaterThan(30);

    const response = await fetch(`${base}/api/simulations/${id}/hardware/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('.zip');
    const bytes = Buffer.from(await response.arrayBuffer());
    const entries = hardwareZipEntries(bytes);
    for (const name of ['device/device.ino', 'device/controller.h', 'controller.json', 'hardware.json', 'device-profile.json', 'WIRING.md', 'README.md', 'dependency-lock.json', 'verification-report.json', 'requirements.json', 'simulation.html', 'environment.js', 'checks/parity-report.json']) expect(entries.has(name), name).toBe(true);
    expect(JSON.parse(entries.get('controller.json')!.toString())).toEqual(fixture.program);
    expect(entries.get('device/controller.h')!.toString()).not.toContain('createEnvironment');
    expect(entries.get('README.md')!.toString()).toContain('Physical behavior has NOT been tested');
    const exportedEvidence = JSON.parse(entries.get('verification-report.json')!.toString());
    for (const [name, hash] of Object.entries(exportedEvidence.artifactHashes)) expect(sha(entries.get(name)!), name).toBe(hash);
    const firmware = [...entries.keys()].filter(name => /^firmware\/.+\.(hex|bin|uf2)$/.test(name));
    expect(firmware.length).toBeGreaterThan(0);
    let firmwareEmulated = false;
    if (fixture.name === 'keyboard-car') {
      const outputs = fixture.configuration.bindings.filter(binding => binding.direction === 'output');
      const circuit = generateCircuit({ goal: 'Observe the exported controller GPIO and UART in AVR8js.', assumptions: [], requirements: [{ id: 'R1', text: 'Serial commands drive outputs and inactivity returns them to initial values.' }], components: outputs.map(binding => ({ id: binding.signalId, label: binding.signalId, kind: 'led', meaning: 'GPIO probe for firmware verification' })), serial: { baudRate: 115200, controls: [{ key: 'w', label: 'Forward command', data: 'forward=1\n', releaseData: 'forward=0\n' }] } }, outputs.map(binding => ({ componentId: binding.signalId, pin: Number(binding.pin) })));
      const machine = new UnoMachine(entries.get('firmware/device.ino.hex')!.toString(), circuit);
      const latest = (signal: string) => machine.trace.filter(point => point.signal === signal).at(-1)?.value;
      machine.runUntil(100); machine.sendSerial('forward=1\n'); machine.runUntil(250);
      expect(latest('leftForward')).toBe(1);
      expect(machine.trace.some(point => point.signal === 'leftPower' && point.atMs > 110 && point.value === 1)).toBe(true);
      expect(machine.trace.some(point => point.signal === 'rightPower' && point.atMs > 110 && point.value === 1)).toBe(true);
      machine.sendSerial('forward=0\nreverse=1\n'); machine.runUntil(400);
      expect(latest('leftForward')).toBe(0); expect(latest('rightForward')).toBe(0);
      machine.runUntil(950);
      expect(latest('leftPower')).toBe(0); expect(latest('rightPower')).toBe(0);
      machine.validateModes(); firmwareEmulated = true;
    }
    if (fixture.name === 'timed-light') {
      const circuit = generateCircuit({ goal: 'Observe exported held-button timing in AVR8js.', assumptions: [], requirements: [{ id: 'R1', text: 'A held input must not continuously restart the event-driven controller timer.' }], components: [{ id: 'start', label: 'Start button', kind: 'button', meaning: 'Start timer' }, { id: 'lamp', label: 'Lamp', kind: 'led', meaning: 'Timed lamp output' }] }, [{ componentId: 'start', pin: 2 }, { componentId: 'lamp', pin: 8 }]);
      const machine = new UnoMachine(entries.get('firmware/device.ino.hex')!.toString(), circuit);
      const lamp = () => machine.trace.filter(point => point.signal === 'lamp').at(-1)?.value;
      machine.runUntil(100); machine.setButton('start', true); machine.runUntil(500); expect(lamp()).toBe(1);
      machine.runUntil(2250); expect(lamp()).toBe(0);
      machine.setButton('start', false); machine.runUntil(2300); machine.setButton('start', true); machine.runUntil(2400); expect(lamp()).toBe(1);
      machine.validateModes(); firmwareEmulated = true;
    }

    const extracted = path.join(directory, `extracted-${fixture.name}`);
    for (const [name, content] of entries) { await mkdir(path.dirname(path.join(extracted, name)), { recursive: true }); await writeFile(path.join(extracted, name), content); }
    if (fixture.name === 'keyboard-car') {
      expect(entries.has('host/controller.py')).toBe(true);
      expect(entries.get('host/controller.py')!.toString()).toContain("parser.add_argument('--port', required=True");
      expect(entries.get('host/controller.py')!.toString()).toContain('device.write(batch.encode');
      expect(entries.get('host/requirements.txt')!.toString()).toContain('pyserial==');
      await command('python3', ['-m', 'py_compile', path.join(extracted, 'host', 'controller.py')], extracted);
    } else expect(entries.has('host/controller.py')).toBe(false);

    // Deliberately invoke Arduino CLI directly, in the extracted directory, with
    // fresh output/build directories. No generator, service, or original source is used.
    const independentOutput = path.join(extracted, 'independent-firmware');
    const cli = process.env.ARDUINO_CLI_PATH ?? path.resolve('.arduino/bin/arduino-cli');
    const args = ['compile', '--fqbn', fixture.configuration.fqbn, '--warnings', 'all', '--jobs', '2', '--build-path', path.join(extracted, 'independent-build'), '--output-dir', independentOutput, 'device'];
    const compileLog = await command(cli, args, extracted);
    const independentArtifacts = (await readdir(independentOutput)).filter(name => /\.(hex|bin|uf2)$/.test(name));
    expect(independentArtifacts.length).toBeGreaterThan(0);
    const report = { project: fixture.name, revisionId: id, fqbn: fixture.configuration.fqbn, architecture: built.profile!.architecture, coreVersion: built.profile!.version, toolchain: built.profile!.toolchain, simulationChecked: built.evidence!.simulationChecked, parityChecks: built.evidence!.parityChecks, compiled: true, firmwareEmulated, downloadedZipRecompiled: true, physicallyTested: false, uploaded: false, zipSha256: sha(bytes), firmware, independentArtifacts, command: ['arduino-cli', ...args], checkedAt: new Date().toISOString() };
    reports.push(report);
    await writeFile(path.join(evidenceDirectory, `${fixture.name}.zip`), bytes);
    await writeFile(path.join(evidenceDirectory, `${fixture.name}-independent-compile.log`), compileLog);
    await writeFile(path.join(evidenceDirectory, `${fixture.name}-verification.json`), JSON.stringify({ ...report, evidence: built.evidence }, null, 2));

    // A hardware configuration edit invalidates prior evidence and download rights.
    const changed = structuredClone(fixture.configuration); changed.baudRate = 57600;
    const update = await fetch(`${base}/api/simulations/${id}/hardware`, body('PUT', changed)).then(response => response.json());
    expect(update.evidence).toBeUndefined();
    expect((await fetch(`${base}/api/simulations/${id}/hardware/export`)).status).toBe(409);
  }, 180000);

  it('retains bindings across a chat revision while rejecting stale exports and incompatible pins', async () => {
    agents.fixture = timedLight;
    const original = await simulations.start({ prompt: timedLight.spec.goal }); await simulations.wait(original.id);
    await hardware.configure(original.id, timedLight.configuration);
    const followup = await simulations.start({ prompt: 'Change the enclosure to a desk lamp and preserve its two-second behavior.', previousId: original.id });
    const ready = await simulations.wait(followup.id);
    expect(ready?.status, ready?.error).toBe('READY');
    expect(ready?.projectId).toBe(original.projectId);
    const inherited = await hardware.get(followup.id);
    expect(inherited.status).toBe('STALE');
    expect(inherited.configuration).toEqual(timedLight.configuration);
    expect(inherited.evidence).toBeUndefined();
    await expect(hardware.exportFiles(original.id)).rejects.toThrow(/older project revision/);
    const conflict = structuredClone(timedLight.configuration); conflict.bindings[1].pin = '2';
    const invalid = await hardware.configure(followup.id, conflict);
    expect(invalid.issues.join(' ')).toMatch(/already used/);
    await expect(hardware.build(followup.id)).rejects.toThrow(/already used/);
    const refused = await fetch(`${base}/api/simulations/${followup.id}/hardware/upload`, body('POST', { port: '/dev/not-a-device' }));
    expect(refused.status).toBe(400);
  });

  it('resolves a real Library Manager dependency and clears old firmware on compile failure', async () => {
    const sketch = path.join(directory, 'library-sketch'); const output = path.join(directory, 'library-output');
    await mkdir(sketch, { recursive: true });
    await writeFile(path.join(sketch, 'library-sketch.ino'), '#include <Servo.h>\nServo actuator;\nvoid setup(){actuator.attach(9);actuator.write(90);}\nvoid loop(){}\n');
    const result = await buildHardwareProject({ fqbn: 'arduino:avr:uno', sketchDirectory: sketch, outputDirectory: output, libraries: [{ name: 'Servo', version: '1.3.0' }] });
    expect(result.dependencies).toContainEqual({ name: 'Servo', version: '1.3.0' });
    expect(result.artifacts.some(artifact => artifact.name.endsWith('.hex'))).toBe(true);
    await writeFile(path.join(sketch, 'library-sketch.ino'), 'void setup(){ undefined_invalid_function(); }\nvoid loop(){}\n');
    await expect(buildHardwareProject({ fqbn: 'arduino:avr:uno', sketchDirectory: sketch, outputDirectory: output })).rejects.toThrow(/failed/);
    await expect(readFile(path.join(output, 'library-sketch.ino.hex'))).rejects.toThrow();
  }, 180000);
});
