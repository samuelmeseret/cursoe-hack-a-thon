import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from '@playwright/test';
import { compileCandidate, compilerAvailable } from '../server/compiler';
import { runSimulation } from '../server/simulation';
import { generateCircuit } from '../shared/circuit';
import { runScenario, UnoMachine } from '../shared/simulator';
import { validateCandidate, validateSpec, validateSuite } from '../shared/validation';
import type { Assertion, Candidate, RunSpec, Scenario, ScenarioResult, TracePoint } from '../shared/types';

// Test-only firmware: live agents still generate their own circuit and sketch.
const spec: RunSpec = {
  goal: 'Build a mini car that moves forwards and backwards based on keyboard commands',
  assumptions: ['Two DC motors use powered H-bridges; keyboard commands reach the Uno over UART.'],
  presentation: 'vehicle',
  serial: { baudRate: 9600, controls: [
    { key: 'w', label: 'Forward', data: 'W', releaseData: 'X' },
    { key: 's', label: 'Backward', data: 'S', releaseData: 'X' },
    { key: ' ', label: 'Stop', data: 'X' },
  ] },
  components: ['left', 'right'].map(id => ({ id, kind: 'motor', label: `${id} motor`, meaning: `${id} wheel drive` })),
  requirements: [
    { id: 'R1', text: 'Start with both motors stopped.' },
    { id: 'R2', text: 'W drives both motors forward until another command.' },
    { id: 'R3', text: 'S drives both motors backward until another command.' },
    { id: 'R4', text: 'X stops both motors.' },
    { id: 'R5', text: 'Never energize both directions of a motor together.' },
  ],
};

const candidate: Candidate = {
  id: 'uart-mini-car',
  pins: [{ componentId: 'left', pin: 5, reversePin: 6 }, { componentId: 'right', pin: 9, reversePin: 10 }],
  rationale: 'Exercise compiled Arduino Serial input and real H-bridge GPIO outputs.',
  source: `#include <Arduino.h>
const byte FORWARD[] = {5, 9};
const byte REVERSE[] = {6, 10};
void drive(char command) {
  for (byte i = 0; i < 2; i++) {
    digitalWrite(FORWARD[i], LOW);
    digitalWrite(REVERSE[i], LOW);
    if (command == 'W') digitalWrite(FORWARD[i], HIGH);
    if (command == 'S') digitalWrite(REVERSE[i], HIGH);
  }
}
void setup() {
  for (byte i = 0; i < 2; i++) {
    pinMode(FORWARD[i], OUTPUT);
    pinMode(REVERSE[i], OUTPUT);
  }
  drive('X');
  Serial.begin(9600);
}
void loop() {
  if (Serial.available()) {
    char command = Serial.read();
    if (command == 'W' || command == 'S' || command == 'X') drive(command);
  }
}
`,
};

const motorAssertions = (id: string): Assertion[] => [
  { id: `${id}-initial-forward`, type: 'level', signal: `${id}_forward`, value: 0, driven: true, fromMs: 10, toMs: 100, requirementIds: ['R1'] },
  { id: `${id}-initial-reverse`, type: 'level', signal: `${id}_reverse`, value: 0, driven: true, fromMs: 10, toMs: 100, requirementIds: ['R1'] },
  { id: `${id}-forward`, type: 'level', signal: `${id}_forward`, value: 1, driven: true, fromMs: 110, toMs: 290, requirementIds: ['R2'] },
  { id: `${id}-forward-duration`, type: 'duration', signal: `${id}_forward`, value: 1, minMs: 199, maxMs: 201, minCount: 1, fromMs: 100, toMs: 600, requirementIds: ['R2'] },
  { id: `${id}-reverse`, type: 'level', signal: `${id}_reverse`, value: 1, driven: true, fromMs: 310, toMs: 490, requirementIds: ['R3'] },
  { id: `${id}-reverse-duration`, type: 'duration', signal: `${id}_reverse`, value: 1, minMs: 199, maxMs: 201, minCount: 1, fromMs: 100, toMs: 600, requirementIds: ['R3'] },
  { id: `${id}-stop-forward`, type: 'level', signal: `${id}_forward`, value: 0, driven: true, fromMs: 510, toMs: 600, requirementIds: ['R4'] },
  { id: `${id}-stop-reverse`, type: 'level', signal: `${id}_reverse`, value: 0, driven: true, fromMs: 510, toMs: 600, requirementIds: ['R4'] },
  { id: `${id}-exclusive`, type: 'mutual-exclusion', signals: [`${id}_forward`, `${id}_reverse`], fromMs: 0, toMs: 600, requirementIds: ['R5'] },
];
const scenario: Scenario = {
  id: 'keyboard-drive', name: 'Forward, reverse, and release-to-stop', durationMs: 600,
  inputs: [{ atMs: 100, serial: 'W' }, { atMs: 300, serial: 'S' }, { atMs: 500, serial: 'X' }],
  assertions: ['left', 'right'].flatMap(motorAssertions),
};

