/**
 * Portable controller IR v1. This program is the single controller source for
 * the simulator and exported firmware. Environment JavaScript contains only
 * physical models and drawing; it is never translated into firmware.
 *
 * Numeric values and every arithmetic result use IEEE-754 binary32, including
 * on AVR where double is 32-bit. Nonfinite results and division by zero become
 * zero in both backends. There are no loops, pointers, imports or dynamic code.
 */
export type PortableValue = number | boolean;
export type PortableType = 'number' | 'boolean';
export type PortableOperation = 'add' | 'sub' | 'mul' | 'div' | 'mod' | 'min' | 'max' | 'clamp' | 'abs' | 'floor' | 'round' | 'neg' | 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'ne' | 'and' | 'or' | 'not' | 'select' | 'sin' | 'cos';
export type PortableExpression = PortableValue | { ref: string } | { dt: true } | { op: PortableOperation; args: PortableExpression[] };
export type PortableStatement = { set: string; value: PortableExpression } | { if: PortableExpression; then: PortableStatement[]; else?: PortableStatement[] };
export interface PortableVariable { id: string; type: PortableType; initial: PortableValue }
export interface PortableHardwareMetadata {
  component?: string;
  description?: string;
  min?: number;
  max?: number;
  unit?: string;
  voltage?: number;
}
export interface PortableInput extends PortableVariable {
  label: string;
  key?: string;
  hardware: PortableHardwareMetadata & { kind: 'serial' | 'digital-input' | 'analog-input' };
}
export interface PortableOutput extends PortableVariable {
  label: string;
  hardware: PortableHardwareMetadata & { kind: 'serial' | 'digital-output' | 'pwm-output' };
}
export interface PortableControllerProgram {
  version: 1;
  name: string;
  requiredCapabilities?: string[];
  assumptions?: string[];
  inputs: PortableInput[];
  state: PortableVariable[];
  outputs: PortableOutput[];
  onInput?: Record<string, PortableStatement[]>;
  step: PortableStatement[];
  update: PortableStatement[];
}
export interface PortableController {
  reset(): void;
  input(id: string, value: PortableValue): void;
  step(dt: number): void;
  get(id: string): PortableValue | undefined;
  snapshot(): Record<string, PortableValue>;
}
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ARITY: Record<PortableOperation, number> = {
  add: 2, sub: 2, mul: 2, div: 2, mod: 2, min: 2, max: 2, clamp: 3,
  abs: 1, floor: 1, round: 1, neg: 1, lt: 2, lte: 2, gt: 2, gte: 2,
  eq: 2, ne: 2, and: 2, or: 2, not: 1, select: 3, sin: 1, cos: 1,
};
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unsupported field ${key}`);
}
function text(value: unknown, label: string, max = 1000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be nonempty text of at most ${max} characters`);
}
function finite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new Error(`${label} must be a finite binary32 number`);
}
function list(value: unknown, label: string, max: number, min = 0): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max || value.length < min) throw new Error(`${label} must contain ${min}–${max} items`);
}

