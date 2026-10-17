import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SimulationController } from '../server/simulation-controller';
import { HardwareProjectService } from '../server/hardware-project';
import { configurationIssues, firmwareSource } from '../server/hardware-generation';
import { hardwareConfigurationSchema } from '../server/hardware-routes';
import { composeControllerSimulation, type PortableControllerProgram } from '../shared/portable-controller';
import type { HardwareConfiguration } from '../shared/hardware-project';
import type { HardwareProfile } from '../shared/hardware-types';
import type { SimulationRun } from '../shared/simulation-run';

const program: PortableControllerProgram = {
  version: 1, name: 'Signal relay', inputs: [{ id: 'enabled', label: 'Enable', type: 'boolean', initial: false, hardware: { kind: 'serial', component: 'Computer' } }], state: [],
  outputs: [{ id: 'lamp', label: 'Lamp', type: 'boolean', initial: false, hardware: { kind: 'digital-output', component: 'LED with resistor' } }], step: [], update: [{ set: 'lamp', value: { ref: 'enabled' } }],
};
const environmentSource = 'function createEnvironment(controller){return {reset(){},input(){},step(){},snapshot(){return {}},draw(ctx,w,h){ctx.fillRect(0,0,w,h)}}}';
const profile: HardwareProfile = { id: 'test', name: 'Metadata board', fqbn: 'arduino:avr:uno', architecture: 'avr', framework: 'Arduino', toolchain: 'avr-gcc', adapter: 'arduino', core: 'arduino:avr', version: '1.8.6', installed: true, pins: [{ id: '13', label: 'D13', number: 13, digital: true, analog: false, pwm: false, interfaces: [] }, { id: '3', label: 'D3', number: 3, digital: true, analog: false, pwm: true, interfaces: [] }], interfaces: ['serial'], capabilities: ['gpio'], constraints: [], supported: true, missingCapabilities: [], uploadSupported: true, options: [], metadataSources: ['variant metadata'] };
const configuration: HardwareConfiguration = { fqbn: profile.fqbn, bindings: [{ signalId: 'enabled', direction: 'input', kind: 'serial', component: 'Computer' }, { signalId: 'lamp', direction: 'output', kind: 'digital-output', pin: '13', component: 'LED with resistor' }], libraries: [], baudRate: 115200, serialTimeoutMs: 500 };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hardware-project-')); directories.push(directory);
  let head = 'revision1';
  const run: SimulationRun = { id: 'revision1', projectId: 'project1', revision: 1, prompt: 'Control a lamp', goal: 'Control a lamp', status: 'READY', createdAt: '', updatedAt: '', deadlineAt: '', events: [], messages: [], attempts: [], spec: { title: 'Signal relay', goal: 'Control a lamp', summary: 'Enable the lamp', assumptions: [], controls: [{ id: 'enabled', label: 'Enable', type: 'toggle', initial: false }], observables: [{ id: 'lamp', label: 'Lamp', type: 'boolean' }], requirements: [{ id: 'R1', text: 'Lamp follows enable.' }] }, candidate: { id: 'candidate1', controller: structuredClone(program), environmentSource, source: composeControllerSimulation(program, environmentSource), rationale: 'One shared controller.' }, scenarios: [{ id: 'on', name: 'Enable', steps: [{ type: 'input', controlId: 'enabled', value: true }, { type: 'assert', id: 'on', observable: 'lamp', operator: 'eq', value: true, requirementIds: ['R1'] }] }] };
  const simulations = { get: vi.fn(async (id: string) => id === run.id ? structuredClone(run) : undefined), projectHead: vi.fn(async () => head) } as unknown as SimulationController;
  const compile = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
    await mkdir(outputDirectory, { recursive: true }); const target = path.join(outputDirectory, 'device.ino.hex'); await writeFile(target, ':00000001FF\n');
    return { profile, log: 'Actual compiler fixture', artifacts: [{ name: 'device.ino.hex', path: target, sha256: '', bytes: 12 }], dependencies: [], command: ['test-fixture'], compiledAt: '', physicallyTested: false as const };
  });
  const service = new HardwareProjectService(simulations, { directory, profile: vi.fn(async () => profile), compile, parity: vi.fn(async (_program, _spec, _scenarios, folder) => { await mkdir(folder, { recursive: true }); for (const name of ['parity.cpp', 'controller.h', 'parity-report.json']) await writeFile(path.join(folder, name), 'check fixture'); return { passed: true as const, checks: 50, log: 'Fixture parity' }; }), verify: vi.fn(async () => ({ passed: true, results: [{ scenarioId: 'on', name: 'Enable', completed: true, checks: [{ id: 'on', requirementIds: ['R1'], passed: true, actual: true, message: 'Lamp on' }] }] })) });
  return { directory, run, service, compile, setHead: (value: string) => { head = value; } };
}

