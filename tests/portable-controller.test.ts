import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SimulationAgents } from '../server/simulation-agents';
import { DEFAULT_CRUSOE_MODEL } from '../server/agents';
import type { SimulationSpec } from '../shared/simulation-types';
import { composeControllerSimulation, createPortableController, emitControllerCpp, emitControllerJavaScript, validatePortableController, type PortableControllerProgram, type PortableExpression, type PortableOperation } from '../shared/portable-controller';
import { validateSimulationCandidate } from '../shared/simulation-validation';
import { buildSimulationDocument } from '../shared/simulation-runtime';

const ref = (id: string): PortableExpression => ({ ref: id });
const op = (op: PortableOperation, ...args: PortableExpression[]): PortableExpression => ({ op, args });
const thermostat: PortableControllerProgram = {
  version: 1, name: 'Temperature protection', requiredCapabilities: ['analog-input', 'digital-output'],
  assumptions: ['A conditioned analog temperature sensor and externally powered relay driver are required.'],
  inputs: [
    { id: 'temperature', label: 'Temperature', type: 'number', initial: 20, hardware: { kind: 'analog-input', min: -20, max: 100, unit: '°C', component: 'Analog temperature sensor' } },
    { id: 'enabled', label: 'Enabled', type: 'boolean', initial: true, hardware: { kind: 'serial' } },
    { id: 'acknowledge', label: 'Acknowledge', type: 'boolean', initial: false, hardware: { kind: 'serial' } },
  ],
  state: [{ id: 'seconds', type: 'number', initial: 0 }, { id: 'ackCount', type: 'number', initial: 0 }],
  outputs: [{ id: 'cooling', label: 'Cooling relay', type: 'boolean', initial: false, hardware: { kind: 'digital-output', component: 'Relay driver with flyback protection' } }],
  onInput: { acknowledge: [{ if: ref('acknowledge'), then: [{ set: 'ackCount', value: op('add', ref('ackCount'), 1) }] }] },
  step: [{ set: 'seconds', value: op('add', ref('seconds'), { dt: true }) }],
  update: [
    { if: op('not', ref('enabled')), then: [{ set: 'cooling', value: false }], else: [
      { if: op('gt', ref('temperature'), 30), then: [{ set: 'cooling', value: true }] },
      { if: op('lt', ref('temperature'), 25), then: [{ set: 'cooling', value: false }] },
    ] },
  ],
};
const environment = `function createEnvironment(controller) {
  let simulatedTemperature = 20;
  return {
    reset() { simulatedTemperature = 20; },
    input(id, value) { if (id === 'temperature') simulatedTemperature = value; },
    step(dt) { simulatedTemperature += (controller.get('cooling') ? -2 : 1) * dt; },
    sensors() { return { temperature: simulatedTemperature }; },
    snapshot() { return { temperature: -999, cooling: 'fake', environmentalTemperature: simulatedTemperature }; },
    draw(ctx, width, height) { ctx.fillStyle = controller.get('cooling') ? 'blue' : 'orange'; ctx.fillRect(0, 0, width, height); }
  };
}`;
function model(program = thermostat, source = environment) {
  return new Function(`${composeControllerSimulation(program, source)}; return createSimulation();`)();
}