/** Strict validation is also the code-generation security boundary. */
export function validatePortableController(value: unknown): PortableControllerProgram {
  const program = object(value, 'Portable controller');
  keys(program, ['version', 'name', 'requiredCapabilities', 'assumptions', 'inputs', 'state', 'outputs', 'onInput', 'step', 'update'], 'Portable controller');
  if (program.version !== 1) throw new Error('Portable controller version must be 1');
  text(program.name, 'Controller name', 150);
  for (const field of ['requiredCapabilities', 'assumptions'] as const) {
    if (program[field] !== undefined) {
      list(program[field], `Controller ${field}`, 32);
      for (const item of program[field]) text(item, `Controller ${field} entry`, 1000);
    }
  }
  const types = new Map<string, PortableType>();
  const writable = new Set<string>();
  for (const group of ['inputs', 'state', 'outputs'] as const) {
    list(program[group], `Controller ${group}`, group === 'state' ? 64 : 32, group === 'outputs' ? 1 : 0);
    for (const item of program[group]) {
      const variable = object(item, `Controller ${group} variable`);
      keys(variable, ['id', 'type', 'initial', ...(group === 'state' ? [] : ['label', 'hardware']), ...(group === 'inputs' ? ['key'] : [])], 'Controller variable');
      if (typeof variable.id !== 'string' || !IDENTIFIER.test(variable.id) || ['__proto__', 'constructor', 'prototype'].includes(variable.id)) throw new Error('Controller variable ID must be a simple nonreserved identifier');
      if (types.has(variable.id)) throw new Error(`Controller variable IDs must be unique: ${variable.id}`);
      if (variable.type !== 'number' && variable.type !== 'boolean') throw new Error(`Controller variable ${variable.id} must have number or boolean type, received ${String(variable.type)}. String labels belong in environment.snapshot(), derived from a differently named numeric/boolean controller signal.`);
      if (typeof variable.initial !== variable.type) throw new Error(`Controller variable ${variable.id} initial value must match its type`);
      if (variable.type === 'number') finite(variable.initial, `Initial value ${variable.id}`);
      types.set(variable.id, variable.type);
      if (group !== 'inputs') writable.add(variable.id);
      if (group !== 'state') {
        text(variable.label, `Label for ${variable.id}`, 150);
        const hardware = object(variable.hardware, `Hardware requirements for ${variable.id}`);
        keys(hardware, ['kind', 'component', 'description', 'min', 'max', 'unit', 'voltage'], 'Hardware requirement');
        const kinds = group === 'inputs' ? ['serial', 'digital-input', 'analog-input'] : ['serial', 'digital-output', 'pwm-output'];
        if (!kinds.includes(String(hardware.kind))) throw new Error(`Unsupported hardware interface for ${variable.id}: ${String(hardware.kind)}. This adapter supports serial, GPIO and analog/PWM only; a device-specific driver is required for other interfaces.`);
        if (String(hardware.kind).startsWith('digital') && variable.type !== 'boolean') throw new Error(`Digital signal ${variable.id} must have boolean type`);
        if (['analog-input', 'pwm-output'].includes(String(hardware.kind)) && variable.type !== 'number') throw new Error(`Analog/PWM signal ${variable.id} must have number type`);
        for (const field of ['component', 'description', 'unit']) if (hardware[field] !== undefined) text(hardware[field], `${variable.id} ${field}`, field === 'unit' ? 40 : 1000);
        for (const field of ['min', 'max', 'voltage']) if (hardware[field] !== undefined) finite(hardware[field], `${variable.id} ${field}`);
        if (hardware.min !== undefined && hardware.max !== undefined && Number(hardware.min) >= Number(hardware.max)) throw new Error(`Signal ${variable.id} maximum must exceed its minimum`);
        if (hardware.voltage !== undefined && Number(hardware.voltage) <= 0) throw new Error(`Signal ${variable.id} voltage must be positive`);
        if (variable.key !== undefined) {
          text(variable.key, `Keyboard key for ${variable.id}`, 20);
          if (!/^(?:[\x20-\x7e]|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space)$/i.test(variable.key)) throw new Error(`Unsupported keyboard key for ${variable.id}`);
          if (hardware.kind !== 'serial' || variable.type !== 'boolean') throw new Error('Keyboard signals must be boolean serial inputs');
        }
      }
    }
  }
  let nodes = 0;
  const visit = (depth: number) => { if (++nodes > 4096 || depth > 24) throw new Error('Controller exceeds the 4096-node or 24-level complexity limit'); };
  function expression(value: unknown, depth = 0): PortableType {
    visit(depth);
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') { finite(value, 'Controller literal'); return 'number'; }
    const expr = object(value, 'Controller expression');
    if ('ref' in expr) {
      keys(expr, ['ref'], 'Reference expression');
      const type = types.get(String(expr.ref));
      if (!type) throw new Error(`Unknown controller reference: ${String(expr.ref)}`);
      return type;
    }
    if ('dt' in expr) {
      keys(expr, ['dt'], 'Time expression');
      if (expr.dt !== true) throw new Error('Time expression must be {dt:true}');
      return 'number';
    }
    keys(expr, ['op', 'args'], 'Operation expression');
    if (typeof expr.op !== 'string' || !Object.hasOwn(ARITY, expr.op)) throw new Error(`Unknown controller operation: ${String(expr.op)}`);
    const op = expr.op as PortableOperation;
    list(expr.args, `Arguments to ${op}`, ARITY[op], ARITY[op]);
    const args = expr.args.map(arg => expression(arg, depth + 1));
    if (op === 'select') {
      if (args[0] !== 'boolean' || args[1] !== args[2]) throw new Error('select requires a boolean condition and same-type alternatives');
      return args[1];
    }
    if (op === 'eq' || op === 'ne') {
      if (args[0] !== args[1]) throw new Error(`${op} operands must have the same type`);
      return 'boolean';
    }
    if (op === 'and' || op === 'or' || op === 'not') {
      if (args.some(type => type !== 'boolean')) throw new Error(`${op} requires boolean operands`);
      return 'boolean';
    }
    if (args.some(type => type !== 'number')) throw new Error(`${op} requires numeric operands`);
    return ['lt', 'lte', 'gt', 'gte'].includes(op) ? 'boolean' : 'number';
  }
  function statements(value: unknown, depth = 0) {
    list(value, 'Controller statements', 256);
    for (const item of value) {
      visit(depth);
      const statement = object(item, 'Controller statement');
      if ('set' in statement) {
        keys(statement, ['set', 'value'], 'Assignment');
        if (!writable.has(String(statement.set))) throw new Error(`Controller assignment target must be a state or output variable: ${String(statement.set)}`);
        if (expression(statement.value, depth + 1) !== types.get(String(statement.set))) throw new Error(`Assignment type mismatch for ${String(statement.set)}`);
      } else {
        keys(statement, ['if', 'then', 'else'], 'Conditional');
        if (expression(statement.if, depth + 1) !== 'boolean') throw new Error('Conditional expression must be boolean');
        statements(statement.then, depth + 1);
        if (statement.else !== undefined) statements(statement.else, depth + 1);
      }
    }
  }
  statements(program.step);
  statements(program.update);
  if (program.onInput !== undefined) {
    const handlers = object(program.onInput, 'Input handlers');
    const inputs = new Set((program.inputs as unknown as PortableInput[]).map(input => input.id));
    for (const [id, handler] of Object.entries(handlers)) {
      if (!inputs.has(id)) throw new Error(`Unknown controller input handler: ${id}`);
      statements(handler);
    }
  }
  return structuredClone(value) as PortableControllerProgram;
}

