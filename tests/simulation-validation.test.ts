import { describe, expect, it } from 'vitest';
import type { SimulationCandidate, SimulationScenario, SimulationSpec, SimulationStep } from '../shared/simulation-types';
import { validateSimulationCandidate, validateSimulationSpec, validateSimulationSuite } from '../shared/simulation-validation';

const spec: SimulationSpec = {
  goal: 'Simulate a reservoir with adjustable inflow and automatic overflow protection',
  title: 'Reservoir laboratory',
  summary: 'Adjust inflow, open the valve, and observe water volume and overflow protection.',
  assumptions: ['The reservoir has uniform cross section.'],
  controls: [
    { id: 'inflow', label: 'Inflow', type: 'range', min: 0, max: 10, step: 0.1, initial: 0 },
    { id: 'valve', label: 'Valve open', type: 'toggle', initial: false },
    { id: 'flush', label: 'Flush', type: 'button', initial: false },
    { id: 'mode', label: 'Mode', type: 'select', initial: 'manual', options: [{ value: 'manual', label: 'Manual' }, { value: 'auto', label: 'Automatic' }] },
    { id: 'pulse', label: 'Pulse inflow', type: 'key', key: 'p', initial: false },
  ],
  observables: [
    { id: 'volume', label: 'Water volume', type: 'number', unit: 'L' },
    { id: 'overflow', label: 'Overflow detected', type: 'boolean' },
    { id: 'phase', label: 'State', type: 'string' },
  ],
  requirements: [
    { id: 'R1', text: 'Water volume changes in response to the inflow controls.' },
    { id: 'R2', text: 'Automatic mode prevents overflow and reports its state.' },
  ],
};

const candidate: SimulationCandidate = {
  id: 'reservoir-v1',
  rationale: 'Integrate inflow over time and expose water volume.',
  source: 'function createSimulation() { return { update() {}, input() {}, snapshot() { return { volume: 0, overflow: false, phase: "idle" }; }, render() {} }; }',
};

const suite: SimulationScenario[] = [{
  id: 'inflow',
  name: 'Adjust inflow and switch to automatic protection',
  steps: [
    { type: 'assert', id: 'startsEmpty', requirementIds: ['R1'], observable: 'volume', operator: 'eq', value: 0 },
    { type: 'input', controlId: 'inflow', value: 3 },
    { type: 'input', controlId: 'valve', value: true },
    { type: 'input', controlId: 'flush', value: false },
    { type: 'input', controlId: 'mode', value: 'auto' },
    { type: 'input', controlId: 'pulse', value: true },
    { type: 'advance', durationMs: 1000 },
    { type: 'assert', id: 'fills', requirementIds: ['R1'], observable: 'volume', operator: 'approx', value: 3, tolerance: 0.01 },
    { type: 'assert', id: 'protects', requirementIds: ['R2'], observable: 'overflow', operator: 'eq', value: false },
    { type: 'assert', id: 'reports', requirementIds: ['R2'], observable: 'phase', operator: 'ne', value: '' },
  ],
}];

function editSpec(change: (value: SimulationSpec) => void): SimulationSpec {
  const copy = structuredClone(spec);
  change(copy);
  return copy;
}

function editSuite(change: (value: SimulationScenario[]) => void): SimulationScenario[] {
  const copy = structuredClone(suite);
  change(copy);
  return copy;
}

function assertion(override: Partial<Extract<SimulationStep, { type: 'assert' }>>): SimulationStep {
  return { type: 'assert', id: 'check', requirementIds: ['R1', 'R2'], observable: 'volume', operator: 'eq', value: 0, ...override };
}

