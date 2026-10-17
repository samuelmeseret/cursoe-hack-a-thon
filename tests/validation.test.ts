import { describe, expect, it } from 'vitest';
import { airlockScenarios, airlockSpec, goodAirlockCandidate } from '../shared/fixtures';
import { generateCircuit, validateCircuit } from '../shared/circuit';
import { validateCandidate, validateSpec, validateSuite } from '../shared/validation';
import { outputSignals } from '../shared/components';
import { circuitSvg } from '../server/diagram';
import type { Candidate, RunSpec, Scenario } from '../shared/types';

const carSpec: RunSpec = {
  goal: 'Drive a mini car forwards and backwards from the keyboard', assumptions: [], presentation: 'vehicle',
  components: [{ id: 'drive', kind: 'motor', label: 'Drive motor', meaning: 'Forward and reverse H-bridge control inputs' }],
  requirements: [{ id: 'R1', text: 'Start stopped, drive forwards or backwards on serial commands, and stop on release without driving both inputs HIGH.' }],
  serial: { baudRate: 9600, controls: [{ key: 'w', label: 'Forward', data: 'F', releaseData: 'X' }, { key: 's', label: 'Reverse', data: 'B', releaseData: 'X' }] },
};
const carCandidate: Candidate = { id: 'car', source: 'void setup(){} void loop(){}', rationale: 'Drive through an H-bridge', pins: [{ componentId: 'drive', pin: 4, reversePin: 5 }] };
const carScenarios: Scenario[] = [{
  id: 'movement', name: 'Drive and stop in both directions', durationMs: 700,
  inputs: [{ atMs: 100, serial: 'F' }, { atMs: 250, serial: 'X' }, { atMs: 300, serial: 'B' }, { atMs: 500, serial: 'X' }],
  assertions: [
    { id: 'forward', type: 'level', signal: 'drive_forward', value: 1, driven: true, fromMs: 150, toMs: 250, requirementIds: ['R1'] },
    { id: 'reverse', type: 'level', signal: 'drive_reverse', value: 1, driven: true, fromMs: 350, toMs: 500, requirementIds: ['R1'] },
    ...(['drive_forward', 'drive_reverse'] as const).flatMap(signal => [
      { id: `${signal}-startup`, type: 'level' as const, signal, value: 0 as const, driven: true, fromMs: 50, toMs: 100, requirementIds: ['R1'] },
      { id: `${signal}-stop`, type: 'level' as const, signal, value: 0 as const, driven: true, fromMs: 550, toMs: 700, requirementIds: ['R1'] },
    ]),
    { id: 'safe-direction', type: 'mutual-exclusion', signals: ['drive_forward', 'drive_reverse'], fromMs: 0, toMs: 700, requirementIds: ['R1'] },
  ],
}];