const cppName = (id: string): string => `v_${Array.from(id).map(character => character.charCodeAt(0).toString(16)).join('_')}`;

function emitExpression(expression: PortableExpression, language: 'js' | 'cpp'): string {
  const cpp = language === 'cpp';
  if (typeof expression === 'boolean') return String(expression);
  if (typeof expression === 'number') return cpp ? `${Math.fround(expression).toExponential(9)}f` : `q(${JSON.stringify(expression)})`;
  if ('ref' in expression) return cpp ? cppName(expression.ref) : `v[${JSON.stringify(expression.ref)}]`;
  if ('dt' in expression) return 'dt';
  const args = expression.args.map(arg => emitExpression(arg, language));
  const [a, b, c] = args;
  const binary: Partial<Record<PortableOperation, string>> = { add: '+', sub: '-', mul: '*', lt: '<', lte: '<=', gt: '>', gte: '>=', eq: cpp ? '==' : '===', ne: cpp ? '!=' : '!==', and: '&&', or: '||' };
  const symbol = binary[expression.op];
  if (symbol) return ['add', 'sub', 'mul'].includes(expression.op) ? `q((${a}) ${symbol} (${b}))` : `((${a}) ${symbol} (${b}))`;
  switch (expression.op) {
    case 'div': return `q((${b}) == 0 ? 0 : (${a}) / (${b}))`;
    case 'mod': return cpp ? `q((${b}) == 0 ? 0 : fmodf(${a}, ${b}))` : `q((${b}) === 0 ? 0 : (${a}) % (${b}))`;
    case 'min': return `q(${cpp ? 'fminf' : 'Math.min'}(${a}, ${b}))`;
    case 'max': return `q(${cpp ? 'fmaxf' : 'Math.max'}(${a}, ${b}))`;
    case 'clamp': return `q(${cpp ? 'fminf' : 'Math.min'}(${c}, ${cpp ? 'fmaxf' : 'Math.max'}(${b}, ${a})))`;
    case 'abs': return `q(${cpp ? 'fabsf' : 'Math.abs'}(${a}))`;
    case 'floor': return `q(${cpp ? 'floorf' : 'Math.floor'}(${a}))`;
    case 'round': return `q(${cpp ? 'floorf' : 'Math.floor'}(q((${a}) + 0.5)))`;
    case 'neg': return `q(-(${a}))`;
    case 'sin': return `pcSin(${a})`;
    case 'cos': return `pcSin(q((${a}) + q(1.5707963267948966)))`;
    case 'not': return `(!(${a}))`;
    case 'select': return `((${a}) ? (${b}) : (${c}))`;
    default: throw new Error(`Unsupported operation ${expression.op}`);
  }
}
function emitStatements(statements: PortableStatement[], language: 'js' | 'cpp', indent = '    '): string {
  return statements.map(statement => {
    if ('set' in statement) {
      const target = language === 'cpp' ? cppName(statement.set) : `v[${JSON.stringify(statement.set)}]`;
      return `${indent}${target} = ${emitExpression(statement.value, language)};`;
    }
    return `${indent}if (${emitExpression(statement.if, language)}) {\n${emitStatements(statement.then, language, indent + '  ')}\n${indent}}${statement.else ? ` else {\n${emitStatements(statement.else, language, indent + '  ')}\n${indent}}` : ''}`;
  }).join('\n');
}
/** Shared polynomial sequence avoids different libm sin/cos implementations.
 * Range reduction and every Taylor term are binary32 in both backends.
 * Accurate to approximately 1e-6 for moderate-angle controls; large-angle
 * resolution remains limited by binary32, so applications should wrap phase.
 */
