import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentError } from '../server/agents';
import { SimulationController, simulationChecksPass, type SimulationAgentService } from '../server/simulation-controller';
import type { smokeSimulation, verifySimulation } from '../server/simulation-browser';
import type { SimulationRun } from '../shared/simulation-run';
import type { SimulationCandidate, SimulationScenario, SimulationSpec, SimulationStep, SimulationVerification } from '../shared/simulation-types';

const spec: SimulationSpec = {
  goal: 'Model a reservoir with adjustable inflow',
  title: 'Reservoir flow',
  summary: 'Adjust inflow to see the reservoir fill.',
  assumptions: ['Inflow is measured in liters per second; volume starts at zero.'],
  controls: [{ id: 'inflow', label: 'Inflow', type: 'range', initial: 0, min: 0, max: 10, step: 0.1 }],
  observables: [{ id: 'volume', label: 'Water volume', type: 'number', unit: 'L' }],
  requirements: [{ id: 'R1', text: 'Water volume integrates the selected inflow over time.' }],
};
const scenarios: SimulationScenario[] = [{
  id: 'fills', name: 'Integrates the selected inflow', steps: [
    { type: 'input', controlId: 'inflow', value: 2 },
    { type: 'advance', durationMs: 1000 },
    { type: 'assert', id: 'volumeCheck', requirementIds: ['R1'], observable: 'volume', operator: 'approx', value: 2, tolerance: 0.001 },
  ],
}];
const candidate: SimulationCandidate = {
  id: 'flow-model', rationale: 'Integrate the selected inflow using elapsed seconds.',
  source: 'function createSimulation(){let volume=0,inflow=0;return {reset(){volume=0;inflow=0;},input(id,value){inflow=value;},step(dt){volume+=inflow*dt;},snapshot(){return {volume};},draw(ctx,w,h){ctx.clearRect(0,0,w,h);}};}',
};
const verification = (actual = 2): SimulationVerification => ({
  passed: actual === 2,
  results: [{
    scenarioId: 'fills', name: 'Integrates the selected inflow', completed: true,
    checks: [{ id: 'volumeCheck', requirementIds: ['R1'], passed: actual === 2, actual, message: `Observed ${actual} liters` }],
  }],
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function dependencies() {
  let attempt = 0;
  const agents = {
    model: 'test-simulation-model',
    validateModel: vi.fn<SimulationAgentService['validateModel']>(async () => {}),
    specify: vi.fn<SimulationAgentService['specify']>(async goal => ({ ...structuredClone(spec), goal })),
    verify: vi.fn<SimulationAgentService['verify']>(async () => structuredClone(scenarios)),
    build: vi.fn<SimulationAgentService['build']>(async () => ({ ...structuredClone(candidate), source: `${candidate.source}\n// revision ${++attempt}` })),
  };
  const verify = vi.fn<typeof verifySimulation>(async () => verification());
  const smoke = vi.fn<typeof smokeSimulation>(async () => ({ passed: true }));
  return { agents, verify, smoke };
}

describe('generated simulation completion gate', () => {
  it('requires exact independently authored checks, complete execution, and matching observations', () => {
    expect(simulationChecksPass(scenarios, verification())).toBe(true);
    const mutations: ((result: SimulationVerification) => void)[] = [
      result => { result.results = []; },
      result => { result.results.push(result.results[0]); },
      result => { result.results[0].scenarioId = 'invented'; },
      result => { result.results[0].completed = false; },
      result => { result.results[0].error = 'Execution stopped'; },
      result => { result.error = 'Runtime error'; },
      result => { result.results[0].checks = []; },
      result => { result.results[0].checks.push(result.results[0].checks[0]); },
      result => { result.results[0].checks[0].id = 'unrelated'; },
      result => { result.results[0].checks[0].requirementIds = []; },
      result => { result.results[0].checks[0].passed = false; },
      result => { result.results[0].checks[0].actual = 0; },
      result => { result.results[0].checks[0].actual = '2'; },
      result => { result.results[0].checks[0].actual = Infinity; },
      result => { delete result.results[0].checks[0].actual; },
    ];
    for (const mutate of mutations) {
      const result = verification();
      mutate(result);
      result.passed = true;
      expect(simulationChecksPass(scenarios, result)).toBe(false);
    }
    expect(simulationChecksPass([], { passed: true, results: [] })).toBe(false);
  });

  it.each([
    ['eq', 2, 2, 3], ['ne', 'idle', 'flowing', 'idle'],
    ['gt', 2, 3, 2], ['gte', 2, 2, 1], ['lt', 2, 1, 2], ['lte', 2, 2, 3],
    ['approx', 2, 2.0005, 2.002], ['eq', false, false, true],
  ] as const)('recomputes %s against actual observed values', (operator, value, passing, failing) => {
    const scenario = structuredClone(scenarios);
    const assertion = scenario[0].steps[2] as Extract<SimulationStep, { type: 'assert' }>;
    Object.assign(assertion, { operator, value });
    const result = verification();
    result.results[0].checks[0].actual = passing;
    expect(simulationChecksPass(scenario, result)).toBe(true);
    result.results[0].checks[0].actual = failing;
    expect(simulationChecksPass(scenario, result)).toBe(false);
  });
});

describe('generated simulation controller', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'simulation-controller-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('freezes the independent specification and suite before allowing a build', async () => {
    const deps = dependencies();
    const entered = deferred();
    const release = deferred<SimulationScenario[]>();
    deps.agents.verify.mockImplementation(async () => { entered.resolve(); return release.promise; });
    const controller = new SimulationController({ ...deps, directory });
    const run = await controller.start({ prompt: spec.goal });
    await entered.promise;
    const pending = await controller.get(run.id);
    expect(pending?.status).toBe('DESIGNING_TESTS');
    expect(pending?.candidate).toBeUndefined();
    expect(deps.agents.build).not.toHaveBeenCalled();
    release.resolve(structuredClone(scenarios));
    const complete = (await controller.wait(run.id))!;
    expect(complete.status).toBe('READY');
    expect(deps.agents.verify).toHaveBeenCalledWith(spec, expect.any(AbortSignal));
    expect(deps.agents.build).toHaveBeenCalledWith(spec, scenarios, { attempt: 1, previous: undefined, failures: undefined }, expect.any(AbortSignal));
    expect(JSON.parse(await readFile(path.join(directory, run.id, 'specification.json'), 'utf8'))).toEqual(spec);
    expect(JSON.parse(await readFile(path.join(directory, run.id, 'scenarios.json'), 'utf8'))).toEqual(scenarios);
  });

  it('repairs observed failures while preserving original spec and tests against dependency mutation', async () => {
    const deps = dependencies();
    deps.agents.verify.mockImplementation(async receivedSpec => {
      receivedSpec.requirements[0].text = 'A verifier cannot edit the frozen goal.';
      return structuredClone(scenarios);
    });
    const buildInputs: { spec: SimulationSpec; scenarios: SimulationScenario[] }[] = [];
    deps.agents.build.mockImplementation(async (receivedSpec, receivedScenarios, context) => {
      buildInputs.push({ spec: structuredClone(receivedSpec), scenarios: structuredClone(receivedScenarios) });
      receivedSpec.controls[0].initial = 8;
      receivedScenarios[0].steps.pop();
      return { ...candidate, source: `${candidate.source}\n// attempt ${context.attempt}` };
    });
    const failure = verification(0);
    deps.verify.mockResolvedValueOnce(failure).mockImplementation(async (artifact, receivedScenarios) => {
      artifact.spec.title = 'Runtime mutation';
      receivedScenarios[0].steps.pop();
      return verification();
    });
    const controller = new SimulationController({ ...deps, directory });
    const complete = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(complete.status).toBe('READY');
    expect(complete.attempts).toHaveLength(2);
    expect(buildInputs).toEqual([{ spec, scenarios }, { spec, scenarios }]);
    expect(complete.spec).toEqual(spec);
    expect(complete.scenarios).toEqual(scenarios);
    expect(deps.agents.specify).toHaveBeenCalledTimes(1);
    expect(deps.agents.verify).toHaveBeenCalledTimes(1);
    expect(deps.agents.build.mock.calls[1][2]).toMatchObject({ attempt: 2, previous: complete.attempts[0].candidate, failures: failure });
    expect(complete.evidence?.sourceHash).toBeTruthy();
    expect(complete.evidence?.suiteHash).toBeTruthy();
  });

  it('never becomes ready from a claimed pass with missing checks or incorrect actual state', async () => {
    const deps = dependencies();
    const missing = verification(); missing.results[0].checks = [];
    const fabricated = verification(); fabricated.results[0].checks[0].actual = 200;
    deps.verify.mockResolvedValueOnce(missing).mockResolvedValue(fabricated);
    const controller = new SimulationController({ ...deps, directory });
    const complete = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(complete.status).toBe('FAILED');
    expect(complete.attempts).toHaveLength(3);
    expect(complete.error).toMatch(/after three builds/);
    expect(complete.evidence).toBeUndefined();
    expect(complete.events.some(event => event.phase === 'READY')).toBe(false);
  });

  it('sends runtime errors back for repair and cannot lose them as a success', async () => {
    const deps = dependencies();
    deps.verify.mockRejectedValueOnce(new Error('The generated model returned a nonfinite volume'));
    const controller = new SimulationController({ ...deps, directory });
    const complete = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(complete.status).toBe('READY');
    expect(complete.attempts[0].error).toMatch(/nonfinite volume/);
    expect(deps.agents.build.mock.calls[1][2].failures).toMatchObject({ passed: false, results: [], error: expect.stringMatching(/nonfinite volume/) });
  });

  it('creates a persisted runnable draft when checks cannot be authored, without claiming verified behavior', async () => {
    const deps = dependencies();
    deps.agents.verify.mockRejectedValue(new Error('Could not cover one requirement.'));
    const controller = new SimulationController({ ...deps, directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(run.status).toBe('DRAFT');
    expect(run.warning).toContain('Could not cover one requirement.');
    expect(run.evidence).toBeUndefined();
    expect(run.draftEvidence).toMatchObject({ sourceHash: expect.any(String), specHash: expect.any(String), suiteHash: expect.any(String), runtimeVersion: expect.any(String) });
    expect(run.scenarios).toEqual([]);
    expect(deps.agents.build).toHaveBeenCalledWith(spec, [], expect.objectContaining({ draft: true, attempt: 1 }), expect.any(AbortSignal));
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.smoke).toHaveBeenCalledWith({ spec, candidate: run.candidate }, expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: expect.any(Number) }));
    expect(run.attempts[0].smoke).toEqual({ passed: true });
    expect(run.events.some(event => event.phase === 'READY')).toBe(false);
    expect(JSON.parse(await readFile(path.join(directory, run.id, 'scenarios.json'), 'utf8'))).toEqual([]);
    const restored = await new SimulationController({ ...dependencies(), directory }).get(run.id);
    expect(restored?.status).toBe('DRAFT');
    expect(restored?.draftEvidence).toEqual(run.draftEvidence);
    expect(restored?.evidence).toBeUndefined();
  });

  it('retains failed frozen checks when a model runs but behavior remains incorrect after repairs', async () => {
    const deps = dependencies();
    deps.verify.mockResolvedValue(verification(0));
    const controller = new SimulationController({ ...deps, directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(run.status).toBe('DRAFT');
    expect(run.warning).toContain('1 behavior checks still fail');
    expect(run.attempts).toHaveLength(3);
    expect(run.scenarios).toEqual(scenarios);
    expect(run.attempts.at(-1)?.verification).toEqual(verification(0));
    expect(run.evidence).toBeUndefined();
    expect(run.draftEvidence).toBeDefined();
    expect(deps.smoke).toHaveBeenCalledTimes(1);
    expect(deps.smoke.mock.calls[0][0].candidate).toEqual(run.candidate);
    for (const call of deps.agents.build.mock.calls) {
      expect(call[1]).toEqual(scenarios);
      expect(call[2].draft).toBeUndefined();
    }
  });

  it('keeps runtime crashes as failures instead of using a passing initial smoke test to hide them', async () => {
    const deps = dependencies();
    deps.verify.mockResolvedValue({ passed: false, results: [{ ...verification(0).results[0], completed: false, error: 'The model crashed after five seconds.' }] });
    const controller = new SimulationController({ ...deps, directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(run.status).toBe('FAILED');
    expect(deps.smoke).not.toHaveBeenCalled();
    expect(run.draftEvidence).toBeUndefined();
  });

  it('requires a successful runtime smoke result before exposing a verifier-failure draft', async () => {
    const deps = dependencies();
    deps.agents.verify.mockRejectedValue(new Error('Checks could not be prepared.'));
    deps.smoke.mockResolvedValue({ passed: false, error: 'The model threw during its first step.' });
    const controller = new SimulationController({ ...deps, directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(run.status).toBe('FAILED');
    expect(run.attempts).toHaveLength(3);
    expect(run.draftEvidence).toBeUndefined();
    expect(run.evidence).toBeUndefined();
    expect(deps.smoke).toHaveBeenCalledTimes(3);
    expect(deps.agents.build.mock.calls[1][2]).toMatchObject({ draft: true, failures: { passed: false, error: 'The model threw during its first step.' } });
  });

  it.each(['cancel', 'deadline'] as const)('honors %s while a draft runtime check is pending', async interruption => {
    const deps = dependencies();
    const entered = deferred();
    deps.agents.verify.mockRejectedValue(new Error('Checks unavailable.'));
    deps.smoke.mockImplementation((_artifact, options) => new Promise((_, reject) => {
      entered.resolve();
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    const controller = new SimulationController({ ...deps, directory, deadlineMs: interruption === 'deadline' ? 100 : 10000 });
    const started = await controller.start({ prompt: spec.goal });
    await entered.promise;
    if (interruption === 'cancel') await controller.cancel(started.id);
    const run = (await controller.wait(started.id))!;
    expect(run.status).toBe(interruption === 'cancel' ? 'CANCELLED' : 'FAILED');
    expect(run.draftEvidence).toBeUndefined();
    expect(run.evidence).toBeUndefined();
    expect(run.events.some(event => event.phase === 'DRAFT')).toBe(false);
  });

  it('does not convert a verifier cancellation into draft generation', async () => {
    const deps = dependencies();
    deps.agents.verify.mockRejectedValue(Object.assign(new Error('Cancelled by caller'), { code: 'CANCELLED' }));
    const controller = new SimulationController({ ...deps, directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(run.status).toBe('FAILED');
    expect(deps.agents.build).not.toHaveBeenCalled();
    expect(deps.smoke).not.toHaveBeenCalled();
  });

  it('preserves a provider content-filter refusal instead of retrying the request through the draft builder', async () => {
    const deps = dependencies();
    deps.agents.verify.mockRejectedValue(Object.assign(new Error('The provider declined this request.'), { code: 'INCOMPLETE_COMPLETION', finishReason: 'content_filter' }));
    const controller = new SimulationController({ ...deps, directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(run.status).toBe('FAILED');
    expect(run.error).toBe('The provider declined this request.');
    expect(run.draftEvidence).toBeUndefined();
    expect(deps.agents.build).not.toHaveBeenCalled();
    expect(deps.smoke).not.toHaveBeenCalled();
  });

  it.each(['length', 'content_filter'] as const)('persists and reloads a builder %s failure before any candidate is accepted', async finishReason => {
    const deps = dependencies();
    const message = finishReason === 'length'
      ? 'Simulation builder reached the model output limit. No truncated output was accepted.'
      : 'The model provider filtered the simulation builder response. No generated output was accepted.';
    deps.agents.build.mockRejectedValue(new AgentError('INCOMPLETE_COMPLETION', message, finishReason));
    const controller = new SimulationController({ ...deps, directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(run).toMatchObject({ status: 'FAILED', error: message, errorCode: 'INCOMPLETE_COMPLETION', errorFinishReason: finishReason });
    expect(run.spec).toEqual(spec);
    expect(run.scenarios).toEqual(scenarios);
    expect(run.attempts).toEqual([]);
    expect(run.candidate).toBeUndefined();
    expect(run.evidence).toBeUndefined();
    expect(run.draftEvidence).toBeUndefined();
    expect(run.events.at(-1)).toMatchObject({ phase: 'FAILED', message });
    expect(deps.agents.build).toHaveBeenCalledTimes(1);
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.smoke).not.toHaveBeenCalled();
    const stored = JSON.parse(await readFile(path.join(directory, run.id, 'run.json'), 'utf8'));
    expect(stored).toMatchObject({ errorCode: 'INCOMPLETE_COMPLETION', errorFinishReason: finishReason });
    const restoredDependencies = dependencies();
    const restored = await new SimulationController({ ...restoredDependencies, directory }).get(run.id);
    expect(restored).toEqual(run);
    expect(restoredDependencies.agents.build).not.toHaveBeenCalled();
    expect(restoredDependencies.verify).not.toHaveBeenCalled();
    expect(restoredDependencies.smoke).not.toHaveBeenCalled();
  });

  it.each(['simulation.js', 'specification.json', 'scenarios.json', 'draft-evidence.json'])('marks a draft stale when %s changes', async filename => {
    const deps = dependencies();
    deps.agents.verify.mockRejectedValue(new Error('Checks unavailable.'));
    const controller = new SimulationController({ ...deps, directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(run.status).toBe('DRAFT');
    await writeFile(path.join(directory, run.id, filename), filename.endsWith('.js') ? `${run.candidate!.source}\n// changed` : '{}');
    expect((await controller.get(run.id))?.status).toBe('STALE');
    await controller.wait(run.id);
  });

  it('can refine an unverified draft and only claims READY after the new frozen checks pass', async () => {
    const deps = dependencies();
    deps.agents.verify.mockRejectedValueOnce(new Error('Checks unavailable.'));
    const controller = new SimulationController({ ...deps, directory });
    const draft = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    const ready = (await controller.wait((await controller.start({ prompt: 'Improve the model and verify it', previousId: draft.id })).id))!;
    expect(draft.status).toBe('DRAFT');
    expect(ready.status).toBe('READY');
    expect(ready.evidence?.passed).toBe(true);
    expect(ready.draftEvidence).toBeUndefined();
    expect(ready.warning).toBeUndefined();
    expect(deps.agents.build.mock.calls[1][2]).toMatchObject({ previous: draft.candidate, previousSpec: draft.spec });
  });

  it.each(['PLANNING', 'DESIGNING_TESTS', 'BUILDING', 'CHECKING'] as const)('honors cancellation during %s, including late successful dependency results', async phase => {
    const deps = dependencies();
    const entered = deferred();
    const release = deferred();
    const gate = async () => { entered.resolve(); await release.promise; };
    if (phase === 'PLANNING') deps.agents.specify.mockImplementation(async goal => { await gate(); return { ...structuredClone(spec), goal }; });
    if (phase === 'DESIGNING_TESTS') deps.agents.verify.mockImplementation(async () => { await gate(); return structuredClone(scenarios); });
    if (phase === 'BUILDING') deps.agents.build.mockImplementation(async () => { await gate(); return structuredClone(candidate); });
    if (phase === 'CHECKING') deps.verify.mockImplementation(async () => { await gate(); return verification(); });
    const controller = new SimulationController({ ...deps, directory });
    const run = await controller.start({ prompt: spec.goal });
    await entered.promise;
    expect((await controller.get(run.id))?.status).toBe(phase);
    expect((await controller.cancel(run.id))?.status).toBe('CANCELLED');
    release.resolve();
    const complete = (await controller.wait(run.id))!;
    expect(complete.status).toBe('CANCELLED');
    expect(complete.evidence).toBeUndefined();
    expect(complete.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
    expect(complete.events.some(event => event.phase === 'READY')).toBe(false);
    if (phase === 'PLANNING' || phase === 'DESIGNING_TESTS') expect(deps.agents.build).not.toHaveBeenCalled();
  });

  it('stops at the build deadline and does not proceed to candidate generation', async () => {
    const deps = dependencies();
    deps.agents.specify.mockImplementation((_goal, signal) => new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    const controller = new SimulationController({ ...deps, directory, deadlineMs: 20 });
    const complete = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    expect(complete.status).toBe('FAILED');
    expect(complete.error).toMatch(/deadline/);
    expect(deps.agents.build).not.toHaveBeenCalled();
  });

  it('restores a verified run from disk and returns snapshots independent of controller state', async () => {
    const deps = dependencies();
    const controller = new SimulationController({ ...deps, directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    const restoredController = new SimulationController({ ...dependencies(), directory });
    const restored = (await restoredController.get(run.id))!;
    expect(restored).toEqual(run);
    restored.spec!.controls[0].initial = 9;
    restored.candidate!.source = 'mutated response';
    expect((await restoredController.get(run.id))?.candidate).toEqual(run.candidate);
    expect((await restoredController.get(run.id))?.spec).toEqual(run.spec);
  });

  it.each(['simulation.js', 'specification.json', 'scenarios.json', 'verification.json'])('marks a run stale when its saved %s changes', async filename => {
    const controller = new SimulationController({ ...dependencies(), directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    const artifactPath = path.join(directory, run.id, filename);
    await writeFile(artifactPath, filename === 'simulation.js' ? `${run.candidate!.source}\n// changed` : '{}');
    const changed = await controller.get(run.id);
    expect(changed?.status).toBe('STALE');
    expect(changed?.error).toMatch(/changed after its checks/);
    expect(changed?.events.at(-1)?.phase).toBe('STALE');
    await controller.wait(run.id);
  });

  it.each(['candidate', 'spec', 'scenarios'] as const)('rejects a persisted run.json whose %s differs from checked artifacts', async field => {
    const controller = new SimulationController({ ...dependencies(), directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    const file = path.join(directory, run.id, 'run.json');
    const stored = JSON.parse(await readFile(file, 'utf8')) as SimulationRun;
    if (field === 'candidate') stored.candidate!.source += '\n// altered unverified implementation';
    if (field === 'spec') stored.spec!.controls[0].initial = 10;
    if (field === 'scenarios') (stored.scenarios![0].steps[0] as Extract<SimulationStep, { type: 'input' }>).value = 10;
    await writeFile(file, JSON.stringify(stored));
    const restoredController = new SimulationController({ ...dependencies(), directory });
    const restored = await restoredController.get(run.id);
    expect(restored?.status).toBe('STALE');
    await restoredController.wait(run.id);
  });

  it('turns interrupted persisted builds into an explicit restart failure', async () => {
    const controller = new SimulationController({ ...dependencies(), directory });
    const run = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    const file = path.join(directory, run.id, 'run.json');
    const stored = JSON.parse(await readFile(file, 'utf8')) as SimulationRun;
    stored.status = 'BUILDING';
    await writeFile(file, JSON.stringify(stored));
    const recoveredController = new SimulationController({ ...dependencies(), directory });
    const restored = await recoveredController.get(run.id);
    expect(restored?.status).toBe('FAILED');
    expect(restored?.error).toMatch(/server restarted/);
    await recoveredController.wait(run.id);
  });

  it('retains conversation history, cumulative goals, and previous source for refinements', async () => {
    const deps = dependencies();
    const controller = new SimulationController({ ...deps, directory });
    const first = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    const prompt = 'Add a drain valve and show the outflow';
    const second = (await controller.wait((await controller.start({ prompt, previousId: first.id })).id))!;
    expect(second.status).toBe('READY');
    expect(second.parentId).toBe(first.id);
    expect(second.goal).toBe(`${spec.goal}\n\nRequested change:\n${prompt}`);
    expect(second.prompt).toBe(prompt);
    expect(second.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(deps.agents.specify.mock.calls[1][0]).toBe(second.goal);
    expect(deps.agents.specify.mock.calls[1][2]).toEqual(first.spec);
    expect(deps.agents.build.mock.calls[1][2]).toEqual({ attempt: 1, previous: first.candidate, previousSpec: first.spec, failures: undefined });
    expect(second.evidence?.sourceHash).not.toBe(first.evidence?.sourceHash);
  });

  it.each(['failed', 'cancelled'] as const)('retains ancestor source and model after a %s update produced no new artifacts', async outcome => {
    const deps = dependencies();
    const controller = new SimulationController({ ...deps, directory });
    const original = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    let interrupted: SimulationRun;
    if (outcome === 'failed') {
      deps.agents.specify.mockRejectedValueOnce(new Error('The provider was temporarily unavailable.'));
      interrupted = (await controller.wait((await controller.start({ prompt: 'Make the water blue', previousId: original.id })).id))!;
    } else {
      const entered = deferred();
      const release = deferred<SimulationSpec>();
      deps.agents.specify.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
      const started = await controller.start({ prompt: 'Make the water blue', previousId: original.id });
      await entered.promise;
      await controller.cancel(started.id);
      release.resolve({ ...structuredClone(spec), goal: started.goal });
      interrupted = (await controller.wait(started.id))!;
    }
    expect(interrupted.status).toBe(outcome === 'failed' ? 'FAILED' : 'CANCELLED');
    expect(interrupted.candidate).toBeUndefined();
    const completed = (await controller.wait((await controller.start({ prompt: 'Keep working and add volume labels', previousId: interrupted.id })).id))!;
    expect(completed.status).toBe('READY');
    expect(completed.goal).toContain('Make the water blue');
    expect(completed.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([spec.goal, 'Make the water blue', 'Keep working and add volume labels']);
    expect(deps.agents.specify.mock.calls[2][2]).toEqual(interrupted.spec ?? original.spec);
    expect(deps.agents.build.mock.calls[1][2]).toMatchObject({ previous: original.candidate, previousSpec: original.spec });
  });

  it('preserves the newest failed specification while pairing inherited source with its own specification', async () => {
    const deps = dependencies();
    const controller = new SimulationController({ ...deps, directory });
    const original = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    deps.agents.specify.mockImplementationOnce(async goal => ({ ...structuredClone(spec), goal, title: 'Reservoir with drain', assumptions: [...spec.assumptions, 'The drain removes one liter per second when open.'] }));
    deps.agents.build.mockRejectedValueOnce(new Error('The builder could not finish this request.'));
    const failed = (await controller.wait((await controller.start({ prompt: 'Add a drain valve', previousId: original.id })).id))!;
    expect(failed.status).toBe('FAILED');
    expect(failed.spec!.title).toBe('Reservoir with drain');
    expect(failed.candidate).toBeUndefined();
    const completed = (await controller.wait((await controller.start({ prompt: 'Try the drain update again', previousId: failed.id })).id))!;
    expect(completed.status).toBe('READY');
    expect(deps.agents.specify.mock.calls[2][2]).toEqual(failed.spec);
    expect(deps.agents.build.mock.calls[2][2]).toMatchObject({ previous: original.candidate, previousSpec: original.spec });
    expect(deps.agents.build.mock.calls[2][2].previousSpec).not.toEqual(failed.spec);
  });

  it('rechecks source inherited from a stale ancestor and retains that ancestor’s stale status', async () => {
    const deps = dependencies();
    const controller = new SimulationController({ ...deps, directory });
    const original = (await controller.wait((await controller.start({ prompt: spec.goal })).id))!;
    deps.agents.specify.mockRejectedValueOnce(new Error('Temporary provider failure'));
    const failed = (await controller.wait((await controller.start({ prompt: 'Add a drain valve', previousId: original.id })).id))!;
    await writeFile(path.join(directory, original.id, 'simulation.js'), `${original.candidate!.source}\n// changed on disk`);
    const completed = (await controller.wait((await controller.start({ prompt: 'Try the update again', previousId: failed.id })).id))!;
    expect((await controller.get(original.id))?.status).toBe('STALE');
    await controller.wait(original.id);
    expect(completed.status).toBe('READY');
    expect(deps.verify).toHaveBeenCalledTimes(2);
    expect(completed.evidence?.sourceHash).not.toBe(original.evidence?.sourceHash);
  });

  it('serializes starts while model preflight is pending and releases the lock afterward', async () => {
    const deps = dependencies();
    const entered = deferred();
    const release = deferred();
    deps.agents.validateModel.mockImplementation(async () => { entered.resolve(); await release.promise; });
    const controller = new SimulationController({ ...deps, directory });
    const starting = controller.start({ prompt: spec.goal });
    await entered.promise;
    await expect(controller.start({ prompt: spec.goal })).rejects.toThrow(/being built/);
    release.resolve();
    await controller.wait((await starting).id);
    deps.agents.validateModel.mockResolvedValue();
    expect((await controller.wait((await controller.start({ prompt: spec.goal })).id))?.status).toBe('READY');
  });

  it('rejects unavailable models, missing parents, and invalid requests before building', async () => {
    const deps = dependencies();
    const controller = new SimulationController({ ...deps, directory });
    await expect(controller.start({ prompt: 'x' })).rejects.toThrow(/5–5000/);
    await expect(controller.start({ prompt: 'x'.repeat(5001) })).rejects.toThrow(/5–5000/);
    await expect(controller.start({ prompt: spec.goal, previousId: 'missing' })).rejects.toThrow(/could not be found/);
    deps.agents.validateModel.mockRejectedValue(new Error('Model unavailable'));
    await expect(controller.start({ prompt: spec.goal })).rejects.toThrow(/Model unavailable/);
    expect(deps.agents.specify).not.toHaveBeenCalled();
    expect(deps.agents.build).not.toHaveBeenCalled();
    expect(await controller.get('../outside')).toBeUndefined();
  });
});