describe('Compiled keyboard car over the real AVR UART', () => {
  let directory: string;
  const compiled = new Map<string, string>();
  async function hexFor(sketch = candidate): Promise<string> {
    const cached = compiled.get(sketch.id);
    if (cached) return cached;
    const { hex } = await compileCandidate(sketch, path.join(directory, sketch.id));
    compiled.set(sketch.id, hex);
    return hex;
  }
  beforeAll(async () => {
    expect(await compilerAvailable(), 'Install the local toolchain with npm run setup:arduino').toBe(true);
    await mkdir('.artifacts/tests', { recursive: true });
    directory = await mkdtemp(path.resolve('.artifacts/tests/motor-'));
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it('compiles and proves both directions, complete motion durations, stop, and Node Worker parity', async () => {
    validateSpec(spec);
    validateCandidate(spec, candidate);
    validateSuite([scenario], spec);
    const hex = await hexFor();
    const circuit = generateCircuit(spec, candidate.pins);
    const direct = runScenario(hex, circuit, scenario);
    expect(direct.completed, direct.error).toBe(true);
    for (const check of direct.checks) expect(check.passed, check.message).toBe(true);
    expect(await runSimulation(hex, circuit, [scenario])).toEqual([direct]);
    expect(new Set(direct.trace.map(point => point.signal))).toEqual(new Set(['left_forward', 'left_reverse', 'right_forward', 'right_reverse']));
  });

  it('delivers a multibyte command at UART frame timing without dropping busy bytes', async () => {
    const machine = new UnoMachine(await hexFor(), generateCircuit(spec, candidate.pins));
    machine.runUntil(100);
    machine.sendSerial('W');
    machine.sendSerial('SX'); // The first byte is still physically being received.
    machine.runUntil(110);
    machine.validateModes();
    const points = machine.trace.filter(point => point.signal.startsWith('left_') && point.atMs >= 100);
    const forward = points.find(point => point.signal === 'left_forward' && point.value === 1)!;
    const reverse = points.find(point => point.signal === 'left_reverse' && point.value === 1)!;
    const stopped = points.find(point => point.signal === 'left_reverse' && point.value === 0)!;
    expect(forward.atMs).toBeGreaterThan(101);
    expect(forward.atMs).toBeLessThan(101.2);
    expect(reverse.atMs - forward.atMs).toBeGreaterThan(1);
    expect(reverse.atMs - forward.atMs).toBeLessThan(1.2);
    expect(stopped.atMs - reverse.atMs).toBeGreaterThan(1);
    expect(stopped.atMs - reverse.atMs).toBeLessThan(1.2);
  });

  it('accepts the Uno baud divisor rounding at 115200', async () => {
    const faster = { ...candidate, id: 'uart-fast-car', source: candidate.source.replace('Serial.begin(9600)', 'Serial.begin(115200)') };
    const fastSpec: RunSpec = { ...spec, serial: { ...spec.serial!, baudRate: 115200 } };
    const result = runScenario(await hexFor(faster), generateCircuit(fastSpec, faster.pins), scenario);
    expect(result.completed, result.error).toBe(true);
    for (const check of result.checks) expect(check.passed, check.message).toBe(true);
  });

  it('fails the same checks when firmware consumes commands without driving the motors', async () => {
    const idle = { ...candidate, id: 'uart-idle-car', source: candidate.source.replace("if (command == 'W' || command == 'S' || command == 'X') drive(command);", '(void)command;') };
    const result = runScenario(await hexFor(idle), generateCircuit(spec, idle.pins), scenario);
    expect(result.completed).toBe(true);
    for (const id of ['left-forward', 'right-reverse', 'left-forward-duration', 'right-reverse-duration']) {
      expect(result.checks.find(check => check.id === id)?.passed).toBe(false);
    }
  });

  it.each([
    { id: 'missing-uart', replacement: '', error: /Serial receiver is disabled/ },
    { id: 'wrong-baud', replacement: 'Serial.begin(115200);', error: /Serial baud rate mismatch/ },
    { id: 'wrong-framing', replacement: 'Serial.begin(9600, SERIAL_8E1);', error: /8N1 UART framing/ },
  ])('rejects $id rather than delivering fictional commands', async ({ id, replacement, error }) => {
    const broken = { ...candidate, id, source: candidate.source.replace('Serial.begin(9600);', replacement) };
    const result = runScenario(await hexFor(broken), generateCircuit(spec, broken.pins), scenario);
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(error);
    expect(result.checks.every(check => !check.passed)).toBe(true);
  });

  it('requires every H-bridge pin to be a driven output', async () => {
    const broken = { ...candidate, id: 'missing-reverse-output', source: candidate.source.replace('pinMode(REVERSE[i], OUTPUT);', '') };
    const result = runScenario(await hexFor(broken), generateCircuit(spec, broken.pins), scenario);
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/left_reverse on D6 requires output/);
    expect(result.checks.every(check => !check.passed)).toBe(true);
  });

  it('rejects UART receive overrun if firmware never reads incoming bytes', async () => {
    const broken = { ...candidate, id: 'uart-unread-car', source: candidate.source.replace('Serial.begin(9600);', 'Serial.begin(9600); UCSR0B &= ~_BV(RXCIE0);') };
    const burst: Scenario = { ...scenario, inputs: [{ atMs: 100, serial: 'WSX' }] };
    const result = runScenario(await hexFor(broken), generateCircuit(spec, broken.pins), burst);
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/Serial receive overrun/);
  });

  it('bounds queued input, enforces declared serial support, and clears queued bytes on reset', async () => {
    const hex = await hexFor();
    const circuit = generateCircuit(spec, candidate.pins);
    const queued = new UnoMachine(hex, circuit);
    for (let i = 0; i < 64; i++) queued.sendSerial('W'.repeat(64));
    expect(() => queued.sendSerial('X')).toThrow(/queue exceeded/);
    const reset = new UnoMachine(hex, circuit);
    reset.runUntil(200);
    reset.validateModes();
    for (const signal of ['left_forward', 'left_reverse', 'right_forward', 'right_reverse']) {
      expect(reset.trace.filter(point => point.signal === signal).at(-1)).toMatchObject({ value: 0, mode: 'output' });
    }
    const { serial: _serial, ...withoutSerial } = spec;
    const disconnected = new UnoMachine(hex, generateCircuit(withoutSerial, candidate.pins));
    expect(() => disconnected.sendSerial('W')).toThrow(/no serial input configured/);
    expect(() => reset.sendSerial('')).toThrow(/1–64 ASCII/);
    expect(() => reset.sendSerial('é')).toThrow(/1–64 ASCII/);
  });

  it('matches the real browser Worker and accepts interactive serial commands there', async () => {
    let server: Server | undefined;
    let browser: Browser | undefined;
    const { outputFiles } = await build({ entryPoints: ['src/simulator.worker.ts'], bundle: true, platform: 'browser', format: 'esm', write: false });
    try {
      server = createServer((request, response) => {
        response.setHeader('Content-Type', request.url === '/worker.js' ? 'text/javascript' : 'text/html');
        response.end(request.url === '/worker.js' ? outputFiles[0].text : '<!doctype html><title>UART motor worker harness</title>');
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const packaged = chromium.executablePath();
      const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? (existsSync(packaged) ? packaged : existsSync(macChrome) ? macChrome : undefined);
      browser = await chromium.launch({ headless: true, executablePath });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      const hex = await hexFor();
      const circuit = generateCircuit(spec, candidate.pins);
      const actual = await page.evaluate(({ hex, circuit, scenario }) => new Promise<ScenarioResult>((resolve, reject) => {
        const worker = new Worker('/worker.js', { type: 'module' });
        const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Browser simulation timed out')); }, 30_000);
        worker.onerror = event => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
        worker.onmessage = event => {
          if (event.data.type === 'result') { clearTimeout(timeout); worker.terminate(); resolve(event.data.result); }
          if (event.data.type === 'error') { clearTimeout(timeout); worker.terminate(); reject(new Error(event.data.message)); }
        };
        worker.postMessage({ type: 'scenario', hex, circuit, scenario });
      }), { hex, circuit, scenario });
      expect(actual).toEqual(runScenario(hex, circuit, scenario));
      const trace = await page.evaluate(({ hex, circuit }) => new Promise<TracePoint[]>((resolve, reject) => {
        const worker = new Worker('/worker.js', { type: 'module' });
        const points: TracePoint[] = [];
        let sent = false;
        const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Interactive UART timed out')); }, 30_000);
        worker.onerror = event => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
        worker.onmessage = event => {
          if (event.data.type === 'error') { clearTimeout(timeout); worker.terminate(); reject(new Error(event.data.message)); }
          if (event.data.type === 'trace') points.push(...event.data.trace);
          if (event.data.type === 'state' && event.data.running) {
            if (event.data.atMs >= 100 && !sent) { sent = true; worker.postMessage({ type: 'serial', data: 'WSX' }); }
            if (event.data.atMs >= 200) { clearTimeout(timeout); worker.terminate(); resolve(points); }
          }
        };
        worker.postMessage({ type: 'load', hex, circuit });
        worker.postMessage({ type: 'play' });
      }), { hex, circuit });
      for (const signal of ['left_forward', 'left_reverse', 'right_forward', 'right_reverse']) {
        expect(trace.some(point => point.signal === signal && point.value === 1 && point.mode === 'output')).toBe(true);
        expect(trace.filter(point => point.signal === signal).at(-1)?.value).toBe(0);
      }
    } finally {
      await browser?.close();
      await new Promise<void>(resolve => { if (server?.listening) server.close(() => resolve()); else resolve(); });
    }
  });
});
