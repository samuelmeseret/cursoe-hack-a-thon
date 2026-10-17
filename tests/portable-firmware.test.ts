import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDeviceProfile, buildHardwareProject } from '../server/hardware-adapters';
import { firmwareSource } from '../server/hardware-generation';
import { emitControllerCpp, type PortableControllerProgram } from '../shared/portable-controller';
import { generateCircuit } from '../shared/circuit';
import { runScenario } from '../shared/simulator';
import type { HardwareConfiguration } from '../shared/hardware-project';
import type { RunSpec, Scenario } from '../shared/types';

/** Transport regression using compiled application firmware, not a hand-written sketch. */
describe('portable firmware transport in the AVR CPU simulator', () => {
  it('receives real serial frames, honors heartbeat, ignores malformed input and restores defaults on timeout', async () => {
    const program: PortableControllerProgram = {
      version: 1, name: 'Remote indicator', state: [], step: [],
      inputs: [{ id: 'enable', label: 'Enable', type: 'boolean', initial: false, hardware: { kind: 'serial' } }],
      outputs: [{ id: 'lamp', label: 'Indicator', type: 'boolean', initial: false, hardware: { kind: 'digital-output' } }],
      update: [{ set: 'lamp', value: { ref: 'enable' } }],
    };
    const profile = await getDeviceProfile('arduino:avr:uno');
    const pin = profile.pins.find(pin => pin.number === 8)!;
    const config: HardwareConfiguration = { fqbn: profile.fqbn, libraries: [], baudRate: 9600, serialTimeoutMs: 250, bindings: [
      { signalId: 'enable', direction: 'input', kind: 'serial', component: 'USB serial host' },
      { signalId: 'lamp', direction: 'output', kind: 'digital-output', pin: pin.id, component: 'LED with 220 ohm resistor' },
    ] };
    await mkdir('.artifacts/tests', { recursive: true });
    const directory = await mkdtemp(path.resolve('.artifacts/tests/portable-uart-'));
    try {
      await mkdir(path.join(directory, 'device'));
      await writeFile(path.join(directory, 'device', 'controller.h'), emitControllerCpp(program));
      await writeFile(path.join(directory, 'device', 'device.ino'), firmwareSource(program, config, profile));
      const build = await buildHardwareProject({ fqbn: profile.fqbn, sketchDirectory: path.join(directory, 'device'), outputDirectory: path.join(directory, 'firmware'), libraries: [] });
      const artifact = build.artifacts.find(artifact => artifact.name.endsWith('.hex') && !artifact.name.includes('with_bootloader'))!;
      const hex = await readFile(artifact.path, 'utf8');
      const spec: RunSpec = { goal: 'Check real generated serial firmware', assumptions: [], components: [{ id: 'lamp', kind: 'led', label: 'Indicator', meaning: 'Remote command output' }], requirements: [{ id: 'R1', text: 'Commands, heartbeat and timeout update real output GPIO' }], serial: { baudRate: 9600, controls: [{ key: 'e', label: 'Enable', data: 'enable=1\n', releaseData: 'enable=0\n' }] } };
      const scenario: Scenario = { id: 'serial-transport', name: 'Valid, invalid and disconnected serial host', durationMs: 750,
        inputs: [ { atMs: 100, serial: 'enable=1\n' }, { atMs: 200, serial: '@heartbeat=1\n' }, { atMs: 300, serial: 'unknown=1\n' }, { atMs: 550, serial: 'enable=NaN\n' }, { atMs: 600, serial: 'enable=1\n' }, { atMs: 660, serial: 'enable=0\n' } ],
        assertions: [
          { id: 'starts-off', fromMs: 20, toMs: 90, value: 0 },
          { id: 'command-on', fromMs: 130, toMs: 190, value: 1 },
          { id: 'heartbeat-holds', fromMs: 360, toMs: 430, value: 1 },
          { id: 'timeout-off', fromMs: 490, toMs: 540, value: 0 },
          { id: 'nan-ignored', fromMs: 575, toMs: 595, value: 0 },
          { id: 'new-command-on', fromMs: 625, toMs: 650, value: 1 },
          { id: 'release-off', fromMs: 685, toMs: 740, value: 0 },
        ].map(assertion => ({ ...assertion, value: assertion.value as 0 | 1, type: 'level', signal: 'lamp', driven: true, requirementIds: ['R1'] })),
      };
      const result = runScenario(hex, generateCircuit(spec, [{ componentId: 'lamp', pin: 8 }]), scenario);
      expect(result.completed, result.error).toBe(true);
      for (const check of result.checks) expect(check.passed, check.message).toBe(true);
      const reportDirectory = path.resolve('.artifacts/hardware-verification');
      await mkdir(reportDirectory, { recursive: true });
      await writeFile(path.join(reportDirectory, 'portable-avr-transport.json'), JSON.stringify({ target: profile.fqbn, compiled: true, cpuSimulated: true, physicalTested: false, checks: result.checks, command: build.command }, null, 2));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