describe('frozen contract and test-suite validation', () => {
  it('accepts the full supported airlock contract, candidate, and suite', () => {
    expect(validateSpec(airlockSpec)).toEqual(airlockSpec);
    expect(validateCandidate(airlockSpec, goodAirlockCandidate)).toEqual(goodAirlockCandidate);
    expect(validateSuite(airlockScenarios, airlockSpec)).toEqual(airlockScenarios);
  });
  it('rejects unsupported components, duplicate IDs, and excessive components', () => {
    const unsupported = structuredClone(airlockSpec) as any;
    unsupported.components[0].kind = 'servo';
    expect(() => validateSpec(unsupported)).toThrow(/Unsupported/);
    const duplicate = structuredClone(airlockSpec);
    duplicate.components[1].id = duplicate.components[0].id;
    expect(() => validateSpec(duplicate)).toThrow(/unique/);
    const excess = structuredClone(airlockSpec);
    excess.components = Array.from({ length: 7 }, (_, i) => ({ id: `led${i}`, kind: 'led', label: 'LED', meaning: 'Output' }));
    expect(() => validateSpec(excess)).toThrow(/six LEDs/);
  });
  it('rejects empty, uncovered, unknown-signal, and vacuous suites', () => {
    expect(() => validateSuite([], airlockSpec)).toThrow(/suite/);
    expect(() => validateSuite(airlockScenarios.slice(0, 1), airlockSpec)).toThrow(/Uncovered/);
    const invalid = structuredClone(airlockScenarios);
    (invalid[0].assertions[0] as any).signal = 'imaginary';
    expect(() => validateSuite(invalid, airlockSpec)).toThrow(/Invalid output/);
    const noUseful = structuredClone(airlockScenarios);
    noUseful.forEach((scenario) => scenario.assertions = scenario.assertions.map((assertion) => ({ id: assertion.id, type: 'level', signal: 'outerDoor', value: 0, fromMs: assertion.fromMs, toMs: assertion.toMs, requirementIds: assertion.requirementIds })));
    expect(() => validateSuite(noUseful, airlockSpec)).toThrow(/useful HIGH/);
  });
  it('rejects model-provided executable predicates and invalid time ranges', () => {
    const executable = structuredClone(airlockScenarios) as any;
    executable[0].assertions[0].javascript = 'return true';
    expect(() => validateSuite(executable, airlockSpec)).toThrow(/unsupported field/);
    const invalidTime = structuredClone(airlockScenarios);
    invalidTime[0].assertions[0].toMs = 999999;
    expect(() => validateSuite(invalidTime, airlockSpec)).toThrow(/Assertion end/);
  });
  it('rejects logical IDs that alias generated physical components', () => {
    const boardAlias = structuredClone(airlockSpec); boardAlias.components[0].id = 'uno';
    expect(() => validateSpec(boardAlias)).toThrow(/collide/);
    const resistorAlias = structuredClone(airlockSpec); resistorAlias.components[0].id = 'outerDoor-resistor';
    expect(() => validateSpec(resistorAlias)).toThrow(/collide/);
  });
  it('namespaces check IDs by scenario while rejecting duplicate checks within a scenario', () => {
    const suite = structuredClone(airlockScenarios);
    suite[1].assertions[0].id = suite[0].assertions[0].id;
    expect(validateSuite(suite, airlockSpec)).toEqual(suite);
    suite[1].assertions[1].id = suite[1].assertions[0].id;
    expect(() => validateSuite(suite, airlockSpec)).toThrow(/within each scenario/);
  });
});

describe('approved circuit generation', () => {
  it('requires distinct D2–D13 assignments and frozen meanings', () => {
    const pins = structuredClone(goodAirlockCandidate.pins);
    pins[1].pin = pins[0].pin;
    expect(() => generateCircuit(airlockSpec, pins)).toThrow(/Duplicate pin/);
    pins[1].pin = 1;
    expect(() => generateCircuit(airlockSpec, pins)).toThrow(/D2/);
    const circuit = generateCircuit(airlockSpec, goodAirlockCandidate.pins);
    circuit.components[0].meaning = 'Secretly changed behavior';
    expect(() => validateCircuit(circuit, airlockSpec)).toThrow(/frozen component/);
  });
  it('rejects removed, duplicate, wrong-ground, and missing-resistor wires', () => {
    const original = generateCircuit(airlockSpec, goodAirlockCandidate.pins);
    const missing = structuredClone(original); missing.connections.pop();
    expect(() => validateCircuit(missing)).toThrow(/wiring/);
    const duplicate = structuredClone(original); duplicate.connections.push(duplicate.connections[0]);
    expect(() => validateCircuit(duplicate)).toThrow(/wiring/);
    const wrongGround = structuredClone(original); wrongGround.connections.find((wire) => wire.to === 'uno:GND')!.to = 'uno:5V';
    expect(() => validateCircuit(wrongGround)).toThrow(/wiring/);
    const noResistor = structuredClone(original); noResistor.components.find((c) => c.kind === 'led')!.resistanceOhms = 0;
    expect(() => validateCircuit(noResistor)).toThrow(/220-ohm/);
  });
});

