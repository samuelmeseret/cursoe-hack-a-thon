import { describe, expect, it } from 'vitest';
import { generateCircuit } from '../shared/circuit';
import { evaluateAssertion } from '../shared/assertions';
import { FLASH_BYTES, SRAM_BYTES, parseHex, runScenario, UnoMachine } from '../shared/simulator';
import { runSimulation } from '../server/simulation';
import type { Assertion, RunSpec, Scenario, TracePoint } from '../shared/types';

const spec: RunSpec = {
  goal: 'Exercise two outputs', assumptions: [],
  components: [
    { id: 'a', kind: 'led', label: 'A', meaning: 'A on' },
    { id: 'b', kind: 'led', label: 'B', meaning: 'B on' },
  ], requirements: [{ id: 'R1', text: 'No overlapping output signals' }],
};
const circuit = generateCircuit(spec, [{ componentId: 'a', pin: 8 }, { componentId: 'b', pin: 9 }]);
function record(address: number, type: number, data: number[]): string {
  const bytes = [data.length, address >> 8, address & 255, type, ...data];
  bytes.push((-bytes.reduce((a, b) => a + b, 0)) & 255);
  return `:${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
function hex(words: number[]): string {
  return `${record(0, 0, words.flatMap((word) => [word & 255, word >> 8]))}\n:00000001FF\n`;
}
const exclusive: Assertion = { id: 'exclusive', type: 'mutual-exclusion', signals: ['a', 'b'], requirementIds: ['R1'], fromMs: 0, toMs: 1 };
const scenario: Scenario = { id: 'test', name: 'Observe every transition', durationMs: 1, inputs: [], assertions: [exclusive] };

describe('real AVR instructions and GPIO capture', () => {
  it('uses Uno flash/SRAM sizes and records mode changes even at unchanged levels', () => {
    // LDI r16,1; OUT PORTB,r16; SBI DDRB,0; CBI DDRB,0; CBI PORTB,0; SBI DDRB,0; RJMP .
    const machine = new UnoMachine(hex([0xe001, 0xb905, 0x9a20, 0x9820, 0x9828, 0x9a20, 0xcfff]), circuit);
    for (let i = 0; i < 6; i++) machine.step();
    expect(machine.cpu.progMem.byteLength).toBe(FLASH_BYTES);
    expect(machine.cpu.data.byteLength).toBe(SRAM_BYTES + 256);
    expect(machine.trace.filter((point) => point.signal === 'a').map(({ value, mode }) => ({ value, mode }))).toEqual([
      { value: 'floating', mode: 'input' },
      { value: 1, mode: 'input-pullup' },
      { value: 1, mode: 'output' },
      { value: 1, mode: 'input-pullup' },
      { value: 'floating', mode: 'input' },
      { value: 0, mode: 'output' },
    ]);
  });

  it('finds a one-instruction overlap that an animation frame would miss', () => {
    // Set DDRB bits 0/1, briefly drive both high, then clear them forever.
    const result = runScenario(hex([0xe003, 0xb904, 0xb905, 0xe000, 0xb905, 0xcfff]), circuit, scenario);
    expect(result.completed).toBe(true);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].message).toContain('overlap');
    const high = result.trace.find((point) => point.signal === 'a' && point.value === 1)!;
    const low = result.trace.find((point) => point.signal === 'a' && point.value === 0 && point.cycle > high.cycle)!;
    expect(low.atMs - high.atMs).toBeLessThan(0.001);
  });

  it('treats an atomic PORT handover as simultaneous, without invented overlap', () => {
    // DDRB=3; PORTB=2; PORTB=1. A rises in the same write that B falls.
    const result = runScenario(hex([0xe003, 0xb904, 0xe002, 0xb905, 0xe001, 0xb905, 0xcfff]), circuit, scenario);
    expect(result.completed).toBe(true);
    expect(result.checks[0].passed).toBe(true);
  });

  it('rejects missing button pull-ups and fails every expected check', () => {
    const withButton: RunSpec = { ...spec, components: [...spec.components, { id: 'request', kind: 'button', label: 'Request', meaning: 'Request' }] };
    const wired = generateCircuit(withButton, [{ componentId: 'a', pin: 8 }, { componentId: 'b', pin: 9 }, { componentId: 'request', pin: 2 }]);
    const result = runScenario(hex([0xe003, 0xb904, 0xcfff]), wired, { ...scenario, durationMs: 120 });
    expect(result.completed).toBe(false);
    expect(result.error).toContain('requires input-pullup');
    expect(result.checks).toHaveLength(scenario.assertions.length);
    expect(result.checks.every((check) => !check.passed)).toBe(true);
  });

  it('fresh machines reset all registers and physical button state', () => {
    const program = hex([0xe003, 0xb904, 0xb905, 0xcfff]);
    const first = new UnoMachine(program, circuit);
    first.runUntil(1);
    const reset = new UnoMachine(program, circuit);
    expect(reset.atMs).toBe(0);
    expect(reset.trace.every((point) => point.value === 'floating')).toBe(true);
    reset.runUntil(1);
    expect(reset.trace).toEqual(first.trace);
  });

  it('does not accept a weak input pull-up as driven LED output, even before 100 ms', () => {
    const high: Assertion = { id: 'high', type: 'level', signal: 'a', value: 1, fromMs: 0.0001, toMs: 0.5, requirementIds: ['R1'] };
    // PORTB=3 enables input pull-ups but never sets DDRB.
    const result = runScenario(hex([0xe003, 0xb905, 0xcfff]), circuit, { ...scenario, assertions: [high] });
    expect(result.completed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
    expect(evaluateAssertion(high, [{ signal: 'a', atMs: 0, cycle: 0, value: 1, mode: 'input-pullup' }]).passed).toBe(false);
  });

  it('observes the AVR global pull-up-disable register', () => {
    // PORTB=1 => weak HIGH, then MCUCR.PUD=1 => floating.
    const machine = new UnoMachine(hex([0xe001, 0xb905, 0xe100, 0xbf05, 0xcfff]), circuit);
    for (let i = 0; i < 4; i++) machine.step();
    const signal = machine.trace.filter((point) => point.signal === 'a');
    expect(signal.at(-2)?.mode).toBe('input-pullup');
    expect(signal.at(-1)?.mode).toBe('input');
    expect(signal.at(-1)?.value).toBe('floating');
  });
});

describe('structured signal evidence', () => {
  const point = (atMs: number, value: 0 | 1, signal = 'a'): TracePoint => ({ signal, atMs, cycle: atMs * 16000, value, mode: 'output' });
  it('rejects an incomplete duration rather than treating the test boundary as closure', () => {
    const assertion: Assertion = { id: 'duration', type: 'duration', signal: 'a', value: 1, minMs: 1950, maxMs: 2050, minCount: 1, fromMs: 0, toMs: 2150, requirementIds: ['R1'] };
    expect(evaluateAssertion(assertion, [point(0, 0), point(100, 1)]).passed).toBe(false);
    expect(evaluateAssertion(assertion, [point(0, 0), point(100, 1), point(2100, 0)]).passed).toBe(true);
  });

  it('fails any too-short pulse even when another pulse has the right duration', () => {
    const assertion: Assertion = { id: 'duration', type: 'duration', signal: 'a', value: 1, minMs: 100, maxMs: 110, minCount: 1, fromMs: 0, toMs: 500, requirementIds: ['R1'] };
    expect(evaluateAssertion(assertion, [point(0, 0), point(100, 1), point(105, 0), point(200, 1), point(305, 0)]).passed).toBe(false);
  });

  it('checks overlap already active at the window start', () => {
    expect(evaluateAssertion({ ...exclusive, fromMs: 0.5 }, [point(0, 1), point(0, 1, 'b')]).passed).toBe(false);
  });

  it('measures the actual all-closed gap and rejects a sub-millisecond shortfall', () => {
    const deadtime: Assertion = { id: 'closed', type: 'deadtime', signals: ['a', 'b'], minMs: 250, minCount: 1, fromMs: 0, toMs: 3000, requirementIds: ['R1'] };
    const initial = [point(0, 0), point(0, 0, 'b'), point(100, 1), point(2100, 0)];
    expect(evaluateAssertion(deadtime, [...initial, point(2349.999, 1, 'b')]).passed).toBe(false);
    expect(evaluateAssertion(deadtime, [...initial, point(2350, 1, 'b')]).passed).toBe(true);
    expect(evaluateAssertion(deadtime, initial).passed).toBe(false); // no completed gap
  });

  it('rejects atomic door handover with no closed gap', () => {
    const deadtime: Assertion = { id: 'closed', type: 'deadtime', signals: ['a', 'b'], minMs: 250, minCount: 1, fromMs: 0, toMs: 3000, requirementIds: ['R1'] };
    expect(evaluateAssertion(deadtime, [point(0, 0), point(0, 0, 'b'), point(100, 1), point(2100, 0), point(2100, 1, 'b')]).passed).toBe(false);
  });
});

describe('malformed firmware and isolation', () => {
  it('rejects bad checksums, overflowing flash, missing EOF, and overlapping HEX', () => {
    expect(() => parseHex(':02000000FFCF31\n:00000001FF')).toThrow(/checksum/);
    expect(() => parseHex(`${record(0x8000, 0, [0, 0])}\n:00000001FF`)).toThrow(/32 KB/);
    expect(() => parseHex(record(0, 0, [255, 207]))).toThrow(/EOF/);
    expect(() => parseHex(`${record(0, 0, [255, 207])}\n${record(0, 0, [255, 207])}\n:00000001FF`)).toThrow(/Overlapping/);
  });

  it('rejects execution beyond the programmed sketch with failed evidence', () => {
    const result = runScenario(hex([0x0000]), circuit, scenario);
    expect(result.completed).toBe(false);
    expect(result.error).toContain('left programmed firmware');
    expect(result.checks[0].passed).toBe(false);
  });

  it('runs the same instructions in the isolated Node worker with matching traces', async () => {
    const program = hex([0xe003, 0xb904, 0xe002, 0xb905, 0xe001, 0xb905, 0xcfff]);
    const direct = runScenario(program, circuit, scenario);
    const [isolated] = await runSimulation(program, circuit, [scenario], { timeoutMs: 10000 });
    expect(isolated).toEqual(direct);
  });

  it('hard-stops a worker at its wall deadline and honors cancellation', async () => {
    const program = hex([0xe003, 0xb904, 0xcfff]);
    await expect(runSimulation(program, circuit, [{ ...scenario, durationMs: 15000 }], { timeoutMs: 1 })).rejects.toThrow(/timeout/);
    const abort = new AbortController();
    const promise = runSimulation(program, circuit, [{ ...scenario, durationMs: 15000 }], { signal: abort.signal });
    abort.abort();
    await expect(promise).rejects.toThrow(/cancelled/);
  });
});