describe('domain-independent simulation specification', () => {
  it('accepts all control and observable types without hardware components or a domain catalog', () => {
    expect(validateSimulationSpec(spec, spec.goal)).toEqual(spec);
    expect(validateSimulationCandidate(candidate)).toEqual(candidate);
    expect(validateSimulationSuite(suite, spec)).toEqual(suite);
  });

  it('returns independent copies so later model JSON edits cannot alter a frozen contract', () => {
    const validatedSpec = validateSimulationSpec(spec);
    validatedSpec.controls[0].initial = 9;
    expect(spec.controls[0].initial).toBe(0);
    const validatedCandidate = validateSimulationCandidate(candidate);
    validatedCandidate.source = 'changed';
    expect(candidate.source).toContain('function createSimulation');
    const validatedSuite = validateSimulationSuite(suite, spec);
    validatedSuite[0].steps.pop();
    expect(suite[0].steps).toHaveLength(10);
  });

  it('preserves the original goal and rejects additional contract fields', () => {
    expect(() => validateSimulationSpec(spec, 'A different request')).toThrow(/original request/);
    expect(() => validateSimulationSpec({ ...spec, components: [] })).toThrow(/unsupported field components/);
    expect(() => validateSimulationSpec({ ...spec, title: '' })).toThrow(/title/);
    expect(() => validateSimulationSpec({ ...spec, assumptions: [''] })).toThrow(/Assumption/);
  });

  it('permits autonomous simulations without controls', () => {
    const autonomous = { ...spec, controls: [] };
    const autonomousSuite = [{ id: 'evolves', name: 'Evolves over time', steps: [{ type: 'advance', durationMs: 1000 }, assertion({})] }];
    expect(validateSimulationSpec(autonomous)).toEqual(autonomous);
    expect(validateSimulationSuite(autonomousSuite, autonomous)).toEqual(autonomousSuite);
  });

  it('bounds controls, observables, requirements, and their identifiers', () => {
    expect(() => validateSimulationSpec(editSpec(s => { s.controls = Array.from({ length: 21 }, (_, i) => ({ ...s.controls[1], id: `valve${i}` })); }))).toThrow(/Controls/);
    expect(() => validateSimulationSpec({ ...spec, observables: [] })).toThrow(/Observables/);
    expect(() => validateSimulationSpec(editSpec(s => { s.observables = Array.from({ length: 33 }, (_, i) => ({ ...s.observables[0], id: `volume${i}` })); }))).toThrow(/Observables/);
    expect(() => validateSimulationSpec(editSpec(s => { s.requirements = Array.from({ length: 21 }, (_, i) => ({ id: `R${i + 1}`, text: 'Requirement' })); }))).toThrow(/Requirements/);
    for (const id of ['bad id', '0startsWithDigit', 'a'.repeat(65)]) {
      expect(() => validateSimulationSpec(editSpec(s => { s.controls[0].id = id; }))).toThrow(/identifier/);
      expect(() => validateSimulationSpec(editSpec(s => { s.observables[0].id = id; }))).toThrow(/identifier/);
    }
    expect(() => validateSimulationSpec(editSpec(s => { s.controls[1].id = s.controls[0].id; }))).toThrow(/Control IDs must be unique/);
    expect(() => validateSimulationSpec(editSpec(s => { s.observables[1].id = s.observables[0].id; }))).toThrow(/Observable IDs must be unique/);
    expect(() => validateSimulationSpec(editSpec(s => { s.requirements[1].id = 'R3'; }))).toThrow(/consecutive/);
  });

  it.each([
    { min: undefined }, { min: Infinity }, { max: NaN }, { min: 10 }, { min: 11 },
    { initial: 11 }, { initial: -1 }, { initial: '3' }, { initial: null },
    { step: 0 }, { step: -1 }, { step: 11 }, { step: Infinity },
  ])('rejects malformed range controls: %j', patch => {
    expect(() => validateSimulationSpec(editSpec(s => { Object.assign(s.controls[0], patch); }))).toThrow(/Range|range|initial value/);
  });

  it('requires boolean button, key, and toggle state and rejects irrelevant fields', () => {
    for (const index of [1, 2, 4]) {
      expect(() => validateSimulationSpec(editSpec(s => { s.controls[index].initial = 1; }))).toThrow(/boolean/);
    }
    expect(() => validateSimulationSpec(editSpec(s => { s.controls[1].min = 0; }))).toThrow(/unsupported field min/);
    expect(() => validateSimulationSpec(editSpec(s => { s.controls[0].key = 'w'; }))).toThrow(/unsupported field key/);
    expect(() => validateSimulationSpec(editSpec(s => { (s.controls[0] as { type: string }).type = 'motor'; }))).toThrow(/Unsupported control type/);
  });

  it('requires select values to belong to unique validated options', () => {
    expect(() => validateSimulationSpec(editSpec(s => { s.controls[3].initial = 'other'; }))).toThrow(/match an option/);
    expect(() => validateSimulationSpec(editSpec(s => { s.controls[3].options = []; }))).toThrow(/Select options/);
    expect(() => validateSimulationSpec(editSpec(s => { s.controls[3].options![1].value = 'manual'; }))).toThrow(/option values must be unique/);
    expect(() => validateSimulationSpec(editSpec(s => { Object.assign(s.controls[3].options![0], { execute: 'run()' }); }))).toThrow(/unsupported field execute/);
  });

  it.each(['w', 'W', ' ', 'Space', 'ArrowUp', 'arrowdown', '7'])('accepts ordinary keyboard key %s', key => {
    expect(validateSimulationSpec(editSpec(s => { s.controls[4].key = key; })).controls[4].key).toBe(key);
  });

  it.each(['Control', 'Meta', 'Cmd+Q', 'Ctrl+R', 'Enter', 'F1', '\n', ''])('rejects unsupported or shortcut key %j', key => {
    expect(() => validateSimulationSpec(editSpec(s => { s.controls[4].key = key; }))).toThrow(/Keyboard control key/);
  });

  it('rejects case-insensitive keyboard collisions, including Space aliases', () => {
    for (const [first, second] of [['p', 'P'], ['ArrowUp', 'arrowup'], [' ', 'Space']]) {
      expect(() => validateSimulationSpec(editSpec(s => {
        s.controls[4].key = first;
        s.controls.push({ id: 'otherKey', label: 'Other key', type: 'key', key: second, initial: false });
      }))).toThrow(/Keyboard keys must be unique/);
    }
  });

  it('requires bounded JavaScript source declaring the simulation entry point', () => {
    expect(() => validateSimulationCandidate({ ...candidate, source: 'const unrelated = true;' })).toThrow(/function createSimulation/);
    expect(() => validateSimulationCandidate({ ...candidate, source: 'function createSimulation(){}' + ' '.repeat(100000) })).toThrow(/100000/);
    expect(() => validateSimulationCandidate({ ...candidate, tests: 'return true;' })).toThrow(/unsupported field tests/);
  });
});