describe('motor and keyboard serial contracts', () => {
  it('accepts a motor-only keyboard vehicle and exposes its real H-bridge signals', () => {
    expect(validateSpec(carSpec)).toEqual(carSpec);
    expect(validateCandidate(carSpec, carCandidate)).toEqual(carCandidate);
    expect(validateSuite(carScenarios, carSpec)).toEqual(carScenarios);
    expect(outputSignals([...airlockSpec.components, ...carSpec.components])).toEqual(['outerDoor', 'innerDoor', 'drive_forward', 'drive_reverse']);
  });
  it('bounds motor counts and total pin use', () => {
    const tooManyMotors = structuredClone(carSpec);
    tooManyMotors.components = Array.from({ length: 3 }, (_, i) => ({ ...carSpec.components[0], id: `motor${i}` }));
    expect(() => validateSpec(tooManyMotors)).toThrow(/two motors/);
    const tooManyPins: RunSpec = { ...carSpec, components: [
      ...Array.from({ length: 2 }, (_, i) => ({ ...carSpec.components[0], id: `motor${i}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `led${i}`, kind: 'led' as const, label: 'LED', meaning: 'Lit when high' })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `button${i}`, kind: 'button' as const, label: 'Button', meaning: 'Low when pressed' })),
    ] };
    expect(() => validateSpec(tooManyPins)).toThrow(/twelve/);
  });
  it('prevents generated motor parts and signals from aliasing logical components', () => {
    for (const suffix of ['-driver', '-supply', '_forward', '_reverse']) {
      const spec = structuredClone(carSpec);
      spec.components.push({ id: `drive${suffix}`, kind: 'led', label: 'LED', meaning: 'Output' });
      expect(() => validateSpec(spec)).toThrow(/collide/);
    }
  });
  it('requires distinct motor control pins and prevents non-motor reverse assignments', () => {
    for (const reversePin of [undefined, 1, 14, 4]) {
      const candidate = structuredClone(carCandidate); candidate.pins[0].reversePin = reversePin;
      expect(() => validateCandidate(carSpec, candidate)).toThrow(/pin/i);
      expect(() => generateCircuit(carSpec, candidate.pins)).toThrow(/pin/i);
    }
    const mixed: RunSpec = { ...carSpec, components: [...carSpec.components, { id: 'status', kind: 'led', label: 'Status', meaning: 'Status output' }] };
    expect(() => validateCandidate(mixed, { ...carCandidate, pins: [...carCandidate.pins, { componentId: 'status', pin: 5 }] })).toThrow(/unique/);
    const candidate = structuredClone(goodAirlockCandidate); candidate.pins[0].reversePin = 12;
    expect(() => validateCandidate(airlockSpec, candidate)).toThrow(/Only motors/);
  });
  it('requires both motor directions to be observable and guarded throughout every scenario', () => {
    const noReverse = structuredClone(carScenarios); noReverse[0].assertions = noReverse[0].assertions.filter(a => a.id !== 'reverse');
    expect(() => validateSuite(noReverse, carSpec)).toThrow(/useful HIGH.*drive_reverse/);
    const noGuard = structuredClone(carScenarios); noGuard[0].assertions = noGuard[0].assertions.filter(a => a.type !== 'mutual-exclusion');
    expect(() => validateSuite(noGuard, carSpec)).toThrow(/simultaneous forward and reverse/);
    const partialGuard = structuredClone(carScenarios); partialGuard[0].assertions.at(-1)!.fromMs = 1;
    expect(() => validateSuite(partialGuard, carSpec)).toThrow(/throughout/);
    const logicalSignal = structuredClone(carScenarios); (logicalSignal[0].assertions[0] as any).signal = 'drive';
    expect(() => validateSuite(logicalSignal, carSpec)).toThrow(/Invalid output signal/);
  });
  it('validates serial configuration, control keys, and bounded ASCII commands', () => {
    for (const data of ['', '🚗', 'x'.repeat(65)]) {
      const spec = structuredClone(carSpec); spec.serial!.controls[0].data = data;
      expect(() => validateSpec(spec)).toThrow(/ASCII/);
      const suite = structuredClone(carScenarios); suite[0].inputs[0] = { atMs: 100, serial: data };
      expect(() => validateSuite(suite, carSpec)).toThrow(/ASCII/);
    }
    const valid = structuredClone(carSpec); valid.serial!.controls[0] = { key: 'ArrowUp', label: 'Forward', data: 'F\n', releaseData: 'X\n' };
    expect(validateSpec(valid)).toEqual(valid);
    const duplicate = structuredClone(carSpec); duplicate.serial!.controls[1].key = 'W';
    expect(() => validateSpec(duplicate)).toThrow(/keys must be unique/);
    const key = structuredClone(carSpec); key.serial!.controls[0].key = 'Enter';
    expect(() => validateSpec(key)).toThrow(/printable character or an arrow key/);
    const baud = structuredClone(carSpec); (baud.serial as any).baudRate = 1200;
    expect(() => validateSpec(baud)).toThrow(/baud/);
    const release = structuredClone(carSpec); release.serial!.controls[0].releaseData = 'é';
    expect(() => validateSpec(release)).toThrow(/ASCII/);
    const controls = structuredClone(carSpec); controls.serial!.controls = [];
    expect(() => validateSpec(controls)).toThrow(/controls/);
  });
  it('requires serial configuration and unambiguous ordered input events', () => {
    const noSerial = structuredClone(carSpec); delete noSerial.serial;
    expect(() => validateSuite(carScenarios, noSerial)).toThrow(/require serial configuration/);
    const mixed = structuredClone(carScenarios); (mixed[0].inputs[0] as any).componentId = 'drive';
    expect(() => validateSuite(mixed, carSpec)).toThrow(/unsupported field/);
    const unordered = structuredClone(carScenarios); unordered[0].inputs.reverse();
    expect(() => validateSuite(unordered, carSpec)).toThrow(/ordered/);
    const simultaneous = structuredClone(carScenarios); simultaneous[0].inputs[1].atMs = 100;
    expect(() => validateSuite(simultaneous, carSpec)).toThrow(/combined/);
  });
  it('generates motor power and H-bridge control wiring without powering a motor from GPIO', () => {
    const circuit = generateCircuit(carSpec, carCandidate.pins);
    expect(circuit.components[0]).toMatchObject({ kind: 'motor', pin: 4, reversePin: 5, template: 'h-bridge-motor' });
    expect(circuit.serial).toEqual(carSpec.serial); expect(circuit.presentation).toBe('vehicle');
    expect(circuit.connections).toEqual(expect.arrayContaining([
      { from: 'uno:D4', to: 'drive-driver:IN1' }, { from: 'uno:D5', to: 'drive-driver:IN2' },
      { from: 'drive-supply:positive', to: 'drive-driver:VM' }, { from: 'drive-supply:negative', to: 'drive-driver:GND' },
      { from: 'uno:GND', to: 'drive-driver:GND' }, { from: 'drive-driver:OUT1', to: 'drive:positive' },
    ]));
    expect(circuit.connections.some(wire => wire.from.startsWith('uno:') && wire.to.startsWith('drive:'))).toBe(false);
    const svg = circuitSvg(circuit);
    expect(svg).toContain('H-BRIDGE'); expect(svg).toContain('external motor supply'); expect(svg).toContain('9600 baud');
    const direct = structuredClone(circuit); direct.connections[0].to = 'drive:positive';
    expect(() => validateCircuit(direct, carSpec)).toThrow(/wiring/);
    const wrongTemplate = structuredClone(circuit); wrongTemplate.components[0].template = 'led-series-resistor';
    expect(() => validateCircuit(wrongTemplate, carSpec)).toThrow(/H-bridge/);
    const missingPower = structuredClone(circuit); missingPower.connections = missingPower.connections.filter(wire => wire.to !== 'drive-driver:VM');
    expect(() => validateCircuit(missingPower, carSpec)).toThrow(/wiring/);
  });
  it('freezes serial controls and presentation along with component meanings', () => {
    const altered = generateCircuit(carSpec, carCandidate.pins); altered.serial!.controls[0].data = 'B';
    expect(carSpec.serial!.controls[0].data).toBe('F');
    expect(() => validateCircuit(altered, carSpec)).toThrow(/frozen serial controls or presentation/);
    const presentation = generateCircuit(carSpec, carCandidate.pins); presentation.presentation = 'circuit';
    expect(() => validateCircuit(presentation, carSpec)).toThrow(/frozen serial controls or presentation/);
    expect(() => validateSpec({ ...airlockSpec, presentation: 'vehicle' })).toThrow(/requires a motor/);
  });
});