describe('hardware project integrity and lifecycle', () => {
  it('requires configuration and real compilation gate before exporting', async () => {
    const { service } = await setup();
    expect((await service.get('revision1')).status).toBe('UNCONFIGURED');
    await expect(service.exportFiles('revision1')).rejects.toThrow('Build and check');
    await expect(service.build('revision1')).rejects.toThrow('Select your board');
    expect((await service.configure('revision1', configuration)).status).toBe('CONFIGURED');
    expect((await service.build('revision1')).status).toBe('BUILDING');
    const result = await service.wait('revision1');
    expect(result.evidence).toMatchObject({ generated: true, compiled: true, simulationChecked: true, controllerParity: true, physicalTested: false, parityChecks: 50 });
    const files = await service.exportFiles('revision1');
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['device/controller.h', 'device/device.ino', 'host/controller.py', 'WIRING.md', 'dependency-lock.json', 'simulation.html', 'firmware/device.ino.hex', 'verification-report.json']));
    expect(files['host/controller.py'].toString()).toContain('@heartbeat=1');
    expect(files['device/device.ino'].toString()).toContain('500UL');
  });
  it('invalidates compilation when pin configuration changes', async () => {
    const { service } = await setup(); await service.configure('revision1', configuration); await service.build('revision1'); await service.wait('revision1');
    const changed = structuredClone(configuration); changed.bindings[1].pin = '3';
    const state = await service.configure('revision1', changed);
    expect(state.evidence).toBeUndefined(); expect(state.upload).toBeUndefined();
    await expect(service.exportFiles('revision1')).rejects.toThrow('Build and check');
  });
  it('serializes simultaneous builds and configuration changes', async () => {
    const { service, compile } = await setup(); await service.configure('revision1', configuration);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = compile.getMockImplementation()!;
    compile.mockImplementation(async request => { await gate; return original(request); });
    const starts = await Promise.allSettled([service.build('revision1'), service.build('revision1')]);
    expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(starts.filter(result => result.status === 'rejected')).toHaveLength(1);
    await expect(service.configure('revision1', configuration)).rejects.toThrow('operation is already running');
    release(); await service.wait('revision1');
    expect(compile).toHaveBeenCalledTimes(1);
  });
  it('rejects old revisions and retains bindings without old evidence on follow-up', async () => {
    const { service, run, setHead } = await setup(); await service.configure('revision1', configuration); await service.build('revision1'); await service.wait('revision1');
    setHead('revision2'); await expect(service.exportFiles('revision1')).rejects.toThrow('older project revision');
    run.id = 'revision2'; run.revision = 2;
    const next = await service.get('revision2');
    expect(next).toMatchObject({ projectId: 'project1', revisionId: 'revision2', status: 'STALE', configuration });
    expect(next.evidence).toBeUndefined();
  });
  it('detects modified firmware and refuses stale download', async () => {
    const { directory, service } = await setup(); await service.configure('revision1', configuration); await service.build('revision1'); await service.wait('revision1');
    const builds = path.join(directory, 'project1', 'builds'); const [build] = await readdir(builds);
    await writeFile(path.join(builds, build, 'firmware/device.ino.hex'), 'modified');
    expect((await service.get('revision1')).status).toBe('STALE');
    await expect(service.exportFiles('revision1')).rejects.toThrow('Build and check');
  });
  it('invalidates compiled evidence when controller metadata changes', async () => {
    const { service, run } = await setup(); await service.configure('revision1', configuration); await service.build('revision1'); await service.wait('revision1');
    run.candidate!.controller!.inputs[0].hardware.component = 'Changed component';
    expect((await service.get('revision1')).status).toBe('STALE');
  });
  it('never uploads without explicit selection and confirmation', async () => {
    const { service } = await setup();
    await expect(service.upload('revision1', '', true)).rejects.toThrow('Explicitly select');
    await expect(service.upload('revision1', 'some-device', false)).rejects.toThrow('Explicitly select');
    await expect(service.upload('revision1', 'some-device', true)).rejects.toThrow('Build the current');
  });
});

describe('hardware configuration requirements', () => {
  it('reports missing driver capabilities instead of claiming export support', () => {
    expect(configurationIssues({ ...program, requiredCapabilities: ['driver:i2c:bme280'] }, configuration, profile).join(' ')).toContain('Missing build adapter capability: driver:i2c:bme280');
  });
  it('requires application I/O generation for an unimplemented runtime', () => {
    expect(configurationIssues(program, configuration, { ...profile, framework: 'Python', adapter: 'python-device' }).join(' ')).toContain('Missing application source generator for Python');
  });
  it('rejects a declared signal voltage above a known board logic level', () => {
    const changed = structuredClone(program); changed.outputs[0].hardware.voltage = 5;
    expect(configurationIssues(changed, configuration, { ...profile, logicVoltage: 3.3 }).join(' ')).toContain('5 V signal exceeds');
  });
  it('rejects invalid directions and incompatible GPIO capabilities', () => {
    const changed = structuredClone(configuration); changed.bindings[1].kind = 'pwm-output';
    const issues = configurationIssues(program, changed, profile).join(' ');
    expect(issues).toContain('cannot carry a boolean'); expect(issues).toContain('does not support PWM');
  });
  it('does not treat unknown libraries as implemented component drivers', () => {
    expect(configurationIssues({ ...program, requiredCapabilities: ['driver:servo'] }, { ...configuration, libraries: [{ name: 'Servo' }] }, profile).join(' ')).toContain('driver:servo');
  });
  it('validates transport settings and refuses additional client-supplied source or verification', () => {
    expect(hardwareConfigurationSchema.safeParse(configuration).success).toBe(true);
    expect(hardwareConfigurationSchema.safeParse({ ...configuration, baudRate: 1 }).success).toBe(false);
    expect(hardwareConfigurationSchema.safeParse({ ...configuration, source: 'bad' }).success).toBe(false);
    expect(hardwareConfigurationSchema.safeParse({ ...configuration, serialTimeoutMs: 0 }).success).toBe(false);
  });
  it('uses active-low polarity and real explicit serial protocol', () => {
    const changed = structuredClone(configuration); changed.bindings[1].activeLow = true;
    const source = firmwareSource(program, changed, profile);
    expect(source).toContain('? LOW : HIGH');
    expect(source).toContain('strcmp(serialLine, "enabled")');
    expect(source).toContain('strcmp(serialLine, "@heartbeat")');
    expect(source).toContain('!isfinite(value)');
  });
});
