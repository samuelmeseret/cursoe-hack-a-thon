import { describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunController, type AgentService } from '../server/controller';
import { AgentError } from '../server/agents';
import { artifactHashes, createEvidence, evidencePasses } from '../server/evidence';
import { runDirectory } from '../server/storage';
import { generateCircuit } from '../shared/circuit';
import type { Candidate, Scenario, ScenarioResult, RunSpec } from '../shared/types';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const spec: RunSpec = { goal: 'Light an LED', assumptions: [], components: [{ id: 'light', kind: 'led', label: 'Light', meaning: 'HIGH means on' }], requirements: [{ id: 'R1', text: 'Turn on the light' }] };
const scenarios: Scenario[] = [{ id: 'on', name: 'Turn on', durationMs: 200, inputs: [], assertions: [{ id: 'on-check', type: 'level', signal: 'light', value: 1, driven: true, fromMs: 100, toMs: 200, requirementIds: ['R1'] }] }];
const candidate: Candidate = { id: 'one', source: 'void setup(){pinMode(8,OUTPUT);digitalWrite(8,HIGH);} void loop(){}', pins: [{ componentId: 'light', pin: 8 }], rationale: 'Light the LED' };
const result = (passed = true): ScenarioResult => ({ scenarioId: 'on', completed: true, durationMs: 200, trace: [{ cycle: 0, atMs: 0, signal: 'light', value: 1, mode: 'output' }], checks: [{ id: 'on-check', scenarioId: 'on', requirementIds: ['R1'], passed, message: passed ? 'Observed on' : 'Observed off' }] });
const request = { goal: 'Light an LED', mode: 'generate' as const, inference: 'crusoe' as const };
function dependencies(overrides: Partial<AgentService> = {}) {
  let attempt = 0;
  const agents: AgentService = {
    validateModel: vi.fn(async () => {}), specify: vi.fn(async () => structuredClone(spec)), verify: vi.fn(async () => structuredClone(scenarios)),
    build: vi.fn(async () => ({ ...structuredClone(candidate), source: candidate.source + `\n// ${++attempt}` })), replan: vi.fn(async () => 'Use direct GPIO output; preserve all tests.'), ...overrides,
  };
  const compile = vi.fn(async () => ({ hex: 'test-only-compiled-hex', log: '', hexPath: '/unused' }));
  const simulate = vi.fn(async () => [result()]);
  return { agents, compile, simulate };
}
describe('application completion gate', () => {
  const circuit = generateCircuit(spec, candidate.pins);
  const hashes = artifactHashes(candidate, circuit, 'hex', spec, scenarios);
  it('requires exactly every expected check, complete simulation, and current hashes', () => {
    const evidence = createEvidence('run', candidate, hashes, scenarios, [result()], 'test');
    expect(evidencePasses(evidence, hashes, scenarios, candidate.id)).toBe(true);
    for (const change of [
      (e: typeof evidence) => { e.results[0].checks = []; },
      (e: typeof evidence) => { e.results[0].checks.push(e.results[0].checks[0]); },
      (e: typeof evidence) => { e.results[0].completed = false; },
      (e: typeof evidence) => { e.results[0].error = 'timeout'; },
      (e: typeof evidence) => { e.results[0].trace = []; },
      (e: typeof evidence) => { e.results[0].trace[0].signal = 'unrelated'; },
      (e: typeof evidence) => { e.results[0].trace[0].value = 0; },
      (e: typeof evidence) => { e.results[0].durationMs = Number.NaN; },
      (e: typeof evidence) => { e.results[0].trace[0].atMs = Number.NaN; },
      (e: typeof evidence) => { e.results[0].checks[0].passed = false; e.passed = true; },
      (e: typeof evidence) => { e.results[0].checks[0].requirementIds = []; },
      (e: typeof evidence) => { e.hashes.source = 'altered'; },
      (e: typeof evidence) => { e.candidateId = 'old-candidate'; },
    ]) { const changed = structuredClone(evidence); change(changed); expect(evidencePasses(changed, hashes, scenarios, candidate.id)).toBe(false); }
    expect(evidencePasses(evidence, hashes, [], candidate.id)).toBe(false);
  });
});
describe('bounded run controller', () => {
  it('preserves unsupported-goal failures before creating any implementation or verification evidence', async () => {
    const goal = 'Build a flying drone with a live camera feed over Wi-Fi.';
    const error = new AgentError('UNSUPPORTED_GOAL', 'Camera and Wi-Fi adapters are not installed.');
    const deps = dependencies({ specify: vi.fn(async () => { throw error; }) });
    const controller = new RunController(deps);
    const run = (await controller.wait((await controller.start({ ...request, goal })).id))!;

    expect(run.status).toBe('FAILED');
    expect(run.errorCode).toBe('UNSUPPORTED_GOAL');
    expect(run.error).toBe(error.message);
    expect(deps.agents.specify).toHaveBeenCalledWith(goal, expect.any(AbortSignal));
    for (const nextStep of [deps.agents.verify, deps.agents.build, deps.agents.replan, deps.compile, deps.simulate]) expect(nextStep).not.toHaveBeenCalled();
    expect(run.attempts).toEqual([]);
    expect(run.spec).toBeUndefined();
    expect(run.scenarios).toBeUndefined();
    expect(run.evidence).toBeUndefined();
    expect(run.failureEvidence).toBeUndefined();
    expect(run.events.at(-1)).toMatchObject({ kind: 'terminal', message: error.message });
    const saved = JSON.parse(await readFile(path.join(runDirectory(run.id), 'run.json'), 'utf8'));
    expect(saved).toMatchObject({ status: 'FAILED', errorCode: 'UNSUPPORTED_GOAL', error: error.message });
  });
  it('resolves project capabilities before specification and preserves discovery activity', async () => {
    const resolveCapabilities = vi.fn(async (_goal: string, _signal?: AbortSignal, onActivity?: (message: string, details?: unknown) => void) => {
      onActivity?.('Read LED documentation.', { tool: 'read', moduleIds: ['uno', 'led'] });
      return { moduleIds: ['uno', 'led'], summary: 'Use the Uno and an LED.', documentation: 'Trusted adapter documentation.' };
    });
    const deps = dependencies({ resolveCapabilities });
    const controller = new RunController(deps);
    const run = (await controller.wait((await controller.start(request)).id))!;
    expect(run.status).toBe('VERIFIED');
    expect(resolveCapabilities.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.agents.specify).mock.invocationCallOrder[0]);
    expect(run.events).toContainEqual(expect.objectContaining({ message: 'Read LED documentation.', details: { tool: 'read', moduleIds: ['uno', 'led'] } }));
    expect(run.events).toContainEqual(expect.objectContaining({ details: { capabilityModules: ['uno', 'led'] } }));
  });
  it('freezes independent tests before build and verifies only current artifacts', async () => {
    const deps = dependencies(); const controller = new RunController(deps);
    const started = await controller.start(request); const run = (await controller.wait(started.id))!;
    expect(run.status).toBe('VERIFIED'); expect(run.attempts).toHaveLength(1);
    expect(vi.mocked(deps.agents.verify).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.agents.build).mock.invocationCallOrder[0]);
    expect(run.events.findIndex(e => e.kind === 'frozen')).toBeLessThan(run.events.findIndex(e => e.kind === 'attempt'));
    await writeFile(path.join(runDirectory(run.id), 'sketch.ino'), 'altered firmware');
    expect((await controller.get(run.id))?.status).toBe('STALE');
  });
  it('altered report cannot retain verification', async () => {
    const controller = new RunController(dependencies()); const run = (await controller.wait((await controller.start(request)).id))!;
    await writeFile(path.join(runDirectory(run.id), 'verification.json'), '{"passed":true}');
    expect((await controller.get(run.id))?.status).toBe('STALE');
  });
  it('a repeated candidate triggers one replan, then stops on another stall', async () => {
    const deps = dependencies({ build: vi.fn(async () => structuredClone(candidate)) }); deps.simulate.mockResolvedValue([result(false)]);
    const controller = new RunController(deps); const run = (await controller.wait((await controller.start(request)).id))!;
    expect(run.status).toBe('FAILED'); expect(run.attempts).toHaveLength(3); expect(run.replanCount).toBe(1);
    expect(deps.agents.replan).toHaveBeenCalledOnce(); expect(run.error).toMatch(/stalled again/);
    expect(JSON.stringify(vi.mocked(deps.agents.replan).mock.calls[0][3])).toContain('Observed off');
  });
  it('two identical failure sets trigger replanning without changing tests', async () => {
    const deps = dependencies(); deps.simulate.mockResolvedValue([result(false)]);
    const controller = new RunController(deps); const run = (await controller.wait((await controller.start(request)).id))!;
    expect(run.status).toBe('FAILED'); expect(run.replanCount).toBe(1); expect(run.attempts).toHaveLength(4);
    expect(run.scenarios).toEqual(scenarios); expect(run.spec).toEqual(spec);
  });
  it('missing check evidence and compiler errors can never succeed', async () => {
    const missing = dependencies(); missing.simulate.mockResolvedValue([{ ...result(), checks: [] }]);
    const a = new RunController(missing); expect((await a.wait((await a.start(request)).id))?.status).toBe('FAILED');
    const malformed = dependencies(); malformed.compile.mockRejectedValue(new Error('Compiler rejected malformed sketch'));
    const b = new RunController(malformed); const run = (await b.wait((await b.start(request)).id))!;
    expect(run.status).toBe('FAILED'); expect(run.evidence).toBeUndefined(); expect(malformed.simulate).not.toHaveBeenCalled();
  });
  it('cancellation cannot race into success', async () => {
    let release!: () => void;
    const deps = dependencies({ specify: vi.fn(() => new Promise<RunSpec>(resolve => { release = () => resolve(structuredClone(spec)); })) });
    const controller = new RunController(deps); const run = await controller.start(request);
    await controller.cancel(run.id); release(); const final = (await controller.wait(run.id))!;
    expect(final.status).toBe('CANCELLED'); expect(deps.compile).not.toHaveBeenCalled();
    expect(final.events.some(e => e.message.startsWith('Verified'))).toBe(false);
  });
  it.each(['circuit.svg', 'firmware.hex'])('preserves cancellation during the interphase %s write', async filename => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let entered!: () => void;
    let release!: () => void;
    const reachedWrite = new Promise<void>(resolve => { entered = resolve; });
    const resumeWrite = new Promise<void>(resolve => { release = resolve; });
    let intercepted = false;
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      await actual.writeFile(...args);
      if (!intercepted && typeof args[0] === 'string' && args[0].endsWith(`/${filename}`)) {
        intercepted = true;
        entered();
        await resumeWrite;
      }
    });
    try {
      const deps = dependencies();
      const controller = new RunController(deps);
      const run = await controller.start(request);
      await reachedWrite;
      await controller.cancel(run.id);
      release();
      const final = (await controller.wait(run.id))!;
      expect(final.status).toBe('CANCELLED');
      expect(final.error).toBe('Cancelled by user');
      expect(deps.simulate).not.toHaveBeenCalled();
      if (filename === 'circuit.svg') expect(deps.compile).not.toHaveBeenCalled();
      const cancelledAt = final.events.findIndex(event => event.kind === 'terminal' && event.message === 'Cancelled by user');
      expect(cancelledAt).toBeGreaterThanOrEqual(0);
      expect(final.events.slice(cancelledAt + 1)).toEqual([]);
    } finally {
      release();
      vi.mocked(writeFile).mockImplementation(actual.writeFile);
    }
  });
  it('hard run deadline remains a failure', async () => {
    const deps = dependencies({ specify: vi.fn((_goal, signal) => new Promise<RunSpec>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))) });
    const controller = new RunController({ ...deps, deadlineMs: 20 }); const run = (await controller.wait((await controller.start(request)).id))!;
    expect(run.status).toBe('FAILED'); expect(run.error).toMatch(/deadline/);
    expect(run.errorCode).toBeUndefined();
  });
  it('does not attach a provider error code when the run deadline aborts inference', async () => {
    const deps = dependencies({ specify: vi.fn((_goal, signal) => new Promise<RunSpec>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new AgentError('REQUEST_FAILED', 'Provider request was aborted')), { once: true }))) });
    const controller = new RunController({ ...deps, deadlineMs: 20 });
    const run = (await controller.wait((await controller.start(request)).id))!;
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatch(/deadline/);
    expect(run.errorCode).toBeUndefined();
  });
  it('model preflight rejects unavailable models before a run starts', async () => {
    const deps = dependencies({ validateModel: vi.fn(async () => { throw new Error('Model unavailable'); }) });
    await expect(new RunController(deps).start(request)).rejects.toThrow('Model unavailable');
    expect(deps.agents.specify).not.toHaveBeenCalled();
  });
  it('repair challenge must demonstrate an actual seed failure before any repair', async () => {
    const deps = dependencies(); deps.compile.mockRejectedValue(new Error('Transient compiler failure'));
    const controller = new RunController(deps);
    const run = (await controller.wait((await controller.start({ goal: 'Repair the published airlock', mode: 'airlock-repair', inference: 'fixture' })).id))!;
    expect(run.status).toBe('FAILED'); expect(run.attempts).toHaveLength(1); expect(run.failureEvidence).toBeUndefined();
    expect(run.error).toMatch(/could not be demonstrated/); expect(deps.agents.build).not.toHaveBeenCalled();
  });
  it('serializes starts even while catalog validation is pending', async () => {
    let release!: () => void;
    const deps = dependencies({ validateModel: vi.fn(() => new Promise<void>(resolve => { release = resolve; })) });
    const controller = new RunController(deps); const first = controller.start(request);
    await expect(controller.start(request)).rejects.toThrow(/already active/); release();
    await controller.wait((await first).id);
  });
});
