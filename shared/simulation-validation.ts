import { composeControllerSimulation, validatePortableController } from './portable-controller';
import type {
  SimulationCandidate,
  SimulationControl,
  SimulationScenario,
  SimulationSpec,
} from './simulation-types';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const KEY = /^(?:[\x20-\x7e]|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space)$/i;
const MAX_ADVANCE_MS = 10000;
const MAX_SUITE_ADVANCE_MS = 180000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}: unsupported field ${key}`);
  }
}

function text(value: unknown, label: string, max = 5000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} must be nonempty text (max ${max} characters)`);
  }
}

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${label} must be a simple identifier (max 64 characters)`);
}

function finite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
}

function list(value: unknown, label: string, min: number, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${label} must contain ${min}–${max} items`);
}

function unique(values: unknown[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function controlValue(value: unknown, control: SimulationControl, label: string): void {
  if (control.type === 'range') {
    finite(value, label);
    if (value < control.min! || value > control.max!) throw new Error(`${label} must be within control ${control.id}'s range`);
  } else if (control.type === 'select') {
    if (typeof value !== 'string' || !control.options!.some(option => option.value === value)) {
      throw new Error(`${label} must match an option for control ${control.id}`);
    }
  } else if (typeof value !== 'boolean') {
    throw new Error(`${label} must be boolean for control ${control.id}`);
  }
}

/** Validate and copy the model's domain-independent contract before the controller freezes it. */
export function validateSimulationSpec(input: unknown, goal?: string): SimulationSpec {
  const spec = record(input, 'Simulation specification');
  keys(spec, ['goal', 'title', 'summary', 'assumptions', 'controls', 'observables', 'requirements'], 'Simulation specification');
  text(spec.goal, 'Goal', 24000);
  if (goal !== undefined && spec.goal !== goal) throw new Error('Simulation goal must match the original request');
  text(spec.title, 'Simulation title', 150);
  text(spec.summary, 'Simulation summary', 3000);
  list(spec.assumptions, 'Assumptions', 0, 30);
  spec.assumptions.forEach(item => text(item, 'Assumption', 2000));

  list(spec.controls, 'Controls', 0, 20);
  const controlIds: string[] = [];
  const keyboardKeys: string[] = [];
  for (const item of spec.controls) {
    const control = record(item, 'Control');
    const common = ['id', 'label', 'type', 'initial'];
    id(control.id, 'Control ID');
    text(control.label, 'Control label', 150);
    controlIds.push(control.id);
    switch (control.type) {
      case 'range':
        keys(control, [...common, 'min', 'max', 'step'], 'Range control');
        finite(control.min, 'Range minimum');
        finite(control.max, 'Range maximum');
        if (control.max <= control.min || !Number.isFinite(control.max - control.min)) throw new Error('Range maximum must exceed its minimum by a finite amount');
        if (control.step !== undefined) {
          finite(control.step, 'Range step');
          if (control.step <= 0 || control.step > control.max - control.min) throw new Error('Range step must be positive and no greater than its range');
        }
        break;
      case 'toggle':
      case 'button':
        keys(control, common, 'Boolean control');
        break;
      case 'select': {
        keys(control, [...common, 'options'], 'Select control');
        list(control.options, 'Select options', 1, 30);
        const values = control.options.map(item => {
          const option = record(item, 'Select option');
          keys(option, ['value', 'label'], 'Select option');
          text(option.value, 'Select option value', 200);
          text(option.label, 'Select option label', 150);
          return option.value;
        });
        unique(values, 'Select option values');
        break;
      }
      case 'key':
        keys(control, [...common, 'key'], 'Keyboard control');
        if (typeof control.key !== 'string' || !KEY.test(control.key)) throw new Error('Keyboard control key must be one printable character, an arrow key, or Space; modifier shortcuts are not supported');
        keyboardKeys.push(control.key.toLowerCase() === 'space' ? ' ' : control.key.toLowerCase());
        break;
      default:
        throw new Error(`Unsupported control type: ${String(control.type)}`);
    }
    controlValue(control.initial, control as unknown as SimulationControl, 'Control initial value');
  }
  unique(controlIds, 'Control IDs');
  unique(keyboardKeys, 'Keyboard keys');

  list(spec.observables, 'Observables', 1, 32);
  const observableIds = spec.observables.map(item => {
    const observable = record(item, 'Observable');
    keys(observable, ['id', 'label', 'type', 'unit'], 'Observable');
    id(observable.id, 'Observable ID');
    text(observable.label, 'Observable label', 150);
    if (!['number', 'boolean', 'string'].includes(observable.type as string)) throw new Error(`Unsupported observable type: ${String(observable.type)}`);
    if (observable.unit !== undefined) text(observable.unit, 'Observable unit', 40);
    return observable.id;
  });
  unique(observableIds, 'Observable IDs');

  list(spec.requirements, 'Requirements', 1, 20);
  spec.requirements.forEach((item, index) => {
    const requirement = record(item, 'Requirement');
    keys(requirement, ['id', 'text'], 'Requirement');
    if (requirement.id !== `R${index + 1}`) throw new Error('Requirement IDs must be consecutive: R1, R2, …');
    text(requirement.text, 'Requirement text', 3000);
  });
  return structuredClone(input) as SimulationSpec;
}

/** Runtime compilation validates JavaScript syntax and the returned simulation API. */
export function validateSimulationCandidate(input: unknown): SimulationCandidate {
  const candidate = record(input, 'Simulation candidate');
  keys(candidate, ['id', 'source', 'rationale', 'controller', 'environmentSource', 'hardwareUnavailableReason'], 'Simulation candidate');
  id(candidate.id, 'Candidate ID');
  if (candidate.controller !== undefined || candidate.environmentSource !== undefined) {
    const controller = validatePortableController(candidate.controller);
    text(candidate.environmentSource, 'Environment source', 80000);
    if (candidate.hardwareUnavailableReason !== undefined) throw new Error('A portable controller candidate cannot claim a separate simulation-only reason; declare its requiredCapabilities instead');
    const source = composeControllerSimulation(controller, candidate.environmentSource);
    text(source, 'Simulation source', 160000);
    text(candidate.rationale, 'Candidate rationale', 6000);
    return { id: candidate.id, source, rationale: candidate.rationale, controller, environmentSource: candidate.environmentSource };
  }
  if (candidate.hardwareUnavailableReason !== undefined) text(candidate.hardwareUnavailableReason, 'Hardware unavailable reason', 3000);
  text(candidate.source, 'Simulation source', 100000);
  if (!/\bfunction\s+createSimulation\s*\(/.test(candidate.source)) throw new Error('Simulation source must declare function createSimulation');
  text(candidate.rationale, 'Candidate rationale', 6000);
  return structuredClone(input) as SimulationCandidate;
}

/** Split long intervals without changing their duration, order, inputs, or assertions. */
function normalizeAdvances(input: unknown): Record<string, unknown>[] {
  list(input, 'Simulation scenario suite', 1, 8);
  const scenarios = input.map(item => record(item, 'Simulation scenario'));
  let totalMs = 0;
  let totalAdvances = 0;
  const breakdown: string[] = [];
  for (const scenario of scenarios) {
    list(scenario.steps, 'Scenario steps', 1, 120);
    let scenarioMs = 0;
    let advances = 0;
    for (const item of scenario.steps) {
      const step = record(item, 'Scenario step');
      if (step.type !== 'advance') continue;
      finite(step.durationMs, 'Advance duration');
      if (step.durationMs <= 0) throw new Error('Advance duration must be greater than 0');
      scenarioMs += step.durationMs;
      advances++;
    }
    totalMs += scenarioMs;
    totalAdvances += advances;
    breakdown.push(`${String(scenario.id)}: ${scenarioMs} ms (${advances} advances)`);
  }
  // Check the entire budget before allocating chunks, including pathological
  // finite values that would otherwise expand into an enormous array.
  if (totalMs > MAX_SUITE_ADVANCE_MS) {
    throw new Error(`Total simulated advance is ${totalMs} ms across ${totalAdvances} advances in ${scenarios.length} scenarios, exceeding ${MAX_SUITE_ADVANCE_MS} ms. Per scenario: ${breakdown.join('; ')}`);
  }
  return scenarios.map(scenario => {
    const steps = (scenario.steps as unknown[]).flatMap(item => {
      const step = item as Record<string, unknown>;
      if (step.type !== 'advance' || (step.durationMs as number) <= MAX_ADVANCE_MS) return [step];
      const duration = step.durationMs as number;
      const count = Math.ceil(duration / MAX_ADVANCE_MS);
      return Array.from({ length: count }, (_, index) => ({
        ...step,
        durationMs: index === count - 1 ? duration - (count - 1) * MAX_ADVANCE_MS : MAX_ADVANCE_MS,
      }));
    });
    if (steps.length > 120) throw new Error(`Scenario ${String(scenario.id)} expands to ${steps.length} steps after splitting long advances; at most 120 steps are allowed`);
    return { ...scenario, steps };
  });
}

/** Verify structured scenarios without ever executing model-provided test code. */
export function validateSimulationSuite(input: unknown, spec: SimulationSpec): SimulationScenario[] {
  const normalized = normalizeAdvances(input);
  const controls = new Map(spec.controls.map(control => [control.id, control]));
  const observables = new Map(spec.observables.map(observable => [observable.id, observable]));
  const requirements = new Set(spec.requirements.map(requirement => requirement.id));
  const coveredRequirements = new Set<string>();
  const exercisedControls = new Set<string>();
  const scenarioIds: string[] = [];

  for (const item of normalized) {
    const scenario = record(item, 'Simulation scenario');
    keys(scenario, ['id', 'name', 'steps'], 'Simulation scenario');
    id(scenario.id, 'Scenario ID');
    scenarioIds.push(scenario.id);
    text(scenario.name, 'Scenario name', 200);
    list(scenario.steps, 'Scenario steps', 1, 120);
    const assertionIds: string[] = [];
    const pendingControls = new Set<string>();
    let changedSinceReset = false;
    let advancedSinceReset = false;
    let hasAssertionAfterAdvance = false;

    for (const item of scenario.steps) {
      const step = record(item, 'Scenario step');
      switch (step.type) {
        case 'input': {
          keys(step, ['type', 'controlId', 'value'], 'Input step');
          const control = controls.get(step.controlId as string);
          if (!control) throw new Error(`Unknown control: ${String(step.controlId)}`);
          controlValue(step.value, control, `Input value for ${control.id}`);
          pendingControls.add(control.id);
          changedSinceReset = true;
          break;
        }
        case 'advance':
          keys(step, ['type', 'durationMs'], 'Advance step');
          finite(step.durationMs, 'Advance duration');
          if (step.durationMs <= 0 || step.durationMs > MAX_ADVANCE_MS) throw new Error('Advance duration must be greater than 0 and at most 10000 ms');
          changedSinceReset = true;
          advancedSinceReset = true;
          break;
        case 'reset':
          keys(step, ['type'], 'Reset step');
          changedSinceReset = false;
          advancedSinceReset = false;
          pendingControls.clear();
          break;
        case 'assert': {
          keys(step, ['type', 'id', 'requirementIds', 'observable', 'operator', 'value', 'tolerance'], 'Assertion step');
          id(step.id, 'Assertion ID');
          assertionIds.push(step.id);
          list(step.requirementIds, 'Assertion requirement links', 1, requirements.size);
          unique(step.requirementIds, 'Assertion requirement links');
          for (const requirement of step.requirementIds) {
            if (!requirements.has(requirement as string)) throw new Error(`Unknown requirement: ${String(requirement)}`);
            if (changedSinceReset) coveredRequirements.add(requirement as string);
          }
          const observable = observables.get(step.observable as string);
          if (!observable) throw new Error(`Unknown observable: ${String(step.observable)}`);
          if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'approx'].includes(step.operator as string)) throw new Error(`Unsupported assertion operator: ${String(step.operator)}`);
          if (typeof step.value !== observable.type) throw new Error(`Assertion value for ${observable.id} must be ${observable.type}`);
          if (observable.type === 'number') finite(step.value, 'Numeric assertion value');
          if (observable.type !== 'number' && step.operator !== 'eq' && step.operator !== 'ne') throw new Error('Numeric assertion operators require a number observable');
          if (step.operator === 'approx') {
            finite(step.tolerance, 'Approximate assertion tolerance');
            if (step.tolerance <= 0) throw new Error('Approximate assertion tolerance must be positive');
          } else if (step.tolerance !== undefined) {
            throw new Error('Tolerance is allowed only for approx assertions');
          }
          if (advancedSinceReset) hasAssertionAfterAdvance = true;
          for (const control of pendingControls) exercisedControls.add(control);
          break;
        }
        default:
          throw new Error(`Unsupported scenario step type: ${String(step.type)}`);
      }
    }
    if (assertionIds.length === 0) throw new Error(`Scenario ${scenario.id} must include at least one assertion`);
    unique(assertionIds, 'Assertion IDs within each scenario');
    if (!hasAssertionAfterAdvance) throw new Error(`Scenario ${scenario.id} must assert behavior after advancing simulation time`);
  }

  unique(scenarioIds, 'Scenario IDs');
  for (const requirement of requirements) {
    if (!coveredRequirements.has(requirement)) throw new Error(`Uncovered requirement after input or advance: ${requirement}`);
  }
  for (const control of controls.keys()) {
    if (!exercisedControls.has(control)) throw new Error(`Suite must exercise control ${control} and assert its behavior before reset`);
  }
  return structuredClone(normalized) as unknown as SimulationScenario[];
}