describe('structured simulation verification validation', () => {
  it('rejects executable predicates and fields at every step type', () => {
    for (const index of [1, 6, 7]) {
      expect(() => validateSimulationSuite(editSuite(s => { Object.assign(s[0].steps[index], { javascript: 'return true;' }); }), spec)).toThrow(/unsupported field javascript/);
    }
    expect(() => validateSimulationSuite(editSuite(s => { s[0].steps.push({ type: 'reset', source: 'run()' } as SimulationStep); }), spec)).toThrow(/unsupported field source/);
    expect(() => validateSimulationSuite(editSuite(s => { (s[0].steps[1] as { type: string }).type = 'execute'; }), spec)).toThrow(/Unsupported scenario step/);
  });

  it.each([
    ['inflow', -1], ['inflow', 11], ['inflow', '3'], ['inflow', Infinity],
    ['valve', 1], ['flush', null], ['pulse', 'p'], ['mode', 'missing'], ['unknown', true],
  ])('rejects invalid input for %s with value %s', (controlId, value) => {
    expect(() => validateSimulationSuite(editSuite(s => { s[0].steps[1] = { type: 'input', controlId: String(controlId), value }; }), spec)).toThrow(/Input value|Unknown control/);
  });

  it.each([0, -1, Infinity, NaN])('rejects advance duration %s', durationMs => {
    expect(() => validateSimulationSuite(editSuite(s => { s[0].steps[6] = { type: 'advance', durationMs }; }), spec)).toThrow(/Advance duration/);
  });

  it('caps scenario count, step count, and cumulative advance duration', () => {
    expect(() => validateSimulationSuite([], spec)).toThrow(/suite/);
    expect(() => validateSimulationSuite(Array.from({ length: 9 }, (_, i) => ({ ...suite[0], id: `scenario${i}` })), spec)).toThrow(/suite/);
    expect(() => validateSimulationSuite(editSuite(s => { s[0].steps = Array.from({ length: 121 }, () => ({ type: 'advance', durationMs: 1 })); }), spec)).toThrow(/Scenario steps/);
    const threeMinutes = editSuite(s => { s[0].steps.splice(6, 1, ...Array.from({ length: 18 }, (): SimulationStep => ({ type: 'advance', durationMs: 10000 }))); });
    expect(validateSimulationSuite(threeMinutes, spec)).toEqual(threeMinutes);
    threeMinutes[0].steps.push({ type: 'advance', durationMs: 1 });
    expect(() => validateSimulationSuite(threeMinutes, spec)).toThrow(/180001 ms across 19 advances.*180000 ms.*inflow: 180001 ms/);
  });

  it('splits long advances before freezing while preserving duration, surrounding inputs, and every assertion', () => {
    const original = editSuite(s => {
      s[0].steps[6] = { type: 'advance', durationMs: 25000.5 };
      s[0].steps.splice(8, 0, { type: 'input', controlId: 'inflow', value: 7 }, { type: 'advance', durationMs: 10001 });
    });
    const before = structuredClone(original);
    const normalized = validateSimulationSuite(original, spec);
    expect(original).toEqual(before);
    expect(normalized[0].steps.slice(6, 9)).toEqual([
      { type: 'advance', durationMs: 10000 }, { type: 'advance', durationMs: 10000 }, { type: 'advance', durationMs: 5000.5 },
    ]);
    const nonAdvances = (scenario: SimulationScenario) => scenario.steps.filter(step => step.type !== 'advance');
    expect(nonAdvances(normalized[0])).toEqual(nonAdvances(original[0]));
    const elapsedAtAssertions = (scenario: SimulationScenario) => {
      let elapsed = 0;
      return scenario.steps.flatMap(step => {
        if (step.type === 'advance') elapsed += step.durationMs;
        return step.type === 'assert' ? [{ id: step.id, elapsed }] : [];
      });
    };
    expect(elapsedAtAssertions(normalized[0])).toEqual(elapsedAtAssertions(original[0]));
    expect(normalized[0].steps.filter(step => step.type === 'advance').every(step => step.durationMs > 0 && step.durationMs <= 10000)).toBe(true);
  });

  it('rejects an excessive total before expansion and reports each scenario’s actual budget usage', () => {
    const tooLong = editSuite(s => { s[0].steps[6] = { type: 'advance', durationMs: Number.MAX_VALUE }; });
    expect(() => validateSimulationSuite(tooLong, spec)).toThrow(/exceeding 180000 ms/);
    const first = editSuite(s => { s[0].steps[6] = { type: 'advance', durationMs: 100000 }; })[0];
    const second = { ...structuredClone(first), id: 'second' };
    expect(() => validateSimulationSuite([first, second], spec)).toThrow(/200000 ms across 2 advances in 2 scenarios.*inflow: 100000 ms.*second: 100000 ms/);
  });

  it('enforces the step limit after expansion and preserves unsupported fields for rejection', () => {
    const expanded = editSuite(s => {
      s[0].steps[6] = { type: 'advance', durationMs: 10001 };
      s[0].steps.push(...Array.from({ length: 110 }, (): SimulationStep => ({ type: 'reset' })));
    });
    expect(() => validateSimulationSuite(expanded, spec)).toThrow(/expands to 121 steps.*120/);
    const executable = editSuite(s => { s[0].steps[6] = { type: 'advance', durationMs: 10001, javascript: 'run()' } as SimulationStep; });
    expect(() => validateSimulationSuite(executable, spec)).toThrow(/unsupported field javascript/);
  });

  it('rejects duplicate scenario IDs and duplicate assertion IDs within a scenario', () => {
    expect(() => validateSimulationSuite([suite[0], suite[0]], spec)).toThrow(/Scenario IDs must be unique/);
    expect(() => validateSimulationSuite(editSuite(s => { s[0].steps.push(s[0].steps[7]); }), spec)).toThrow(/Assertion IDs within each scenario/);
    const repeatedCheckNames = [suite[0], { ...suite[0], id: 'secondScenario' }];
    expect(validateSimulationSuite(repeatedCheckNames, spec)).toEqual(repeatedCheckNames);
  });

  it.each([
    { observable: 'missing' }, { requirementIds: ['R3'] }, { requirementIds: [] }, { requirementIds: ['R1', 'R1'] },
    { observable: 'volume', value: '3', operator: 'eq' }, { observable: 'volume', value: Infinity, operator: 'eq' },
    { observable: 'overflow', value: null, operator: 'eq' }, { observable: 'phase', value: false, operator: 'eq' },
    { observable: 'overflow', value: false, operator: 'gt' }, { observable: 'phase', value: 'ready', operator: 'lt' },
    { operator: 'approx', tolerance: 0 }, { operator: 'approx', tolerance: -1 }, { operator: 'approx', tolerance: Infinity },
    { operator: 'approx', tolerance: undefined }, { operator: 'eq', tolerance: 1 }, { operator: 'javascript' },
  ])('rejects invalid structured assertion: %j', patch => {
    expect(() => validateSimulationSuite(editSuite(s => { s[0].steps[7] = assertion(patch as Partial<Extract<SimulationStep, { type: 'assert' }>>); }), spec)).toThrow();
  });

  it('requires meaningful requirement coverage after interaction or time advances', () => {
    const onlyStartup = [{ id: 'startup', name: 'Initial state only', steps: [assertion({}), { type: 'advance', durationMs: 1000 }] }];
    expect(() => validateSimulationSuite(onlyStartup, { ...spec, controls: [] })).toThrow(/after advancing/);
    const startupCoverageOnly = [{ id: 'startup', name: 'One requirement only at startup', steps: [assertion({}), { type: 'advance', durationMs: 1000 }, assertion({ id: 'later', requirementIds: ['R1'] })] }];
    expect(() => validateSimulationSuite(startupCoverageOnly, { ...spec, controls: [] })).toThrow(/Uncovered requirement.*R2/);
    expect(() => validateSimulationSuite(editSuite(s => { s[0].steps = s[0].steps.filter(step => step.type !== 'assert'); }), spec)).toThrow(/at least one assertion/);
  });

  it('requires every exposed control to be exercised before an assertion', () => {
    expect(() => validateSimulationSuite(editSuite(s => { s[0].steps = s[0].steps.filter(step => step.type !== 'input' || step.controlId !== 'pulse'); }), spec)).toThrow(/exercise control pulse/);
    const uncheckedInput = editSuite(s => {
      s[0].steps = s[0].steps.filter(step => step.type !== 'input' || step.controlId !== 'pulse');
      s[0].steps.push({ type: 'input', controlId: 'pulse', value: true });
    });
    expect(() => validateSimulationSuite(uncheckedInput, spec)).toThrow(/exercise control pulse/);
  });

  it('does not count reset-discarded inputs or pre-reset time as behavioral coverage', () => {
    const resetInputs = editSuite(s => { s[0].steps.splice(6, 0, { type: 'reset' }); });
    expect(() => validateSimulationSuite(resetInputs, spec)).toThrow(/exercise control inflow/);
    const resetTime = [{ id: 'reset', name: 'Only asserts reset state', steps: [{ type: 'advance', durationMs: 1000 }, { type: 'reset' }, assertion({})] }];
    expect(() => validateSimulationSuite(resetTime, { ...spec, controls: [] })).toThrow(/after advancing/);
  });
});
