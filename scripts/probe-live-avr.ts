/** Exercise live-generated exported AVR firmware through its real USART and GPIO. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UnoMachine } from '../shared/simulator.js';
import { generateCircuit } from '../shared/circuit.js';
import { createPortableController, type PortableControllerProgram } from '../shared/portable-controller.js';
import type { HardwareConfiguration } from '../shared/hardware-project.js';
import type { RunSpec, TracePoint } from '../shared/types.js';
const root = path.resolve(process.env.PORTABLE_SMOKE_DIRECTORY ?? '.artifacts/live-hardware');
const reportPath = path.join(root, 'car-hardware-report.json');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const extracted = report.extracted as string;
const program = JSON.parse(await readFile(path.join(extracted, 'controller.json'), 'utf8')) as PortableControllerProgram;
const config = JSON.parse(await readFile(path.join(extracted, 'hardware.json'), 'utf8')) as HardwareConfiguration;
if (config.fqbn !== 'arduino:avr:uno') throw new Error('This CPU probe implements the 16 MHz Uno only');
const inputs = program.inputs.filter(input => input.type === 'boolean' && config.bindings.some(binding => binding.direction === 'input' && binding.kind === 'serial' && binding.signalId === input.id));
const outputs = config.bindings.filter(binding => binding.direction === 'output' && binding.kind !== 'serial');
const spec: RunSpec = { goal: 'Probe the downloaded application at real USART/GPIO boundaries', assumptions: ['LED circuit entries are logic probes, not actuator replacements.'], requirements: [{ id: 'R1', text: 'Compiled application outputs must reflect the shared controller after command delivery' }],
  components: outputs.map(binding => ({ id: binding.signalId, kind: 'led', label: binding.signalId, meaning: 'GPIO logic probe' })),
  serial: { baudRate: config.baudRate as 9600 | 115200, controls: inputs.map((input, index) => ({ key: String.fromCharCode(97 + index), label: input.id, data: `${input.id}=1\n`, releaseData: `${input.id}=0\n` })) } };
const hex = await readFile(path.join(extracted, 'firmware', 'device.ino.hex'), 'utf8');
const machine = new UnoMachine(hex, generateCircuit(spec, outputs.map(binding => ({ componentId: binding.signalId, pin: Number(binding.pin) }))));
const controller = createPortableController(program);
const checks: { input: string; value: boolean; signal: string; expected: number; observed: number; passed: boolean }[] = [];
function duty(trace: TracePoint[], signal: string, start: number, end: number) {
  let value = 0, from = start, high = 0;
  for (const point of trace.filter(point => point.signal === signal)) {
    if (point.atMs <= start) value = Number(point.value === 1);
    else if (point.atMs < end) { high += value * (point.atMs - from); from = point.atMs; value = Number(point.value === 1); }
  }
  high += value * (end - from); return high / (end - start);
}
machine.runUntil(100);
let now = 100;
for (const input of inputs) for (const value of [true, false]) {
  machine.sendSerial(`${input.id}=${Number(value)}\n`); controller.input(input.id, value);
  controller.step(0.08); now += 80; machine.runUntil(now);
  for (const binding of outputs) {
    const signal = program.outputs.find(output => output.id === binding.signalId)!;
    let expected = Number(controller.get(signal.id));
    let observed: number;
    if (binding.kind === 'pwm-output') {
      expected = Math.max(0, Math.min(255, Math.trunc((expected - (signal.hardware.min ?? 0)) * 255 / ((signal.hardware.max ?? 255) - (signal.hardware.min ?? 0))))) / 255;
      observed = duty(machine.trace, signal.id, now - 40, now);
    } else observed = Number(machine.trace.filter(point => point.signal === signal.id).at(-1)?.value);
    const passed = Math.abs(observed - expected) <= (binding.kind === 'pwm-output' ? 0.04 : 0);
    checks.push({ input: input.id, value, signal: signal.id, expected, observed, passed });
  }
}
// A held command must return to its declared default after loss of the host.
machine.sendSerial(`${inputs[0].id}=1\n`); now += 100; machine.runUntil(now);
now += config.serialTimeoutMs + 100; machine.runUntil(now);
for (const binding of outputs.filter(binding => binding.kind === 'pwm-output')) {
  const observed = duty(machine.trace, binding.signalId, now - 40, now);
  checks.push({ input: 'host timeout', value: false, signal: binding.signalId, expected: 0, observed, passed: observed === 0 });
}
machine.validateModes();
const result = { firmwarePath: path.join(extracted, 'firmware/device.ino.hex'), cpuSimulated: true, physicallyTested: false, checks, passed: checks.every(check => check.passed), statement: 'The actual downloaded Intel HEX ran in the AVR CPU simulator. Serial press/release commands exercised every generated keyboard input; digital direction and PWM duty were compared to the authoritative controller, including host-loss stop. No physical board was used.' };
await writeFile(path.join(root, 'car-avr-emulation.json'), JSON.stringify(result, null, 2));
report.firmwareCpuSimulated = true; report.firmwareEmulationChecks = checks.length; report.firmwareEmulationPassed = result.passed;
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: result.passed, checks: checks.length, failed: checks.filter(check => !check.passed), physicallyTested: false }));
if (!result.passed) process.exitCode = 1;
