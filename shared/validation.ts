import type { Assertion, Candidate, RunSpec, Scenario } from './types';
import { outputSignals } from './components';

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const specKeys = ['goal', 'assumptions', 'components', 'requirements', 'serial', 'presentation'];
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unsupported field ${key}`);
}
function text(value: unknown, label: string, max = 5000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be nonempty text (max ${max} characters)`);
}
function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label} must be a simple identifier`);
}
function number(value: unknown, label: string, min: number, max: number, integer = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}; received ${typeof value === 'number' ? String(value) : typeof value}`);
  }
}
function list(value: unknown, label: string, min: number, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${label} must contain ${min}–${max} items`);
}
function unique(values: unknown[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}
function serialData(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[\x00-\x7f]{1,64}$/.test(value)) throw new Error(`${label} must contain 1–64 ASCII characters`);
}

/** Validate untrusted JSON before it becomes the frozen logical contract. */
export function validateSpec(input: unknown): RunSpec {
  const spec = record(input, 'Specification');
  keys(spec, specKeys, 'Specification');
  text(spec.goal, 'Goal');
  list(spec.assumptions, 'Assumptions', 0, 30);
  spec.assumptions.forEach((item) => text(item, 'Assumption', 2000));
  list(spec.components, 'Components', 1, 12);
  const components = spec.components.map((item) => {
    const c = record(item, 'Component');
    keys(c, ['id', 'kind', 'label', 'meaning'], 'Component');
    id(c.id, 'Component ID');
    if (c.kind !== 'button' && c.kind !== 'led' && c.kind !== 'motor') throw new Error(`Unsupported component kind: ${c.kind}`);
    text(c.label, 'Component label', 100);
    text(c.meaning, 'Component meaning', 2000);
    return c;
  });
  unique(components.map((c) => c.id), 'Component IDs');
  const componentIds = new Set(components.map(c => c.id));
  const generatedIds = components.flatMap(c => c.kind === 'led' ? [`${c.id}-resistor`] : c.kind === 'motor' ? [`${c.id}-driver`, `${c.id}-supply`, `${c.id}_forward`, `${c.id}_reverse`] : []);
  if (componentIds.has('uno') || generatedIds.some(generated => componentIds.has(generated))) throw new Error('Component IDs collide with the Uno or a generated component or signal ID');
  if (components.filter((c) => c.kind === 'button').length > 4) throw new Error('At most four buttons are supported');
  if (components.filter((c) => c.kind === 'led').length > 6) throw new Error('At most six LEDs are supported');
  if (components.filter((c) => c.kind === 'motor').length > 2) throw new Error('At most two motors are supported');
  if (components.reduce((count, c) => count + (c.kind === 'motor' ? 2 : 1), 0) > 12) throw new Error('Components require more than the twelve available D2–D13 pins');
  if (!components.some((c) => c.kind === 'led' || c.kind === 'motor')) throw new Error('At least one observable LED or motor output is required');
  if (spec.presentation !== undefined && spec.presentation !== 'circuit' && spec.presentation !== 'vehicle') throw new Error('Presentation must be circuit or vehicle');
  if (spec.presentation === 'vehicle' && !components.some(c => c.kind === 'motor')) throw new Error('Vehicle presentation requires a motor');
  if (spec.serial !== undefined) {
    const serial = record(spec.serial, 'Serial configuration');
    keys(serial, ['baudRate', 'controls'], 'Serial configuration');
    if (serial.baudRate !== 9600 && serial.baudRate !== 115200) throw new Error('Serial baud rate must be 9600 or 115200');
    list(serial.controls, 'Serial controls', 1, 12);
    const controlKeys: string[] = [];
    for (const item of serial.controls) {
      const control = record(item, 'Serial control');
      keys(control, ['key', 'label', 'data', 'releaseData'], 'Serial control');
      if (typeof control.key !== 'string' || !/^(?:[\x20-\x7e]|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(control.key)) throw new Error('Serial control key must be a printable character or an arrow key');
      controlKeys.push(control.key.toLowerCase());
      text(control.label, 'Serial control label', 100);
      serialData(control.data, 'Serial control data');
      if (control.releaseData !== undefined) serialData(control.releaseData, 'Serial control release data');
    }
    unique(controlKeys, 'Serial control keys');
  }
  list(spec.requirements, 'Requirements', 1, 30);
  const requirements = spec.requirements.map((item) => {
    const r = record(item, 'Requirement');
    keys(r, ['id', 'text'], 'Requirement');
    id(r.id, 'Requirement ID');
    text(r.text, 'Requirement text', 3000);
    return r;
  });
  unique(requirements.map((r) => r.id), 'Requirement IDs');
  return structuredClone(input) as RunSpec;
}

export function validateCandidate(spec: RunSpec, input: unknown): Candidate {
  const candidate = record(input, 'Candidate');
  keys(candidate, ['id', 'source', 'pins', 'rationale'], 'Candidate');
  id(candidate.id, 'Candidate ID');
  text(candidate.source, 'Arduino source', 64000);
  text(candidate.rationale, 'Candidate rationale', 6000);
  list(candidate.pins, 'Pin assignments', spec.components.length, spec.components.length);
  const pins = candidate.pins.map((item) => {
    const p = record(item, 'Pin assignment');
    keys(p, ['componentId', 'pin', 'reversePin'], 'Pin assignment');
    const component = spec.components.find((c) => c.id === p.componentId);
    if (!component) throw new Error(`Unknown component: ${p.componentId}`);
    number(p.pin, 'Uno pin', 2, 13, true);
    if (component.kind === 'motor') number(p.reversePin, 'Motor reverse pin', 2, 13, true);
    else if (p.reversePin !== undefined) throw new Error('Only motors may have a reverse pin');
    return p;
  });
  unique(pins.map((p) => p.componentId), 'Assigned components');
  unique(pins.flatMap((p) => p.reversePin === undefined ? [p.pin] : [p.pin, p.reversePin]), 'Assigned pins');
  return structuredClone(input) as Candidate;
}

/** Pure structured assertions only: no JavaScript or model-controlled predicates. */
export function validateSuite(input: unknown, spec: RunSpec): Scenario[] {
  list(input, 'Scenario suite', 1, 32);
  const requirements = new Set(spec.requirements.map((r) => r.id));
  const signals = new Set(outputSignals(spec.components));
  const motors = spec.components.filter(c => c.kind === 'motor');
  const buttons = new Set(spec.components.filter((c) => c.kind === 'button').map((c) => c.id));
  const covered = new Set<string>();
  const checks: string[] = [];
  const scenarios: string[] = [];
  const useful = new Set<string>();
  let totalDuration = 0;
  for (const item of input) {
    const s = record(item, 'Scenario');
    keys(s, ['id', 'name', 'durationMs', 'inputs', 'assertions'], 'Scenario');
    id(s.id, 'Scenario ID');
    scenarios.push(s.id);
    text(s.name, 'Scenario name', 150);
    number(s.durationMs, 'Scenario duration', 1, 15000);
    totalDuration += s.durationMs;
    list(s.inputs, 'Scenario inputs', 0, 300);
    let lastAt = -1;
    const inputTimes = new Set<string>();
    for (const item of s.inputs) {
      const event = record(item, 'Scenario input');
      number(event.atMs, 'Input time', 0, s.durationMs);
      if (event.atMs < lastAt) throw new Error('Scenario inputs must be ordered by time');
      lastAt = event.atMs;
      if ('serial' in event) {
        keys(event, ['atMs', 'serial'], 'Serial input');
        if (!spec.serial) throw new Error('Serial inputs require serial configuration');
        serialData(event.serial, 'Serial input data');
        const key = `${event.atMs}:serial`;
        if (inputTimes.has(key)) throw new Error('Serial inputs at one time must be combined into one command');
        inputTimes.add(key);
        continue;
      }
      keys(event, ['atMs', 'componentId', 'pressed'], 'Button input');
      if (!buttons.has(event.componentId as string)) throw new Error(`Invalid button input: ${event.componentId}`);
      if (typeof event.pressed !== 'boolean') throw new Error('Button pressed must be boolean');
      const key = `${event.atMs}:${event.componentId}`;
      if (inputTimes.has(key)) throw new Error('A button cannot have conflicting inputs at one time');
      inputTimes.add(key);
    }
    list(s.assertions, 'Scenario assertions', 1, 100);
    for (const item of s.assertions) {
      const a = record(item, 'Assertion');
      const common = ['id', 'type', 'requirementIds', 'fromMs', 'toMs'];
      const allowed: Record<string, string[]> = {
        level: ['signal', 'value', 'driven'], transition: ['signal', 'edge', 'minCount', 'maxCount'],
        duration: ['signal', 'value', 'minMs', 'maxMs', 'minCount'], 'mutual-exclusion': ['signals'],
        deadtime: ['signals', 'minMs', 'minCount'],
      };
      if (typeof a.type !== 'string' || !allowed[a.type]) throw new Error(`Unsupported assertion type: ${a.type}`);
      keys(a, [...common, ...allowed[a.type]], 'Assertion');
      id(a.id, 'Assertion ID');
      checks.push(`${s.id}/${a.id}`);
      list(a.requirementIds, 'Assertion requirement links', 1, spec.requirements.length);
      unique(a.requirementIds, 'Requirement links');
      for (const requirement of a.requirementIds) {
        if (!requirements.has(requirement as string)) throw new Error(`Unknown requirement: ${requirement}`);
        covered.add(requirement as string);
      }
      number(a.fromMs, `Assertion start (${s.id}/${a.id})`, 0, s.durationMs);
      number(a.toMs, `Assertion end (${s.id}/${a.id})`, a.fromMs, s.durationMs);
      if (a.type === 'mutual-exclusion' || a.type === 'deadtime') {
        list(a.signals, 'Grouped output signals', a.type === 'deadtime' ? 1 : 2, 10);
        unique(a.signals, 'Grouped output signals');
        for (const signal of a.signals) if (!signals.has(signal as string)) throw new Error(`Invalid output signal: ${signal}`);
        if (a.type === 'deadtime') {
          number(a.minMs, 'Minimum closed interval', 0.001, s.durationMs);
          number(a.minCount, 'Minimum closed interval count', 1, 10000, true);
        }
      } else {
        if (!signals.has(a.signal as string)) throw new Error(`Invalid output signal: ${a.signal}`);
        if (a.type === 'level' || a.type === 'duration') {
          if (a.value !== 0 && a.value !== 1) throw new Error('Signal level must be 0 or 1');
        }
        if (a.type === 'level') {
          if (a.driven !== undefined && typeof a.driven !== 'boolean') throw new Error('Driven must be boolean');
          if (a.value === 1 && a.toMs > a.fromMs) useful.add(a.signal as string);
        }
        if (a.type === 'transition') {
          if (a.edge !== 'rising' && a.edge !== 'falling') throw new Error('Transition edge must be rising or falling');
          number(a.minCount, 'Minimum transition count', 0, 10000, true);
          if (a.maxCount !== undefined) number(a.maxCount, 'Maximum transition count', a.minCount, 10000, true);
          if (a.minCount > 0 && a.edge === 'rising') useful.add(a.signal as string);
        }
        if (a.type === 'duration') {
          number(a.minMs, 'Minimum signal duration', 0.001, s.durationMs);
          number(a.maxMs, 'Maximum signal duration', a.minMs, 120000);
          number(a.minCount, 'Minimum duration interval count', 1, 10000, true);
          if (a.value === 1) useful.add(a.signal as string);
        }
      }
    }
    for (const motor of motors) {
      const pair = [`${motor.id}_forward`, `${motor.id}_reverse`];
      if (!s.assertions.some(item => {
        const assertion = item as Record<string, unknown>;
        const grouped = assertion.signals;
        return assertion.type === 'mutual-exclusion' && assertion.fromMs === 0 && assertion.toMs === s.durationMs
          && Array.isArray(grouped) && pair.every(signal => grouped.includes(signal));
      })) throw new Error(`Scenario ${s.id} must forbid simultaneous forward and reverse signals for motor ${motor.id} throughout the scenario`);
    }
  }
  unique(scenarios, 'Scenario IDs');
  unique(checks, 'Assertion IDs within each scenario');
  if (totalDuration > 120000) throw new Error('Total simulated duration exceeds 120 seconds');
  for (const requirement of requirements) if (!covered.has(requirement)) throw new Error(`Uncovered requirement: ${requirement}`);
  for (const signal of signals) if (!useful.has(signal)) throw new Error(`Suite never requires useful HIGH output from ${signal}`);
  return structuredClone(input) as Scenario[];
}

export function expectedCheckIds(scenarios: Scenario[]): string[] {
  return scenarios.flatMap((scenario) => scenario.assertions.map((assertion: Assertion) => `${scenario.id}/${assertion.id}`));
}