describe('portable authoritative controller', () => {
  it('runs immediate derived outputs, hysteresis, repeated events, time and reset in one program', () => {
    const controller = createPortableController(thermostat);
    expect(controller.get('cooling')).toBe(false);
    controller.input('temperature', 35);
    expect(controller.get('cooling')).toBe(true);
    controller.input('temperature', 27);
    expect(controller.get('cooling')).toBe(true);
    controller.input('enabled', false);
    expect(controller.get('cooling')).toBe(false);
    controller.input('acknowledge', true);
    controller.input('acknowledge', true);
    expect(controller.get('ackCount')).toBe(2);
    controller.step(0.1);
    expect(controller.get('seconds')).toBe(Math.fround(0.1));
    const copy = controller.snapshot(); copy.seconds = 99;
    expect(controller.get('seconds')).toBe(Math.fround(0.1));
    controller.reset();
    expect(controller.snapshot()).toMatchObject({ seconds: 0, ackCount: 0, cooling: false, enabled: true });
  });

  it('preserves the exact controller state over conflicting visual observables and feeds only physical sensors', () => {
    const simulation = model();
    simulation.reset();
    expect(simulation.snapshot()).toMatchObject({ temperature: 20, cooling: false, environmentalTemperature: 20 });
    simulation.input('temperature', 35);
    expect(simulation.snapshot().cooling).toBe(true);
    simulation.step(1);
    expect(simulation.snapshot()).toMatchObject({ temperature: 33, cooling: true, seconds: 1, environmentalTemperature: 33 });
    const wrong = model(thermostat, environment.replace('return { temperature: simulatedTemperature };', 'return { enabled: false };'));
    expect(() => wrong.reset()).toThrow(/non-sensor input: enabled/);
    const mutate = model(thermostat, environment.replace('simulatedTemperature = 20; },', "controller.input('enabled', false); },"));
    expect(() => mutate.reset()).toThrow(/input is not a function/);
  });

  it('recomposes source from the same controller IR at validation and rendering boundaries', () => {
    const candidate = validateSimulationCandidate({ id: 'portable', source: 'function createSimulation(){ throw new Error("unrelated firmware approximation") }', controller: thermostat, environmentSource: environment, rationale: 'Separate thermal physics from the shared thermostat.' });
    expect(candidate.source).toBe(composeControllerSimulation(thermostat, environment));
    const document = buildSimulationDocument({ spec: { goal: 'Thermostat', title: 'Thermostat', summary: 'Cooling relay', assumptions: [], controls: [], observables: [], requirements: [] }, candidate: { ...candidate, source: 'tampered source' } });
    expect(document).not.toContain('tampered source');
    expect(document).toContain('createPortableController');
    expect(validateSimulationCandidate({ id: 'legacy', source: 'function createSimulation(){}', rationale: 'Existing saved simulation.' }).controller).toBeUndefined();
  });

  it('uses deterministic binary32 arithmetic and defined zero-division semantics', () => {
    const program: PortableControllerProgram = { version: 1, name: 'Arithmetic', inputs: [], state: [], outputs: [{ id: 'result', label: 'Result', type: 'number', initial: 0, hardware: { kind: 'serial' } }], step: [], update: [{ set: 'result', value: op('add', op('div', 1, 0), op('add', 0.1, 0.2)) }] };
    expect(createPortableController(program).get('result')).toBe(Math.fround(Math.fround(0.1) + Math.fround(0.2)));
    program.update = [{ set: 'result', value: op('mul', 3e38, 3e38) }];
    expect(createPortableController(program).get('result')).toBe(0);
  });

  it('implements sine/cosine in radians accurately over wrapped control phases', () => {
    const program: PortableControllerProgram = { version: 1, name: 'Oscillator', inputs: [{ id: 'phase', label: 'Phase', type: 'number', initial: 0, hardware: { kind: 'serial' } }], state: [], step: [],
      outputs: [{ id: 'sine', label: 'Sine', type: 'number', initial: 0, hardware: { kind: 'serial' } }, { id: 'cosine', label: 'Cosine', type: 'number', initial: 1, hardware: { kind: 'serial' } }],
      update: [{ set: 'sine', value: op('sin', ref('phase')) }, { set: 'cosine', value: op('cos', ref('phase')) }] };
    const controller = createPortableController(program);
    for (let index = -32; index <= 32; index++) {
      const phase = Math.fround(index * Math.PI / 16);
      controller.input('phase', phase);
      expect(Math.abs(Number(controller.get('sine')) - Math.sin(phase))).toBeLessThan(1e-6);
      expect(Math.abs(Number(controller.get('cosine')) - Math.cos(phase))).toBeLessThan(1e-6);
    }
  });

  it('rejects unknown operations, type errors, writes to inputs, nonfinite values and unbounded programs', () => {
    const change = (fn: (program: PortableControllerProgram) => void) => { const program = structuredClone(thermostat); fn(program); return program; };
    expect(() => validatePortableController(change(p => { p.step = [{ set: 'temperature', value: 30 }]; }))).toThrow(/state or output/);
    expect(() => validatePortableController(change(p => { p.update = [{ set: 'cooling', value: 1 }]; }))).toThrow(/type mismatch/);
    expect(() => validatePortableController(change(p => { p.step = [{ set: 'seconds', value: ref('missing') }]; }))).toThrow(/Unknown controller reference/);
    expect(() => validatePortableController(change(p => { p.state[0].initial = Infinity; }))).toThrow(/finite binary32/);
    expect(() => validatePortableController(change(p => { p.state[0].id = 'constructor'; }))).toThrow(/identifier/);
    expect(() => validatePortableController(change(p => { p.inputs[0].hardware.kind = 'i2c' as 'analog-input'; }))).toThrow(/device-specific driver/);
    expect(() => validatePortableController(change(p => { p.step = Array.from({ length: 257 }, () => ({ set: 'seconds', value: 0 })); }))).toThrow(/256/);
    expect(() => validatePortableController(change(p => { let expression: PortableExpression = 1; for (let i = 0; i < 25; i++) expression = op('neg', expression); p.step = [{ set: 'seconds', value: expression }]; }))).toThrow(/complexity limit/);
    expect(() => validatePortableController(change(p => { p.update = [{ set: 'cooling', value: op('and', true, 4) }]; }))).toThrow(/boolean operands/);
    expect(() => createPortableController(thermostat).input('temperature', true)).toThrow(/Invalid controller input/);
  });

  it('declares missing driver requirements instead of inventing a GPIO implementation', () => {
    const unsupported = { ...thermostat, requiredCapabilities: ['driver:i2c:bme280', 'transport:wifi'] };
    expect(validatePortableController(unsupported).requiredCapabilities).toEqual(unsupported.requiredCapabilities);
    const cloned = validatePortableController(thermostat); cloned.inputs[0].label = 'Changed';
    expect(thermostat.inputs[0].label).toBe('Temperature');
  });

  it('compiles independently with the real native C++ compiler and replays the identical JS trace', () => {
    const directory = mkdtempSync(join(tmpdir(), 'portable-controller-parity-'));
    try {
      writeFileSync(join(directory, 'controller.h'), emitControllerCpp(thermostat));
      const commands: Array<{ input?: [string, number | boolean]; dt?: number; reset?: true }> = [
        {}, { input: ['temperature', 35] }, { dt: 0.1 }, { input: ['temperature', 27] },
        { input: ['acknowledge', true] }, { input: ['acknowledge', true] }, { dt: 0.25 },
        { input: ['temperature', 24] }, { input: ['enabled', false] }, { reset: true },
        ...Array.from({ length: 60 }, () => ({ dt: 1 / 60 })),
      ];
      const ids = [...thermostat.inputs, ...thermostat.state, ...thermostat.outputs].map(variable => variable.id);
      const cpp = `#include <stdio.h>\n#include "controller.h"\nint main() { PortableController controller;\n${commands.map(command => `${command.reset ? 'controller.reset();' : command.input ? `controller.input(${JSON.stringify(command.input[0])}, ${Number(command.input[1])});` : command.dt !== undefined ? `controller.step(${command.dt.toExponential(17)});` : ''}\nprintf("${ids.map(() => '%.9g').join(' ')}\\n", ${ids.map(id => `controller.get(${JSON.stringify(id)})`).join(', ')});`).join('\n')}\n}`;
      writeFileSync(join(directory, 'trace.cpp'), cpp);
      execFileSync('c++', ['-std=c++11', '-O0', '-ffp-contract=off', join(directory, 'trace.cpp'), '-o', join(directory, 'trace')], { timeout: 30000 });
      const native = execFileSync(join(directory, 'trace'), { encoding: 'utf8' }).trim().split('\n').map(line => line.split(' ').map(Number));
      const controller = createPortableController(thermostat);
      commands.forEach((command, index) => {
        if (command.reset) controller.reset();
        if (command.input) controller.input(...command.input);
        if (command.dt !== undefined) controller.step(command.dt);
        ids.forEach((id, column) => expect(Math.fround(native[index][column]), `trace ${index} signal ${id}`).toBe(Number(controller.get(id))));
      });
      expect(readFileSync(join(directory, 'controller.h'), 'utf8')).not.toMatch(/Arduino|new |malloc|String/);
      expect(emitControllerJavaScript(thermostat)).not.toContain('createEnvironment');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('matches native C++ for every operation across fractional, negative, zero and large inputs', () => {
    const expressions: [PortableOperation, PortableExpression][] = [
      ...(['add', 'sub', 'mul', 'div', 'mod', 'min', 'max', 'lt', 'lte', 'gt', 'gte', 'eq', 'ne'] as PortableOperation[]).map(operation => [operation, op(operation, ref('a'), ref('b'))] as [PortableOperation, PortableExpression]),
      ...(['abs', 'floor', 'round', 'neg', 'sin', 'cos'] as PortableOperation[]).map(operation => [operation, op(operation, ref('a'))] as [PortableOperation, PortableExpression]),
      ['clamp', op('clamp', ref('a'), -2, 3)],
      ['and', op('and', ref('armed'), op('gt', ref('a'), 0))],
      ['or', op('or', ref('armed'), op('gt', ref('a'), 0))],
      ['not', op('not', ref('armed'))],
      ['select', op('select', ref('armed'), ref('a'), ref('b'))],
    ];
    const boolean = new Set(['lt', 'lte', 'gt', 'gte', 'eq', 'ne', 'and', 'or', 'not']);
    const program: PortableControllerProgram = {
      version: 1, name: 'Every portable operation', state: [], step: [],
      inputs: [
        { id: 'a', label: 'A', type: 'number', initial: 0, hardware: { kind: 'serial' } },
        { id: 'b', label: 'B', type: 'number', initial: 0, hardware: { kind: 'serial' } },
        { id: 'armed', label: 'Armed', type: 'boolean', initial: false, hardware: { kind: 'serial' } },
      ],
      outputs: expressions.map(([name]) => ({ id: name, label: name, type: boolean.has(name) ? 'boolean' : 'number', initial: boolean.has(name) ? false : 0, hardware: { kind: 'serial' } })),
      update: expressions.map(([name, expression]) => ({ set: name, value: expression })),
    };
    const values = [[0, 0], [0.1, 0.2], [-2.5, 3], [-1.5, -2], [1e-37, 3], [3e38, 3e38], [10000001, 0.5], [-7, 2], [7, -2]];
    const directory = mkdtempSync(join(tmpdir(), 'portable-ops-parity-'));
    try {
      writeFileSync(join(directory, 'controller.h'), emitControllerCpp(program));
      writeFileSync(join(directory, 'ops.cpp'), `#include <stdio.h>\n#include "controller.h"\nint main(){ PortableController c;\n${values.map(([a, b], index) => `c.input("a", ${a.toExponential(17)}); c.input("b", ${b.toExponential(17)}); c.input("armed", ${index % 2}); printf("${expressions.map(() => '%.9g').join(' ')}\\n", ${expressions.map(([name]) => `c.get("${name}")`).join(',')});`).join('\n')}\n}`);
      execFileSync('c++', ['-std=c++11', '-O0', '-ffp-contract=off', join(directory, 'ops.cpp'), '-o', join(directory, 'ops')], { timeout: 30000 });
      const native = execFileSync(join(directory, 'ops'), { encoding: 'utf8' }).trim().split('\n').map(line => line.split(' ').map(Number));
      const controller = createPortableController(program);
      values.forEach(([a, b], row) => {
        controller.input('a', a); controller.input('b', b); controller.input('armed', !!(row % 2));
        expressions.forEach(([name], column) => expect(Math.fround(native[row][column]) || 0, `${name} for ${a}, ${b}`).toBe(Number(controller.get(name)) || 0));
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not create C++ identifier collisions for hyphenated and underscore signal IDs', () => {
    const program = structuredClone(thermostat);
    program.state.push({ id: 'a-b', type: 'number', initial: 1 }, { id: 'a_dash_b', type: 'number', initial: 2 });
    expect(emitControllerCpp(program)).toContain('v_61_2d_62');
    expect(emitControllerCpp(program)).toContain('v_61_5f_64_61_73_68_5f_62');
  });
});


describe('portable generation contract handling', () => {
  const spec: SimulationSpec = { goal: 'Control a remote indicator', title: 'Indicator', summary: 'A serial switch drives an LED.', assumptions: [],
    controls: [{ id: 'enable', label: 'Enable', type: 'toggle', initial: false }], observables: [{ id: 'active', label: 'Active', type: 'boolean' }],
    requirements: [{ id: 'R1', text: 'Reset deactivates the output.' }, { id: 'R2', text: 'The output immediately follows enable.' }] };
  const scenarios = [{ id: 'toggle', name: 'Initial, active and released state', steps: [
    { type: 'advance', durationMs: 1 }, { type: 'assert', id: 'initial', requirementIds: ['R1'], observable: 'active', operator: 'eq', value: 0 },
    { type: 'input', controlId: 'enable', value: 1 }, { type: 'assert', id: 'active', requirementIds: ['R2'], observable: 'active', operator: 'eq', value: 1 },
    { type: 'input', controlId: 'enable', value: 0 }, { type: 'assert', id: 'released', requirementIds: ['R2'], observable: 'active', operator: 'eq', value: 0 },
  ] }];
  function agents(outputs: unknown[]) {
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: DEFAULT_CRUSOE_MODEL, type: 'chat', supported_parameters: [] }] })));
    for (const output of outputs) fetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] })));
    return new SimulationAgents({ apiKey: 'test-portable-key', fetch });
  }
  it('normalizes numeric boolean literals before freezing a typed independent suite and its audit', async () => {
    const calculations = scenarios[0].steps.filter(step => step.type === 'assert').map(step => ({ scenarioId: 'toggle', assertionId: step.id, expectedValue: step.value, basis: 'The boolean output follows the input, initially false.' }));
    const service = agents([{ scenarios }, { calculations, scenarios }]);
    const suite = await service.verify(spec);
    expect(suite[0].steps.filter(step => step.type === 'assert').map(step => step.value)).toEqual([false, true, false]);
    expect(suite[0].steps.filter(step => step.type === 'input').map(step => step.value)).toEqual([true, false]);
  });
  it('removes only identical redundant state/output declarations and composes canonical source', async () => {
    const program: PortableControllerProgram = { version: 1, name: 'Remote indicator', inputs: [{ id: 'enable', label: 'Enable', type: 'boolean', initial: false, hardware: { kind: 'serial' } }],
      state: [{ id: 'active', type: 'boolean', initial: false }], outputs: [{ id: 'active', label: 'Active', type: 'boolean', initial: false, hardware: { kind: 'digital-output' } }],
      step: [], update: [{ set: 'active', value: { ref: 'enable' } }] };
    const environmentSource = 'function createEnvironment(controller){return {reset(){},input(){},step(){},snapshot(){return {};},draw(ctx,w,h){ctx.fillRect(0,0,w,h);}};}';
    const candidate = await agents([{ controller: program, environmentSource, rationale: 'One portable switch controller.' }]).build(spec, [], { attempt: 1, draft: true });
    expect(candidate.controller?.state).toEqual([]);
    expect(candidate.source).toBe(composeControllerSimulation({ ...program, state: [] }, environmentSource));
  });
});
