import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { compileCandidate, compilerAvailable, validateFirmwareSource } from '../server/compiler';
import { generateCircuit } from '../shared/circuit';
import { runScenario, UnoMachine } from '../shared/simulator';
import { runSimulation } from '../server/simulation';
import { validateCandidate, validateSpec, validateSuite } from '../shared/validation';
import type { Candidate, Scenario } from '../shared/types';
import {
  airlockSpec, airlockScenarios, goodAirlockCandidate, badAirlockCandidate,
  blinkSpec, blinkCandidate, blinkScenarios, buttonSpec, buttonCandidate, buttonScenarios,
  buzzerSpec, buzzerScenarios, goodBuzzerCandidate, neverOpensCandidate,
  serialPassCandidate, missingPullupsCandidate, malformedCandidate,
} from '../shared/fixtures';

describe('Actual Arduino Uno compilation and simulation', () => {
  let directory: string;
  const compiled = new Map<string, string>();
  async function hexFor(candidate: Candidate): Promise<string> {
    const existing = compiled.get(candidate.id);
    if (existing) return existing;
    const result = await compileCandidate(candidate, path.join(directory, candidate.id));
    compiled.set(candidate.id, result.hex);
    return result.hex;
  }

  beforeAll(async () => {
    expect(await compilerAvailable(), 'Install the local toolchain with npm run setup:arduino').toBe(true);
    await mkdir('.artifacts/tests', { recursive: true });
    directory = await mkdtemp(path.resolve('.artifacts/tests/compiler-'));
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it('compiles known Blink and button sketches and gets the same Node worker traces', async () => {
    for (const [spec, candidate, scenarios] of [[blinkSpec, blinkCandidate, blinkScenarios], [buttonSpec, buttonCandidate, buttonScenarios]] as const) {
      const hex = await hexFor(candidate);
      expect(hex).toContain(':00000001FF');
      const circuit = generateCircuit(spec, candidate.pins);
      const direct = scenarios.map((scenario) => runScenario(hex, circuit, scenario));
      const authoritative = await runSimulation(hex, circuit, scenarios);
      expect(authoritative).toEqual(direct);
      expect(authoritative.every((result) => result.completed && result.checks.every((check) => check.passed))).toBe(true);
    }
  });

  it('passes every frozen airlock behavior against actual compiled firmware', async () => {
    validateSpec(airlockSpec);
    validateCandidate(airlockSpec, goodAirlockCandidate);
    validateSuite(airlockScenarios, airlockSpec);
    const circuit = generateCircuit(airlockSpec, goodAirlockCandidate.pins);
    const results = await runSimulation(await hexFor(goodAirlockCandidate), circuit, airlockScenarios);
    expect(results).toHaveLength(airlockScenarios.length);
    for (const result of results) {
      expect(result.completed, `${result.scenarioId}: ${result.error}`).toBe(true);
      for (const check of result.checks) expect(check.passed, `${result.scenarioId}/${check.id}: ${check.message}`).toBe(true);
    }
  });

  it.each([
    { id: 'slow-response-long-pulse', responseUs: 90000, openUs: 2049000 },
    { id: 'prompt-response-short-pulse', responseUs: 0, openUs: 1951000 },
  ])('accepts firmware using permitted timing: $id', async ({ id, responseUs, openUs }) => {
    // A separate accepted-request phase models a legal nonzero response latency.
    // It still consumes busy input edges, then starts measuring the open pulse at the GPIO write.
    const candidate: Candidate = {
      ...goodAirlockCandidate, id,
      rationale: 'Regression control exercising permitted response latency and pulse duration bounds.',
      source: goodAirlockCandidate.source
        .replace('const unsigned long OPEN_US = 2000000UL;', `const unsigned long OPEN_US = ${openUs}UL;`)
        .replace('enum Phase { IDLE, OPEN, COOLDOWN, LOCKED };', 'enum Phase { IDLE, WAITING_TO_OPEN, OPEN, COOLDOWN, LOCKED };')
        .replace('    digitalWrite(DOOR[activeDoor], HIGH);\n    phase = OPEN;\n    phaseAtUs = micros();', '    phase = WAITING_TO_OPEN;\n    phaseAtUs = micros();')
        .replace('  if (phase == OPEN) {', `  if (phase == WAITING_TO_OPEN) {
    if (micros() - phaseAtUs >= ${responseUs}UL) {
      digitalWrite(DOOR[activeDoor], HIGH);
      phase = OPEN;
      phaseAtUs = micros();
    }
    return;
  }
  if (phase == OPEN) {`),
    };
    const results = await runSimulation(await hexFor(candidate), generateCircuit(airlockSpec, candidate.pins), airlockScenarios);
    for (const result of results) {
      expect(result.completed, `${id}/${result.scenarioId}: ${result.error}`).toBe(true);
      for (const check of result.checks) expect(check.passed, `${id}/${result.scenarioId}/${check.id}: ${check.message}`).toBe(true);
    }
    const outer = results.find((result) => result.scenarioId === 'outer')!;
    const rises = outer.trace.filter((point) => point.signal === 'outerDoor' && point.value === 1 && point.mode === 'output');
    const falls = outer.trace.filter((point) => point.signal === 'outerDoor' && point.value === 0 && point.atMs > rises[0].atMs);
    expect(rises[0].atMs).toBeGreaterThanOrEqual(120 + responseUs / 1000);
    expect(rises[0].atMs).toBeLessThanOrEqual(220);
    // The frozen duration checks above enforce 1950–2050 ms; this only confirms
    // that the regression variant actually used its intended timing target.
    expect(Math.abs((falls[0].atMs - rises[0].atMs) - openUs / 1000)).toBeLessThan(1);
    if (responseUs > 0) expect(falls[0].atMs).toBeGreaterThan(2200); // Rejected by the previous premature LOW windows.
  });

  it('reproduces an actual conflicting GPIO signal failure in the labeled challenge', async () => {
    const circuit = generateCircuit(airlockSpec, badAirlockCandidate.pins);
    const result = runScenario(await hexFor(badAirlockCandidate), circuit, airlockScenarios.find((scenario) => scenario.id === 'outer')!);
    expect(result.completed).toBe(true);
    expect(result.checks.find((check) => check.id === 'outer-exclusive')?.passed).toBe(false);
    expect(result.trace.some((point) => point.signal === 'outerDoor' && point.value === 1)).toBe(true);
    expect(result.trace.some((point) => point.signal === 'innerDoor' && point.value === 1)).toBe(true);
  });

  it('rejects physically simultaneous requests across GPIO sampling phases', async () => {
    const hex = await hexFor(goodAirlockCandidate);
    const circuit = generateCircuit(airlockSpec, goodAirlockCandidate.pins);
    for (let offset = 0; offset < 16; offset++) {
      const atMs = 100.001 + offset * 0.005;
      const scenario: Scenario = {
        id: 'simultaneous-phase', name: `Simultaneous input at ${atMs.toFixed(3)} ms`, durationMs: 300,
        inputs: ['outerRequest', 'innerRequest'].map((componentId) => ({ componentId, atMs, pressed: true })),
        assertions: ['outerDoor', 'innerDoor'].map((signal) => ({ id: `${signal}-closed`, type: 'level', signal, value: 0, driven: true, fromMs: 100, toMs: 300, requirementIds: ['R5'] })),
      };
      const result = runScenario(hex, circuit, scenario);
      expect(result.completed, scenario.name).toBe(true);
      for (const check of result.checks) expect(check.passed, `${scenario.name}: ${check.message}`).toBe(true);
    }
  });

  it('accepts a valid request when the concurrent other input was only a short bounce', async () => {
    const hex = await hexFor(goodAirlockCandidate);
    const circuit = generateCircuit(airlockSpec, goodAirlockCandidate.pins);
    const result = runScenario(hex, circuit, {
      id: 'peer-bounce', name: 'Concurrent peer bounce does not reject a valid request', durationMs: 300,
      inputs: [
        { componentId: 'outerRequest', atMs: 100, pressed: true },
        { componentId: 'innerRequest', atMs: 119, pressed: true },
        { componentId: 'innerRequest', atMs: 125, pressed: false },
      ],
      assertions: [
        { id: 'valid-request', type: 'transition', signal: 'outerDoor', edge: 'rising', minCount: 1, maxCount: 1, fromMs: 120, toMs: 220, requirementIds: ['R2'] },
        { id: 'peer-not-open', type: 'level', signal: 'innerDoor', value: 0, driven: true, fromMs: 100, toMs: 300, requirementIds: ['R2', 'R8'] },
      ],
    });
    expect(result.completed).toBe(true);
    for (const check of result.checks) expect(check.passed, check.message).toBe(true);
  });

  it.each([neverOpensCandidate, serialPassCandidate])('rejects vacuous or serial-only firmware: $id', async (candidate) => {
    const circuit = generateCircuit(airlockSpec, candidate.pins);
    const result = runScenario(await hexFor(candidate), circuit, airlockScenarios.find((scenario) => scenario.id === 'outer')!);
    expect(result.completed).toBe(true);
    expect(result.checks.find((check) => check.id === 'outer-accepted')?.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'outer-two-seconds')?.passed).toBe(false);
  });

  it('rejects firmware that omits required button pull-ups', async () => {
    const circuit = generateCircuit(airlockSpec, missingPullupsCandidate.pins);
    const result = runScenario(await hexFor(missingPullupsCandidate), circuit, airlockScenarios[0]);
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/requires input-pullup/);
    expect(result.checks.every((check) => !check.passed)).toBe(true);
  });

  it('a fresh machine reset clears an active door and previous button inputs', async () => {
    const hex = await hexFor(goodAirlockCandidate);
    const circuit = generateCircuit(airlockSpec, goodAirlockCandidate.pins);
    const beforeReset = new UnoMachine(hex, circuit);
    beforeReset.runUntil(100);
    beforeReset.setButton('outerRequest', true);
    beforeReset.runUntil(300);
    expect(beforeReset.trace.filter((point) => point.signal === 'outerDoor').at(-1)?.value).toBe(1);
    const afterReset = new UnoMachine(hex, circuit);
    afterReset.runUntil(100);
    for (const id of ['outerDoor', 'innerDoor']) expect(afterReset.trace.filter((point) => point.signal === id).at(-1)).toMatchObject({ value: 0, mode: 'output' });
    expect(afterReset.trace.filter((point) => point.signal === 'outerRequest').at(-1)).toMatchObject({ value: 1, mode: 'input-pullup' });
  });

  it('a second supported goal runs a first-press-wins buzzer suite', async () => {
    validateSuite(buzzerScenarios, buzzerSpec);
    const results = await runSimulation(await hexFor(goodBuzzerCandidate), generateCircuit(buzzerSpec, goodBuzzerCandidate.pins), buzzerScenarios);
    for (const result of results) {
      expect(result.completed).toBe(true);
      for (const check of result.checks) expect(check.passed, check.message).toBe(true);
    }
  });

  it('rejects malformed Arduino source instead of returning previous HEX', async () => {
    const workDir = path.join(directory, 'stale-hex');
    await compileCandidate(blinkCandidate, workDir);
    await expect(compileCandidate(malformedCandidate, workDir)).rejects.toThrow(/compilation failed/i);
  });

  it('honors compile timeout and cancellation', async () => {
    await expect(compileCandidate(blinkCandidate, path.join(directory, 'timeout'), { timeoutMs: 1 })).rejects.toThrow(/timed out/);
    const controller = new AbortController();
    controller.abort();
    await expect(compileCandidate(blinkCandidate, path.join(directory, 'cancelled'), { signal: controller.signal })).rejects.toThrow(/cancelled/);
  });
});

describe('Restricted local compiler input', () => {
  it('allows core Arduino and AVR utility headers', () => {
    expect(() => validateFirmwareSource('#include <Arduino.h>\n#include <avr/interrupt.h>\n#define BUTTON 2\nvoid setup() {}\nvoid loop() {}')).not.toThrow();
  });
  it.each([
    '#include "../../.env"',
    '#include </etc/passwd>',
    '#define SECRET "../../.env"\n#include SECRET',
    '#inc\\\nlude "../../.env"',
    '%:include "../../.env"',
    '#include_next <Arduino.h>',
    'asm(".incbin \\\"../../.env\\\"");',
    '#define JOIN(a,b) a##b',
  ])('rejects host-file access source %s', (source) => {
    expect(() => validateFirmwareSource(source)).toThrow();
  });
});
