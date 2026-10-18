import { describe, expect, it, vi } from 'vitest';
import { AgentError, CRUSOE_BASE_URL, DEFAULT_CRUSOE_MODEL } from '../server/agents.js';
import { SimulationAgents } from '../server/simulation-agents.js';
import type { SimulationCandidate, SimulationScenario, SimulationSpec } from '../shared/simulation-types.js';
import type { PortableControllerProgram } from '../shared/portable-controller.js';
import { validateSimulationCandidate } from '../shared/simulation-validation.js';

const goal = 'Simulate how a population of microbes grows as nutrients are added';
const spec: SimulationSpec = {
  goal, title: 'Microbe growth', summary: 'Explore a simplified deterministic population with a nutrient supply.',
  assumptions: ['Population begins at 100. Growth is 10 microbes per second while nutrients are supplied; no growth otherwise.'],
  controls: [{ id: 'nutrients', label: 'Supply nutrients', type: 'toggle', initial: false }],
  observables: [{ id: 'population', label: 'Population', type: 'number', unit: 'microbes' }],
  requirements: [
    { id: 'R1', text: 'Initially and on reset population is 100 and nutrients is false.' },
    { id: 'R2', text: 'With nutrients true population grows by 10 per second; setting it false stops growth.' },
  ],
};
const scenarios: SimulationScenario[] = [{
  id: 'growth-and-reset', name: 'Supply, withdraw and reset nutrients', steps: [
    { type: 'advance', durationMs: 1 },
    { type: 'assert', id: 'initial', requirementIds: ['R1'], observable: 'population', operator: 'eq', value: 100 },
    { type: 'input', controlId: 'nutrients', value: true },
    { type: 'advance', durationMs: 2000 },
    { type: 'assert', id: 'growth', requirementIds: ['R2'], observable: 'population', operator: 'approx', value: 120, tolerance: 0.1 },
    { type: 'input', controlId: 'nutrients', value: false },
    { type: 'advance', durationMs: 1000 },
    { type: 'assert', id: 'held', requirementIds: ['R2'], observable: 'population', operator: 'approx', value: 120, tolerance: 0.1 },
    { type: 'reset' },
    { type: 'advance', durationMs: 1 },
    { type: 'assert', id: 'reset', requirementIds: ['R1'], observable: 'population', operator: 'eq', value: 100 },
  ],
}];

const source = `function createSimulation() {
  let population = 100, nutrients = false;
  return {
    reset() { population = 100; nutrients = false; },
    step(dt) { if (nutrients) population += 10 * dt; },
    input(id, value) { if (id === 'nutrients') nutrients = value; },
    snapshot() { return { population }; },
    draw(ctx, width, height) { ctx.clearRect(0, 0, width, height); ctx.fillRect(20, 20, Math.min(width - 40, population), 20); }
  };
}`;
const legacyOutput = { source, rationale: 'Integrate the declared population model using elapsed simulation time.' };
const portableController: PortableControllerProgram = {
  version: 1, name: 'Nutrient supply controller', requiredCapabilities: ['serial'],
  inputs: [{ id: 'nutrients', label: 'Nutrient supply', type: 'boolean', initial: false, hardware: { kind: 'serial' } }],
  state: [],
  outputs: [{ id: 'growthRate', label: 'Commanded growth rate', type: 'number', initial: 0, hardware: { kind: 'serial' } }],
  step: [], update: [{ set: 'growthRate', value: { op: 'select', args: [{ ref: 'nutrients' }, 10, 0] } }],
};
const portableEnvironment = `function createEnvironment(controller) {
  let population = 100;
  return {
    reset() { population = 100; }, input() {},
    step(dt) { population += controller.get('growthRate') * dt; },
    snapshot() { return { population }; },
    draw(ctx, width, height) { ctx.clearRect(0, 0, width, height); ctx.fillRect(0, 0, Math.min(width, population), height); }
  };
}`;
const controllerPart = { controller: portableController, rationale: 'The serial controller determines the commanded growth rate.' };
const environmentPart = { environmentSource: portableEnvironment, rationale: 'The environment integrates population from the authoritative commanded rate.' };
const output = { ...controllerPart, ...environmentPart };
const candidate = (value = output, attempt = 1) => validateSimulationCandidate({ id: `candidate-${attempt}`, ...value });

