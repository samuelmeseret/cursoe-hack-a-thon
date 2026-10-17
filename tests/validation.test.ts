import { describe, expect, it } from 'vitest';
import { airlockScenarios, airlockSpec, goodAirlockCandidate } from '../shared/fixtures';
import { generateCircuit, validateCircuit } from '../shared/circuit';
import { validateCandidate, validateSpec, validateSuite } from '../shared/validation';

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