function sineHelper(language: 'js' | 'cpp'): string {
  const cpp = language === 'cpp';
  let polynomial = 'q(-2.505210838544172e-8)'; // -1/11!
  for (const coefficient of [1 / 362880, -1 / 5040, 1 / 120, -1 / 6, 1]) polynomial = `q(q(${coefficient}) + q(x2 * ${polynomial}))`;
  return `${cpp ? 'static float pcSin(float value)' : 'const pcSin = (value) =>'} {
    ${cpp ? 'float' : 'let'} x = q(${cpp ? 'fmodf(value, q(6.283185307179586))' : 'value % q(6.283185307179586)'});
    if (x > q(3.141592653589793)) x = q(x - q(6.283185307179586));
    if (x < q(-3.141592653589793)) x = q(x + q(6.283185307179586));
    if (x > q(1.5707963267948966)) x = q(q(3.141592653589793) - x);
    if (x < q(-1.5707963267948966)) x = q(q(-3.141592653589793) - x);
    ${cpp ? 'const float' : 'const'} x2 = q(x * x);
    return q(x * ${polynomial});
  }${cpp ? '' : ';'}`;
}
/** Deterministic generated JS; there is no second hand-written controller. */
export function emitControllerJavaScript(value: PortableControllerProgram): string {
  const program = validatePortableController(value);
  const variables = [...program.inputs, ...program.state, ...program.outputs];
  return `function createPortableController() {
  const v = Object.create(null);
  const q = value => { const result = Math.fround(value); return Number.isFinite(result) ? result : 0; };
  ${sineHelper('js')}
  const update = (dt) => {\n${emitStatements(program.update, 'js')}\n  };
  const reset = () => {\n${variables.map(variable => `    v[${JSON.stringify(variable.id)}] = ${emitExpression(variable.initial, 'js')};`).join('\n')}\n    update(0);\n  };
  const input = (id, value) => {
    switch (id) {
${program.inputs.map(input => `      case ${JSON.stringify(input.id)}:
        if (typeof value !== ${JSON.stringify(input.type)}${input.type === 'number' ? ' || !Number.isFinite(value)' : ''}) throw new Error('Invalid controller input: ' + id);
        v[id] = ${input.type === 'number' ? 'q(value)' : 'value'};
        { const dt = 0;\n${emitStatements(program.onInput?.[input.id] ?? [], 'js', '          ')}\n        }
        update(0); return;`).join('\n')}
      default: throw new Error('Unknown controller input: ' + id);
    }
  };
  const step = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Controller step must be finite and nonnegative');
    const dt = q(seconds);\n${emitStatements(program.step, 'js')}\n    update(dt);
  };
  reset();
  return Object.freeze({ reset, input, step, get: id => v[id], snapshot: () => ({ ...v }) });
}`;
}
/** Safe to instantiate: only validated IR is emitted, never model-supplied JS. */
export function createPortableController(value: PortableControllerProgram): PortableController {
  return new Function(`${emitControllerJavaScript(value)}; return createPortableController();`)() as PortableController;
}
/** Static C++ class for Arduino and standalone C++11. No heap or platform APIs. */
export function emitControllerCpp(value: PortableControllerProgram): string {
  const program = validatePortableController(value);
  const variables = [...program.inputs, ...program.state, ...program.outputs];
  return `// Generated from portable-controller.json. Do not edit this file independently.
#ifndef SIMULATION_LAB_PORTABLE_CONTROLLER_H
#define SIMULATION_LAB_PORTABLE_CONTROLLER_H
#include <math.h>
#include <string.h>
class PortableController {
  static float q(float value) { return isfinite(value) ? value : 0.0f; }
  ${sineHelper('cpp')}
${variables.map(variable => `  ${variable.type === 'boolean' ? 'bool' : 'float'} ${cppName(variable.id)};`).join('\n')}
  void update(float dt) {\n${emitStatements(program.update, 'cpp')}\n  }
public:
  PortableController() { reset(); }
  void reset() {\n${variables.map(variable => `    ${cppName(variable.id)} = ${emitExpression(variable.initial, 'cpp')};`).join('\n')}\n    update(0.0f);\n  }
  bool input(const char* id, float value) {
    if (!isfinite(value)) return false;
${program.inputs.map(input => `    if (strcmp(id, ${JSON.stringify(input.id)}) == 0) {
      ${cppName(input.id)} = ${input.type === 'boolean' ? '(value != 0.0f)' : 'q(value)'};
      { const float dt = 0.0f;\n${emitStatements(program.onInput?.[input.id] ?? [], 'cpp', '        ')}\n      }
      update(0.0f); return true;
    }`).join('\n')}
    return false;
  }
  void step(float seconds) {
    if (!isfinite(seconds) || seconds < 0.0f) return;
    const float dt = q(seconds);\n${emitStatements(program.step, 'cpp')}\n    update(dt);
  }
  float get(const char* id) const {
${variables.map(variable => `    if (strcmp(id, ${JSON.stringify(variable.id)}) == 0) return ${variable.type === 'boolean' ? `(${cppName(variable.id)} ? 1.0f : 0.0f)` : `${cppName(variable.id)}`};`).join('\n')}
    return 0.0f;
  }
};
#endif
`;
}