function reviewed(suite: SimulationScenario[]) {
  return { scenarios: suite, calculations: suite.flatMap(scenario => scenario.steps.flatMap(step => step.type === 'assert'
    ? [{ scenarioId: scenario.id, assertionId: step.id, expectedValue: step.value, basis: 'Initial population plus the specified growth rate over the elapsed active time.' }]
    : [])) };
}

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

function client(outputs: unknown[], parameters: string[] = [], maxProviderTokens = 50_000) {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockResolvedValueOnce(response({ data: [{ id: DEFAULT_CRUSOE_MODEL, type: 'multimodal', tags: ['text to text', 'image text to text'], supported_parameters: parameters, top_provider: { max_completion_tokens: maxProviderTokens } }] }));
  for (const value of outputs) fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }));
  return { agents: new SimulationAgents({ apiKey: 'private-simulation-key', fetch: fetchMock }), fetchMock };
}

function sent(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, call = 1): { messages: { role: string; content: string }[]; [key: string]: unknown } {
  return JSON.parse(String(fetchMock.mock.calls[call][1]?.body));
}

describe('domain-independent simulation generation', () => {
  it('uses the shared catalog-aware transport without adding Arduino inventory constraints', async () => {
    const { agents, fetchMock } = client([spec], ['response_format', 'max_completion_tokens', 'reasoning_effort', 'chat_template_kwargs']);
    await expect(agents.specify(goal)).resolves.toEqual(spec);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([`${CRUSOE_BASE_URL}/models`, `${CRUSOE_BASE_URL}/chat/completions`]);
    const request = sent(fetchMock);
    expect(request).toMatchObject({ max_completion_tokens: 16_000, reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_object' } });
    expect(request.messages[0].content).toContain('general programmable simulation engine');
    expect(request.messages[0].content).not.toContain('Trusted installed capability module documentation');
    expect(request.messages[0].content).not.toContain('arduino:avr:uno');
    expect(JSON.parse(request.messages[1].content)).toEqual({ goal });
    expect(request.messages[0].content).toContain('Preserve the goal string exactly');
    expect(JSON.stringify(agents)).not.toContain('private-simulation-key');
    expect(fetchMock.mock.calls[1][1]?.body).not.toContain('private-simulation-key');
  });

  it('accepts newly modeled subjects without a keyword-to-scene or installed capability lookup', async () => {
    const projects = [
      { goal: 'Model commuters waiting for buses and let me change the dispatch interval', title: 'Bus dispatch', parameter: 'dispatchInterval', label: 'Dispatch interval', state: 'waiting', unit: 'commuters', initial: 5, rule: 'A bus departs every dispatchInterval seconds, reducing waiting by 10 down to zero.' },
      { goal: 'Show three interacting moons orbiting a planet', title: 'Three moon system', parameter: 'gravity', label: 'Gravity', state: 'orbitAngle', unit: 'radians', initial: 1, rule: 'Gravity sets the angular acceleration of each simplified circular orbit.' },
      { goal: 'Let me explore how a rumor spreads through a social graph', title: 'Rumor graph', parameter: 'contactRate', label: 'Contacts per second', state: 'informed', unit: 'nodes', initial: 2, rule: 'Each second, the fixed-seed graph propagates the rumor to up to contactRate connected nodes.' },
    ];
    for (const project of projects) {
      const supplied: SimulationSpec = {
        goal: project.goal, title: project.title, summary: project.goal,
        assumptions: ['A simplified deterministic model for exploring parameter effects.'],
        controls: [{ id: project.parameter, label: project.label, type: 'range', min: 0, max: 10, step: 0.1, initial: project.initial }],
        observables: [{ id: project.state, label: project.state, type: 'number', unit: project.unit }],
        requirements: [{ id: 'R1', text: project.rule }],
      };
      const { agents, fetchMock } = client([supplied]);
      await expect(agents.specify(project.goal)).resolves.toEqual(supplied);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(sent(fetchMock).messages[1].content)).toEqual({ goal: project.goal });
    }
  });

  it('carries the validated project contract into a minor visual refinement without exposing implementation', async () => {
    const refinedGoal = `${goal}\nRequested change: Make the microbes green.`;
    const refinedSpec = { ...spec, goal: refinedGoal, summary: `${spec.summary} Microbes are green.` };
    const previous = structuredClone(spec);
    const { agents, fetchMock } = client([refinedSpec]);
    await expect(agents.specify(refinedGoal, undefined, previous)).resolves.toEqual(refinedSpec);
    const request = sent(fetchMock);
    expect(JSON.parse(request.messages[1].content)).toEqual({ goal: refinedGoal, previousSpecification: spec });
    expect(request.messages[0].content).toContain('A visual refinement must not silently replace the mathematical model');
    expect(request.messages[1].content).not.toContain(source);
    expect(previous).toEqual(spec);
    expect(refinedSpec.requirements).toEqual(spec.requirements);
    expect(refinedSpec.controls).toEqual(spec.controls);
  });

  it('gives the independent verifier only the frozen model and requires structured observable checks', async () => {
    const { agents, fetchMock } = client([{ scenarios }, reviewed(scenarios)], ['reasoning_effort', 'chat_template_kwargs']);
    await expect(agents.verify(spec)).resolves.toEqual(scenarios);
    const request = sent(fetchMock);
    expect(JSON.parse(request.messages[1].content)).toEqual({ goal, specification: spec });
    expect(request.messages[0].content).toContain('never receive Builder source');
    expect(request.messages[0].content).toContain('every declared control must be exercised');
    expect(request.messages[0].content).not.toContain(source);
    expect(request).toMatchObject({ reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false } });
    const review = sent(fetchMock, 2);
    expect(review.chat_template_kwargs).toEqual({ enable_thinking: true, medium_effort: true });
    expect(JSON.parse(review.messages[1].content)).toEqual({ goal, specification: spec, draftScenarios: scenarios });
    expect(review.messages[0].content).toContain('semantic review BEFORE tests are frozen');
    expect(review.messages[0].content).not.toContain(source);
  });

  it('creates a shared controller and feeds actual failures into source repair with immutable tests', async () => {
    const repaired = { ...output, environmentSource: portableEnvironment.replace('* dt', '* dt + 0'), rationale: 'Repair numeric update without changing the frozen contract.' };
    const { agents, fetchMock } = client([output, repaired]);
    const first = await agents.build(spec, scenarios, { attempt: 1 });
    expect(first).toEqual(candidate());
    const failures = [{ scenarioId: 'growth-and-reset', assertionId: 'growth', observed: 100, expected: 120, passed: false }];
    await expect(agents.build(spec, scenarios, { attempt: 2, previous: first, failures })).resolves.toEqual(candidate(repaired, 2));
    expect(JSON.parse(sent(fetchMock, 2).messages[1].content)).toEqual({
      specification: spec, scenarios, attempt: 2, previousCandidate: { controller: portableController, environmentSource: portableEnvironment }, executionFailures: failures,
    });
    expect(sent(fetchMock, 2).messages[0].content).toContain('SAME internal state for snapshot() and draw()');
    expect(sent(fetchMock, 2).messages[0].content).toContain('step(dt)');
  });

  it.each([false, true])('corrects browser-only output instead of accepting claimed hardware support (refinement: %s)', async refinement => {
    const claimed = { ...legacyOutput, rationale: 'The simulation now includes a portable controller and supports hardware export.' };
    const previous = refinement ? { id: 'legacy', ...legacyOutput } : undefined;
    const { agents, fetchMock } = client([claimed, output]);
    const result = await agents.build(spec, scenarios, { attempt: 1, previous });
    expect(result).toEqual(candidate());
    expect(result.source).toContain('Shared controller generated from portable IR');
    const correction = JSON.parse(sent(fetchMock, 2).messages[1].content);
    expect(correction.correction.validationDiagnostic).toContain('Missing portable controller:');
    expect(correction.specification).toEqual(spec);
    expect(correction.scenarios).toEqual(scenarios);
    if (refinement) expect(correction.previousCandidate).toEqual({ source });
  });

  it('recovers persistent browser-only output by separating controller and environment generation', async () => {
    const previous = { id: 'legacy', ...legacyOutput };
    const { agents, fetchMock } = client([legacyOutput, legacyOutput, legacyOutput, controllerPart, environmentPart]);
    await expect(agents.build(spec, scenarios, { attempt: 1, previous, previousSpec: spec })).resolves.toMatchObject({ controller: portableController, environmentSource: portableEnvironment });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const controllerPayload = JSON.parse(sent(fetchMock, 4).messages[1].content);
    const environmentPayload = JSON.parse(sent(fetchMock, 5).messages[1].content);
    expect(controllerPayload).toMatchObject({ recoveryPart: 'controller', previousSimulationSource: source, specification: spec, scenarios });
    expect(environmentPayload).toMatchObject({ recoveryPart: 'environment', previousSimulationSource: source, frozenController: portableController, specification: spec, scenarios });
  });

  it('fails within a bounded budget if recovery still returns browser-only code', async () => {
    const { agents, fetchMock } = client(Array.from({ length: 6 }, () => legacyOutput));
    await expect(agents.build(spec, scenarios, { attempt: 1 })).rejects.toMatchObject({ code: 'INVALID_SIMULATION_BUILDER' });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('preserves an existing portable controller instead of downgrading it to simulation-only', async () => {
    const simulationOnly = { ...legacyOutput, hardwareUnavailableReason: 'A board has not been selected.' };
    const { agents, fetchMock } = client([simulationOnly, output]);
    await expect(agents.build(spec, scenarios, { attempt: 1, previous: candidate() })).resolves.toEqual(candidate());
    expect(JSON.parse(sent(fetchMock, 2).messages[1].content).correction.validationDiagnostic).toContain('Preserve existing portable controllers');
  });

  it('keeps old saved source readable and requires a specific limitation for new simulation-only output', async () => {
    expect(validateSimulationCandidate({ id: 'legacy', ...legacyOutput })).toEqual({ id: 'legacy', ...legacyOutput });
    const unsupported = { ...legacyOutput, hardwareUnavailableReason: 'The requested control law requires unbounded dynamically generated expressions.' };
    const { agents } = client([unsupported]);
    await expect(agents.build(spec, scenarios, { attempt: 1 })).resolves.toEqual({ id: 'candidate-1', ...unsupported });
  });

  it('treats controller preparation as architecture instead of inventing simulated export behavior', async () => {
    const refinementGoal = `${goal}\n\nRequested change:\nCreate a portable controller for hardware export.`;
    const refinedSpec = { ...spec, goal: refinementGoal };
    const { agents, fetchMock } = client([refinedSpec]);
    await agents.specify(refinementGoal, undefined, spec);
    const request = sent(fetchMock);
    expect(request.messages[0].content).toContain('The application handles board selection, compilation, export and upload outside the simulation');
    expect(request.messages[0].content).toContain('remove those artificial controls, observables and requirements');
    expect(JSON.parse(request.messages[1].content)).toEqual({ goal: refinementGoal, previousSpecification: spec });
  });

  it('keeps repair context focused and pairs previous source with its own project contract', async () => {
    const repaired = { ...output, environmentSource: portableEnvironment.replace('* dt', '* dt + 0') };
    const { agents, fetchMock } = client([repaired], ['chat_template_kwargs']);
    const previousSpec = { ...spec, title: 'Earlier microbe model' };
    const evidence = { passed: false, results: [{
      scenarioId: 'growth-and-reset', completed: true,
      checks: [
        { id: 'initial', requirementIds: ['R1'], passed: true, actual: 100, message: 'Passing check should not be repeated.' },
        { id: 'growth', requirementIds: ['R2'], passed: false, actual: 100, message: 'Expected population 120; observed 100.' },
      ],
    }] };
    await agents.build(spec, scenarios, { attempt: 2, previous: candidate(), previousSpec, failures: evidence });
    const request = sent(fetchMock);
    expect(request.chat_template_kwargs).toEqual({ enable_thinking: true, medium_effort: true });
    const payload = JSON.parse(request.messages[1].content);
    expect(payload.specification).toEqual(spec);
    expect(payload.previousSpecification).toEqual(previousSpec);
    expect(payload.executionFailures).toEqual({ failedCheckCount: 1, scenarios: [{
      scenarioId: 'growth-and-reset', failedChecks: [{ id: 'growth', requirementIds: ['R2'], actual: 100, message: 'Expected population 120; observed 100.' }],
    }] });
    expect(request.messages[1].content).not.toContain('Passing check should not be repeated.');
  });

  it('permits an empty acceptance suite only for an explicit unverified draft build', async () => {
    const draft = client([output]);
    await expect(draft.agents.build(spec, [], { attempt: 1, draft: true })).resolves.toEqual(candidate());
    const request = sent(draft.fetchMock);
    expect(JSON.parse(request.messages[1].content)).toEqual({ specification: spec, scenarios: [], attempt: 1, draft: true });
    expect(request.messages[0].content).toContain('application will label this result unverified');
    const normal = client([]);
    await expect(normal.agents.build(spec, [], { attempt: 1 })).rejects.toThrow('scenario suite');
    expect(normal.fetchMock).not.toHaveBeenCalled();
  });

  it('retains specification, supplied-suite, and source validation for draft builds', async () => {
    const invalid = client([]);
    await expect(invalid.agents.build({ ...spec, title: '' }, [], { attempt: 1, draft: true })).rejects.toThrow('title');
    await expect(invalid.agents.build(spec, [{ ...scenarios[0], steps: [] }], { attempt: 1, draft: true })).rejects.toThrow('Scenario steps');
    expect(invalid.fetchMock).not.toHaveBeenCalled();
    const badSource = { source: 'No factory or executable simulation here.', rationale: 'Incomplete.', hardwareUnavailableReason: 'Controller needs unbounded dynamically generated expressions.' };
    const generated = client([badSource, badSource, badSource]);
    await expect(generated.agents.build(spec, [], { attempt: 1, draft: true })).rejects.toMatchObject({ code: 'INVALID_SIMULATION_BUILDER' });
  });

  it('corrects malformed JSON and schema errors at most twice before failing closed', async () => {
    const badSpec = { ...spec, goal: 'silently substituted goal' };
    const { agents, fetchMock } = client(['not JSON', badSpec, spec]);
    await expect(agents.specify(goal)).resolves.toEqual(spec);
    const firstCorrection = JSON.parse(sent(fetchMock, 2).messages[1].content).correction;
    expect(firstCorrection.validationDiagnostic).toContain('invalid JSON');
    const secondCorrection = JSON.parse(sent(fetchMock, 3).messages[1].content).correction;
    expect(secondCorrection.previousOutput).toEqual(badSpec);
    expect(secondCorrection.instruction).toContain('Correction 2 of 2');
    const bad = client(['not JSON', 'still not JSON', 'never JSON']);
    await expect(bad.agents.specify(goal)).rejects.toMatchObject({ code: 'INVALID_SIMULATION_SPECIFIER' });
    expect(bad.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reports the last validation diagnostic while redacting credentials', async () => {
    const invalid = { ...spec, controls: [{ ...spec.controls[0], type: 'private-simulation-key' }] };
    const { agents, fetchMock } = client([invalid, invalid, invalid]);
    const error = await agents.specify(goal).catch(reason => reason);
    expect(String(error)).toContain('Unsupported control type: [redacted]');
    expect(String(error)).not.toContain('private-simulation-key');
    expect(JSON.parse(sent(fetchMock, 2).messages[1].content).correction.validationDiagnostic).toContain('[redacted]');
  });

  it('repairs invalid test coverage before freezing and never sends it to a builder', async () => {
    const missingCoverage = structuredClone(scenarios);
    missingCoverage[0].steps = missingCoverage[0].steps.filter(step => step.type !== 'input');
    const { agents, fetchMock } = client([{ scenarios: missingCoverage }, { scenarios }, reviewed(scenarios)]);
    await expect(agents.verify(spec)).resolves.toEqual(scenarios);
    const correction = JSON.parse(sent(fetchMock, 2).messages[1].content).correction;
    expect(correction.previousOutput).toEqual({ scenarios: missingCoverage });
    expect(correction.instruction).toContain('Do not remove coverage, weaken checks');
    expect(sent(fetchMock, 2).messages[0].content).toContain('independent Verifier');
  });

  it('shares the two-correction budget across verifier draft and semantic review', async () => {
    const invalid = { scenarios: [] };
    const { agents, fetchMock } = client([invalid, { scenarios }, invalid, invalid]);
    await expect(agents.verify(spec)).rejects.toMatchObject({ code: 'INVALID_SIMULATION_VERIFIER' });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const reviewCorrection = JSON.parse(sent(fetchMock, 4).messages[1].content).correction;
    expect(reviewCorrection.instruction).toContain('Correction 2 of 2 across this role');
  });

  it('requires the independent review to justify every final expected value', async () => {
    const incompleteReview = reviewed(scenarios);
    incompleteReview.calculations.pop();
    const { agents, fetchMock } = client([{ scenarios }, incompleteReview, reviewed(scenarios)]);
    await expect(agents.verify(spec)).resolves.toEqual(scenarios);
    const correction = JSON.parse(sent(fetchMock, 3).messages[1].content).correction;
    expect(correction.validationDiagnostic).toContain('Every final assertion');
    expect(sent(fetchMock, 2).messages[0].content).toContain('Check the dimensions');
    expect(sent(fetchMock, 3).messages[1].content).not.toContain(source);
  });

  it('rejects unchanged failed source even if the builder changes its rationale', async () => {
    const simulationOnly = { ...legacyOutput, hardwareUnavailableReason: 'Controller needs unbounded dynamically generated expressions.' };
    const previous: SimulationCandidate = { id: 'candidate-1', ...simulationOnly };
    const { agents, fetchMock } = client([simulationOnly, simulationOnly, simulationOnly]);
    await expect(agents.build(spec, scenarios, { attempt: 2, previous, failures: { error: 'bad integration' } })).rejects.toMatchObject({ code: 'INVALID_SIMULATION_BUILDER' });
    const correction = JSON.parse(sent(fetchMock, 2).messages[1].content).correction;
    expect(correction.validationDiagnostic).toContain('Make a real source change');
    expect(JSON.parse(sent(fetchMock, 2).messages[1].content).scenarios).toEqual(scenarios);
  });

  it('propagates cancellation and provider errors without retrying them or leaking response bodies', async () => {
    const cancelled = client([]);
    await expect(cancelled.agents.specify(goal, AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cancelled.fetchMock).not.toHaveBeenCalled();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-simulation-key', { status: 401 }));
    const agents = new SimulationAgents({ apiKey: 'private-simulation-key', fetch: fetchMock });
    const error: unknown = await agents.specify(goal).catch(reason => reason);
    expect(error).toBeInstanceOf(AgentError);
    expect(String(error)).toContain('HTTP 401');
    expect(String(error)).not.toContain('private-simulation-key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a length-truncated completion once with bounded additional tokens', async () => {
    const { agents, fetchMock } = client([], ['max_completion_tokens']);
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '{"goal":' } }] }));
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(spec) } }] }));
    await expect(agents.specify(goal)).resolves.toEqual(spec);
    expect(sent(fetchMock).max_completion_tokens).toBe(16_000);
    expect(sent(fetchMock, 2).max_completion_tokens).toBe(24_000);
    const payload = JSON.parse(sent(fetchMock, 2).messages[1].content);
    expect(payload.correction.instruction).toContain('Output-length recovery 1 of 1');
    expect(payload.correction.instruction).not.toContain('Correction 1 of 2');
  });

  it('recovers a builder length limit after both schema corrections without losing the repair context', async () => {
    const invalid = { source: 'Not a simulation factory.', rationale: 'Incomplete implementation.' };
    const { agents, fetchMock } = client([invalid, invalid], ['max_completion_tokens', 'chat_template_kwargs']);
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: 'TRUNCATED_SOURCE_MUST_NOT_BE_REUSED' } }] }));
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
    await expect(agents.build(spec, scenarios, { attempt: 1 })).resolves.toEqual(candidate());
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const schemaCorrection = JSON.parse(sent(fetchMock, 3).messages[1].content).correction;
    const recoveryRequest = sent(fetchMock, 4);
    const recovery = JSON.parse(recoveryRequest.messages[1].content);
    expect(recovery.correction.previousOutput).toEqual(invalid);
    expect(recovery.correction.validationDiagnostic).toBe(schemaCorrection.validationDiagnostic);
    expect(recovery.correction.instruction).toContain('Output-length recovery 1 of 1');
    expect(recovery.specification).toEqual(spec);
    expect(recovery.scenarios).toEqual(scenarios);
    expect(recoveryRequest.max_completion_tokens).toBe(24_000);
    expect(recoveryRequest.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(JSON.stringify(recoveryRequest)).not.toContain('TRUNCATED_SOURCE_MUST_NOT_BE_REUSED');
  });

  it('keeps both schema corrections available after output-length recovery', async () => {
    const invalid = { ...spec, goal: 'silently substituted goal' };
    const { agents, fetchMock } = client([]);
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '{"goal":' } }] }));
    for (const result of [invalid, invalid, spec]) {
      fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
    }
    await expect(agents.specify(goal)).resolves.toEqual(spec);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(JSON.parse(sent(fetchMock, 3).messages[1].content).correction.instruction).toContain('Correction 1 of 2');
    expect(JSON.parse(sent(fetchMock, 4).messages[1].content).correction.instruction).toContain('Correction 2 of 2');
  });

  it('retains the portable builder correction allowance after malformed JSON', async () => {
    const invalidPortable = { controller: { version: 1 }, environmentSource: 'function createEnvironment(controller) {}', rationale: 'Missing controller fields.' };
    const { agents, fetchMock } = client([invalidPortable, 'malformed JSON', 'still malformed JSON', output]);
    await expect(agents.build(spec, scenarios, { attempt: 1 })).resolves.toEqual(candidate());
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(JSON.parse(sent(fetchMock, 4).messages[1].content).correction.instruction).toContain('Correction 3 of 3');
  });

  it('allows the shared verifier length recovery after its two schema corrections', async () => {
    const invalid = { scenarios: [] };
    const { agents, fetchMock } = client([invalid, { scenarios }, invalid]);
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '{"calculations":' } }] }));
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reviewed(scenarios)) } }] }));
    await expect(agents.verify(spec)).resolves.toEqual(scenarios);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const recovery = JSON.parse(sent(fetchMock, 5).messages[1].content);
    expect(recovery.correction.previousOutput).toEqual(invalid);
    expect(recovery.correction.instruction).toContain('Output-length recovery 1 of 1');
    expect(recovery.draftScenarios).toEqual(scenarios);
    expect(recovery.specification).toEqual(spec);
  });

  it('shares one output-length recovery across verifier draft and semantic review', async () => {
    const { agents, fetchMock } = client([]);
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '{"scenarios":' } }] }));
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ scenarios }) } }] }));
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '{"calculations":' } }] }));
    await expect(agents.verify(spec)).rejects.toMatchObject({ code: 'INCOMPLETE_COMPLETION', finishReason: 'length' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry a filtered completion after a schema correction', async () => {
    const invalid = { ...spec, goal: 'silently substituted goal' };
    const { agents, fetchMock } = client([invalid]);
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'content_filter', message: { content: '{}' } }] }));
    await expect(agents.specify(goal)).rejects.toMatchObject({ code: 'INCOMPLETE_COMPLETION', finishReason: 'content_filter' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('falls back to direct generation when a repair exhausts its reasoning budget', async () => {
    const { agents, fetchMock } = client([], ['max_completion_tokens', 'chat_template_kwargs']);
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'Provider exhausted its reasoning budget.' } }] }));
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...output, environmentSource: portableEnvironment.replace('* dt', '* dt + 0') }) } }] }));
    await agents.build(spec, scenarios, { attempt: 2, previous: candidate(), failures: { error: 'Wrong state' } });
    expect(sent(fetchMock).chat_template_kwargs).toEqual({ enable_thinking: true, medium_effort: true });
    expect(sent(fetchMock, 2).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent(fetchMock, 2).max_completion_tokens).toBe(24_000);
    expect(JSON.parse(sent(fetchMock, 2).messages[1].content).specification).toEqual(spec);
    expect(JSON.parse(sent(fetchMock, 2).messages[1].content).scenarios).toEqual(scenarios);
  });

  it('recovers repeated builder truncation by generating one frozen controller and its separate environment', async () => {
    const { agents, fetchMock } = client([], ['chat_template_kwargs']);
    for (let attempt = 0; attempt < 2; attempt++) fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: 'TRUNCATED_DO_NOT_REUSE' } }] }));
    for (const part of [controllerPart, environmentPart]) fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(part) } }] }));
    const candidate = await agents.build(spec, scenarios, { attempt: 1 });
    expect(candidate.controller).toEqual(portableController);
    expect(candidate.environmentSource).toBe(portableEnvironment);
    expect(candidate.source).toContain('Shared controller generated from portable IR');
    expect(candidate.source).toContain(portableEnvironment);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const controllerPayload = JSON.parse(sent(fetchMock, 3).messages[1].content);
    const environmentPayload = JSON.parse(sent(fetchMock, 4).messages[1].content);
    expect(controllerPayload).toMatchObject({ recoveryPart: 'controller', specification: spec, scenarios });
    expect(environmentPayload).toMatchObject({ recoveryPart: 'environment', frozenController: portableController, specification: spec, scenarios });
    expect(sent(fetchMock, 3).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(JSON.stringify([controllerPayload, environmentPayload])).not.toContain('TRUNCATED_DO_NOT_REUSE');
  });

  it('decomposes an unchanged portable repair once while preserving its frozen specification and suite', async () => {
    const brokenController = { ...portableController, update: [{ set: 'growthRate', value: 0 }] };
    const broken = { controller: brokenController, ...environmentPart };
    const previous = validateSimulationCandidate({ id: 'candidate-1', ...broken });
    const { agents, fetchMock } = client([broken, broken, broken, broken, controllerPart, environmentPart], ['chat_template_kwargs']);
    const candidate = await agents.build(spec, scenarios, { attempt: 2, previous, failures: { error: 'Population never increases after nutrients is true.' } });
    expect(candidate.controller).toEqual(portableController);
    expect(candidate.source).not.toBe(previous.source);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    const controllerPayload = JSON.parse(sent(fetchMock, 5).messages[1].content);
    const environmentPayload = JSON.parse(sent(fetchMock, 6).messages[1].content);
    expect(controllerPayload.previousController).toEqual(brokenController);
    expect(environmentPayload.frozenController).toEqual(portableController);
    expect(environmentPayload.previousEnvironmentSource).toBe(portableEnvironment);
    expect(environmentPayload.previousController).toBeUndefined();
    expect(environmentPayload.previousCandidate).toBeUndefined();
    for (let call = 1; call <= 6; call++) {
      const payload = JSON.parse(sent(fetchMock, call).messages[1].content);
      expect(payload.specification).toEqual(spec);
      expect(payload.scenarios).toEqual(scenarios);
    }
    expect(sent(fetchMock, 5).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent(fetchMock, 6).chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it.each(['combined', 'controller', 'environment'] as const)('stops a filtered %s builder response without further fallback', async stage => {
    const { agents, fetchMock } = client([]);
    if (stage !== 'combined') {
      for (let attempt = 0; attempt < 2; attempt++) fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '' } }] }));
      if (stage === 'environment') fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(controllerPart) } }] }));
    }
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'content_filter', message: { content: '{}' } }] }));
    await expect(agents.build(spec, scenarios, { attempt: 1 })).rejects.toMatchObject({ code: 'INCOMPLETE_COMPLETION', finishReason: 'content_filter' });
    expect(fetchMock).toHaveBeenCalledTimes(stage === 'combined' ? 2 : stage === 'controller' ? 4 : 5);
  });

  it('rejects an invalid split environment within a bounded budget without accepting or restarting the split', async () => {
    const { agents, fetchMock } = client([]);
    for (let attempt = 0; attempt < 2; attempt++) fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '' } }] }));
    fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(controllerPart) } }] }));
    for (let attempt = 0; attempt < 3; attempt++) fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ environmentSource: 'Invalid environment factory.', rationale: 'Incomplete.' }) } }] }));
    await expect(agents.build(spec, scenarios, { attempt: 1 })).rejects.toMatchObject({ code: 'INVALID_SIMULATION_BUILDER' });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const call of [4, 5, 6]) expect(JSON.parse(sent(fetchMock, call).messages[1].content).frozenController).toEqual(portableController);
  });

  it.each(['keyboard', 'observable'] as const)('enforces %s bindings before accepting a split controller', async invalidBinding => {
    const requestedSpec: SimulationSpec = invalidBinding === 'keyboard'
      ? { ...spec, controls: [{ id: 'nutrients', label: 'Nutrients', type: 'key', initial: false, key: 'n' }] } : spec;
    const invalidController: PortableControllerProgram = invalidBinding === 'keyboard'
      ? { ...portableController, inputs: [{ ...portableController.inputs[0], hardware: { kind: 'digital-input' } }] }
      : { ...portableController, outputs: [...portableController.outputs, { id: 'population', label: 'Invalid conflicting observable', type: 'boolean', initial: false, hardware: { kind: 'serial' } }] };
    const { agents, fetchMock } = client([]);
    for (let attempt = 0; attempt < 2; attempt++) fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '' } }] }));
    for (let attempt = 0; attempt < 4; attempt++) fetchMock.mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...controllerPart, controller: invalidController }) } }] }));
    await expect(agents.build(requestedSpec, scenarios, { attempt: 1 })).rejects.toThrow(invalidBinding === 'keyboard' ? 'requires a boolean serial controller input' : 'must match its declared number type');
    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const call of [3, 4, 5, 6]) expect(JSON.parse(sent(fetchMock, call).messages[1].content).recoveryPart).toBe('controller');
  });

  it('does not retry provider filtering or repeated token exhaustion', async () => {
    for (const finishReason of ['content_filter', 'length'] as const) {
      const { agents, fetchMock } = client([]);
      const truncated = response({ choices: [{ finish_reason: finishReason, message: { content: '{}' } }] });
      fetchMock.mockResolvedValueOnce(truncated);
      if (finishReason === 'length') fetchMock.mockResolvedValueOnce(truncated.clone());
      await expect(agents.specify(goal)).rejects.toMatchObject({ code: 'INCOMPLETE_COMPLETION', finishReason });
      expect(fetchMock).toHaveBeenCalledTimes(finishReason === 'length' ? 3 : 2);
    }
  });
});