/**
 * Environment sees only a read-only controller view. Sensor feedback is limited
 * to declared physical input signals; it cannot override host/keyboard commands.
 * Controller-owned inputs, state and outputs always win in the public snapshot.
 */
export function composeControllerSimulation(value: PortableControllerProgram, environmentSource: string): string {
  const program = validatePortableController(value);
  if (typeof environmentSource !== 'string' || !environmentSource.trim() || environmentSource.length > 80000) throw new Error('Environment source must contain 1–80000 characters');
  if (!/\bfunction\s+createEnvironment\s*\(/.test(environmentSource)) throw new Error('Environment source must declare function createEnvironment(controller)');
  const sensors = program.inputs.filter(input => input.hardware.kind !== 'serial').map(input => input.id);
  return `// Shared controller generated from portable IR; visual environment is separate.
const createProjectEnvironment = (function () {\n${environmentSource}\n; return createEnvironment; })();
function createSimulation() {
${emitControllerJavaScript(program)}
  const controller = createPortableController();
  const readonlyController = Object.freeze({ get: controller.get, snapshot: controller.snapshot });
  const environment = createProjectEnvironment(readonlyController);
  for (const method of ['reset', 'step', 'input', 'snapshot', 'draw']) if (!environment || typeof environment[method] !== 'function') throw new Error('createEnvironment must return ' + method + '()');
  const inputs = ${JSON.stringify(program.inputs.map(input => input.id))};
  const sensors = ${JSON.stringify(sensors)};
  const feedback = () => {
    if (typeof environment.sensors !== 'function') return;
    const readings = environment.sensors();
    if (!readings || typeof readings !== 'object' || Array.isArray(readings)) throw new Error('Environment sensors() must return an object');
    for (const [id, value] of Object.entries(readings)) {
      if (!sensors.includes(id)) throw new Error('Environment attempted to drive a non-sensor input: ' + id);
      const normalized = typeof value === 'number' ? Math.fround(value) : value;
      if (controller.get(id) !== normalized) controller.input(id, normalized);
    }
  };
  return {
    reset() { controller.reset(); environment.reset(); feedback(); },
    input(id, value) { if (inputs.includes(id)) controller.input(id, value); environment.input(id, value); feedback(); },
    step(dt) { environment.step(dt); feedback(); controller.step(dt); },
    snapshot() { return { ...environment.snapshot(), ...controller.snapshot() }; },
    draw(ctx, width, height) { environment.draw(ctx, width, height); }
  };
}`;
}
