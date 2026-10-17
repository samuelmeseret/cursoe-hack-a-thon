import { describe, expect, it, vi } from 'vitest';
import { AgentError, CRUSOE_BASE_URL, CrusoeAgents, DEFAULT_CRUSOE_MODEL } from '../server/agents.js';
import { airlockScenarios, airlockSpec } from '../shared/fixtures.js';
import type { Candidate, RunSpec, Scenario } from '../shared/types.js';
import { validateSuite } from '../shared/validation.js';

const goal = 'Pressing the request button produces one 500 ms status pulse.';
const specification: RunSpec = {
  goal,
  assumptions: ['Buttons connect to ground using the Uno internal pull-up.'],
  components: [
    { id: 'request', kind: 'button', label: 'Request', meaning: 'Requests one status pulse' },
    { id: 'status', kind: 'led', label: 'Status', meaning: 'Indicates the active pulse' },
  ],
  requirements: [
    { id: 'R1', text: 'Drive the status LED off within 100 ms of reset.' },
    { id: 'R2', text: 'A request stable for 20 ms turns the status LED on within 100 ms.' },
    { id: 'R3', text: 'The LED pulse lasts 500 ms with a 50 ms tolerance.' },
  ],
};
const scenarios: Scenario[] = [{
  id: 'request-pulse', name: 'Startup and request pulse', durationMs: 1000,
  inputs: [{ atMs: 200, componentId: 'request', pressed: true }, { atMs: 300, componentId: 'request', pressed: false }],
  assertions: [
    { id: 'startup-off', requirementIds: ['R1'], type: 'level', signal: 'status', value: 0, driven: true, fromMs: 100, toMs: 190 },
    { id: 'request-on', requirementIds: ['R2'], type: 'transition', signal: 'status', edge: 'rising', minCount: 1, maxCount: 1, fromMs: 220, toMs: 320 },
    { id: 'pulse-duration', requirementIds: ['R3'], type: 'duration', signal: 'status', value: 1, minMs: 450, maxMs: 550, minCount: 1, fromMs: 190, toMs: 900 },
  ],
}];
const candidateOutput = {
  source: 'void setup() { pinMode(2, INPUT_PULLUP); pinMode(3, OUTPUT); digitalWrite(3, LOW); }\nvoid loop() { digitalWrite(3, !digitalRead(2)); }',
  pins: [{ componentId: 'request', pin: 2 }, { componentId: 'status', pin: 3 }],
  rationale: 'Use an input pull-up and an active-high status output.',
};
const candidate: Candidate = { id: 'candidate-1', ...candidateOutput };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function completion(output: unknown, finishReason = 'stop'): Response {
  return jsonResponse({ choices: [{ message: { role: 'assistant', content: typeof output === 'string' ? output : JSON.stringify(output) }, finish_reason: finishReason }] });
}
function client(outputs: unknown[] = [], supported: string[] = [], config: { timeoutMs?: number; maxProviderTokens?: number } = {}) {
  const { maxProviderTokens = 9000, ...agentConfig } = config;
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: DEFAULT_CRUSOE_MODEL, type: 'chat', supported_parameters: supported, top_provider: { max_completion_tokens: maxProviderTokens } }] }));
  for (const output of outputs) fetchMock.mockResolvedValueOnce(completion(output));
  return { agents: new CrusoeAgents({ apiKey: 'server-test-secret', fetch: fetchMock, ...agentConfig }), fetchMock };
}
function sentBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index = 1) {
  return JSON.parse(String(fetchMock.mock.calls[index][1]?.body)) as Record<string, any>;
}

describe('Crusoe catalog preflight and server requests', () => {
  it('validates the configured model before any completion and honors advertised capabilities', async () => {
    const { agents, fetchMock } = client([specification], ['response_format', 'temperature', 'reasoning_effort', 'max_completion_tokens', 'chat_template_kwargs']);
    await expect(agents.specify(goal)).resolves.toEqual(specification);
    expect(fetchMock.mock.calls[0][0]).toBe(`${CRUSOE_BASE_URL}/models`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${CRUSOE_BASE_URL}/chat/completions`);
    expect(sentBody(fetchMock)).toMatchObject({
      model: DEFAULT_CRUSOE_MODEL,
      response_format: { type: 'json_object' }, temperature: 0.2, reasoning_effort: 'low', max_completion_tokens: 9000, chat_template_kwargs: { thinking: false },
    });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer server-test-secret' });
    expect(fetchMock.mock.calls[1][1]?.redirect).toBe('error');
    expect(fetchMock.mock.calls[1][1]?.body).not.toContain('server-test-secret');
    expect(JSON.stringify(agents)).not.toContain('server-test-secret');
    expect(sentBody(fetchMock).messages[0].content).toContain('A response deadline is never a simultaneity window');
    expect(sentBody(fetchMock).messages[0].content).toContain('Unless the goal explicitly defines a tie window');
  });

  it('omits optional parameters when the catalog does not advertise them', async () => {
    const { agents, fetchMock } = client([specification]);
    await agents.specify(goal);
    expect(Object.keys(sentBody(fetchMock)).sort()).toEqual(['messages', 'model']);
  });

  it('rejects a missing model before generating anything', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ data: [{ id: 'a-different-model' }] }));
    const agents = new CrusoeAgents({ apiKey: 'secret', model: 'unavailable-model', fetch: fetchMock });
    await expect(agents.specify(goal)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes the catalog for each explicit preflight', async () => {
    const { agents, fetchMock } = client();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await agents.validateModel();
    await expect(agents.validateModel()).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not make a network request without a server API key', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const agents = new CrusoeAgents({ apiKey: '', fetch: fetchMock });
    expect(agents.keyConfigured).toBe(false);
    await expect(agents.validateModel()).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redacts HTTP response bodies and low-level network error details', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('server-test-secret echoed private payload', { status: 401 }));
    const agents = new CrusoeAgents({ apiKey: 'server-test-secret', fetch: fetchMock });
    await expect(agents.validateModel()).rejects.toThrow('HTTP 401');
    fetchMock.mockRejectedValueOnce(new Error('Authorization: server-test-secret private payload'));
    const error = await agents.validateModel().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AgentError);
    expect(String(error)).not.toContain('server-test-secret');
    expect(String(error)).not.toContain('private payload');
  });

  it('cancels an in-flight request and returns a sanitized cancellation', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const agents = new CrusoeAgents({ apiKey: 'secret', fetch: fetchMock });
    const controller = new AbortController();
    const pending = agents.validateModel(controller.signal);
    controller.abort(new Error('private cancellation reason'));
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('rejects an already cancelled run without sending a request', async () => {
    const { agents, fetchMock } = client();
    const controller = new AbortController();
    controller.abort();
    await expect(agents.validateModel(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-chat models and malformed supported-parameter catalogs', async () => {
    for (const model of [{ type: 'embedding' }, { supported_parameters: [123] }]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ data: [{ id: DEFAULT_CRUSOE_MODEL, ...model }] }));
      const agents = new CrusoeAgents({ apiKey: 'secret', fetch: fetchMock });
      await expect(agents.validateModel()).rejects.toBeInstanceOf(AgentError);
    }
  });

  it('enforces a timeout even if a fetch implementation ignores abort', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const agents = new CrusoeAgents({ apiKey: 'secret', fetch: fetchMock, timeoutMs: 5 });
    await expect(agents.validateModel()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});

describe('isolated, typed agent roles', () => {
  it('sends the independent verifier only the goal and specification', async () => {
    const { agents, fetchMock } = client([{ scenarios }, { scenarios }]);
    const before = JSON.stringify(specification);
    await expect(agents.verify(goal, specification)).resolves.toEqual(scenarios);
    const request = sentBody(fetchMock);
    expect(JSON.parse(request.messages[1].content)).toEqual({ goal, specification });
    expect(request.messages[0].content).toContain('never Builder code');
    const reviewPayload = JSON.parse(sentBody(fetchMock, 2).messages[1].content);
    expect(reviewPayload).toMatchObject({ goal, specification, draftScenarios: scenarios });
    expect(Object.keys(reviewPayload).sort()).toEqual(['draftScenarios', 'goal', 'inputTimeline', 'responseTimingRules', 'specification']);
    expect(reviewPayload.responseTimingRules).toEqual([{ requirementId: 'R2', debounceMs: 20, responseWithinMs: 100 }]);
    expect(reviewPayload.inputTimeline[0].buttons[0].pressedIntervals).toEqual([{
      pressedAtMs: 200, heldUntilMs: 300, releasedAtMs: 300,
      responseWindows: [{ requirementId: 'R2', becomesStable: true, stableAtMs: 220, deadlineAtMs: 320 }],
    }]);
    expect(sentBody(fetchMock, 2).messages[0].content).toContain('ACTUAL input events');
    expect(JSON.stringify(specification)).toBe(before);
  });

  it('returns a deterministic candidate ID and sends concrete diagnostics to the Builder', async () => {
    const { agents, fetchMock } = client([candidateOutput]);
    const failures = [{ id: 'pulse-duration', passed: false, message: 'Observed 100 ms; expected 450–550 ms.' }];
    await expect(agents.build(specification, scenarios, { attempt: 2, previous: candidate, failures, replan: 'Use an independent pulse timer.' })).resolves.toEqual({ ...candidate, id: 'candidate-2' });
    expect(JSON.parse(sentBody(fetchMock).messages[1].content)).toMatchObject({ specification, scenarios, attempt: 2,
      previousCandidate: { id: candidate.id, source: candidate.source, pins: candidate.pins },
      failureSummary: { failedCheckCount: 1, firstFailure: { checkId: 'pulse-duration', message: failures[0].message } },
      implementationReplan: 'Use an independent pulse timer.' });
    expect(sentBody(fetchMock).messages[2].content).toContain('Do not return the same source');
  });

  it('stably orders draft and reviewed timed inputs without changing their values or assertions', async () => {
    const spec = structuredClone(specification);
    spec.components.push({ id: 'otherRequest', kind: 'button', label: 'Other request', meaning: 'Another request input' });
    const unordered = structuredClone(scenarios);
    unordered[0].inputs = [
      { atMs: 300, componentId: 'request', pressed: false },
      { atMs: 200, componentId: 'otherRequest', pressed: true },
      { atMs: 200, componentId: 'request', pressed: true },
    ];
    const before = JSON.stringify(unordered);
    const expected = structuredClone(unordered);
    expected[0].inputs = [unordered[0].inputs[1], unordered[0].inputs[2], unordered[0].inputs[0]];
    const { agents, fetchMock } = client([{ scenarios: unordered }, { scenarios: unordered }]);
    await expect(agents.verify(goal, spec)).resolves.toEqual(expected);
    expect(JSON.parse(sentBody(fetchMock, 2).messages[1].content).draftScenarios).toEqual(expected);
    expect(JSON.stringify(unordered)).toBe(before);
    expect(() => validateSuite(unordered, spec)).toThrow('Button inputs must be ordered by time');
  });

  it('still rejects invalid references and values when ordering agent inputs', async () => {
    for (const invalidEvent of [
      { atMs: 200, componentId: 'unknown-button', pressed: true },
      { atMs: 200, componentId: 'request', pressed: 'true' },
      { atMs: '200', componentId: 'request', pressed: true },
      { atMs: -1, componentId: 'request', pressed: true },
      { atMs: 200, componentId: 'request', pressed: true, code: 'doSomething()' },
    ]) {
      const output = { scenarios: [{ ...scenarios[0], inputs: [scenarios[0].inputs[1], invalidEvent] }] };
      const { agents, fetchMock } = client([output, output, output]);
      await expect(agents.verify(goal, specification)).rejects.toMatchObject({ code: 'INVALID_SUITE' });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    }
  });

  it('accepts a whole fenced JSON object but rejects prose or truncated output', async () => {
    const first = client([`\`\`\`json\n${JSON.stringify(specification)}\n\`\`\``]);
    await expect(first.agents.specify(goal)).resolves.toEqual(specification);
    const second = client([`Here is your spec: ${JSON.stringify(specification)}`]);
    await expect(second.agents.specify(goal)).rejects.toMatchObject({ code: 'INVALID_AGENT_JSON' });
    const third = client();
    third.fetchMock.mockResolvedValueOnce(completion(specification, 'length'));
    await expect(third.agents.specify(goal)).rejects.toMatchObject({ code: 'INCOMPLETE_COMPLETION' });
    const emptyTruncated = client();
    emptyTruncated.fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: null }, finish_reason: 'length' }] }));
    await expect(emptyTruncated.agents.specify(goal)).rejects.toMatchObject({ code: 'INCOMPLETE_COMPLETION' });
  });

  it('rejects unsupported components, changed goals, and unnumbered requirements', async () => {
    for (const output of [
      { ...specification, components: [{ id: 'servo', kind: 'servo', label: 'Servo', meaning: 'Opens a door' }] },
      { ...specification, goal: 'Silently substituted goal' },
      { ...specification, requirements: [{ id: 'safety', text: 'Something safe' }] },
    ]) {
      const { agents } = client([output]);
      await expect(agents.specify(goal)).rejects.toMatchObject({ code: 'INVALID_SPEC' });
    }
    const unsupported = client([{ error: 'UNSUPPORTED_GOAL' }]);
    await expect(unsupported.agents.specify(goal)).rejects.toMatchObject({ code: 'UNSUPPORTED_GOAL' });
  });

  it('rejects empty suites, executable test fields, unknown signals, and no-output checks', async () => {
    const offOnly = scenarios.map((scenario) => ({ ...scenario, assertions: [{ ...scenario.assertions[0], requirementIds: ['R1', 'R2', 'R3'] }] }));
    const unknownSignal = scenarios.map((scenario) => ({ ...scenario, assertions: scenario.assertions.map((assertion) => ({ ...assertion, signal: 'unknown' })) }));
    for (const output of [{ scenarios: [] }, { scenarios, javascript: 'process.exit(0)' }, { scenarios: unknownSignal }, { scenarios: offOnly }]) {
      const { agents, fetchMock } = client([output, output, output]);
      await expect(agents.verify(goal, specification)).rejects.toMatchObject({ code: 'INVALID_SUITE' });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    }
  });

  it('sends an independent pre-freeze correction only the invalid suite and validation diagnostic', async () => {
    const invalid = { scenarios: [] };
    const { agents, fetchMock } = client([invalid, { scenarios }, { scenarios }]);
    await expect(agents.verify(goal, specification)).resolves.toEqual(scenarios);
    const payload = JSON.parse(sentBody(fetchMock, 2).messages[1].content);
    expect(Object.keys(payload).sort()).toEqual(['correction', 'goal', 'specification']);
    expect(payload.correction.invalidVerifierOutput).toEqual(invalid);
    expect(payload.correction.validationDiagnostic).toContain('Scenario suite');
    expect(payload.correction.correctionInstruction).toContain('never shorten');
    expect(payload.specification).toEqual(specification);
  });

  it('corrects invalid JSON or impossible duration windows before freezing', async () => {
    const impossible = structuredClone(scenarios);
    impossible[0].assertions[2].toMs = 300;
    for (const firstOutput of ['not JSON', { scenarios: impossible }]) {
      const { agents, fetchMock } = client([firstOutput, { scenarios }, { scenarios }]);
      await expect(agents.verify(goal, specification)).resolves.toEqual(scenarios);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    }
  });

  it('uses the reviewed held-across-reset timeline without changing the draft or specification', async () => {
    const resetSpec: RunSpec = {
      goal: 'A button held across reset cannot trigger again until released and pressed.',
      assumptions: [],
      components: [...specification.components, { id: 'reset', kind: 'button', label: 'Reset', meaning: 'Clears the winner' }],
      requirements: [specification.requirements[0], specification.requirements[1], { id: 'R3', text: 'Reset clears the LED; a held request cannot win again until released and pressed.' }],
    };
    const draft: Scenario[] = [{
      id: 'held-across-reset', name: 'Held across reset', durationMs: 2000,
      inputs: [
        { atMs: 200, componentId: 'request', pressed: true }, { atMs: 300, componentId: 'request', pressed: false },
        { atMs: 800, componentId: 'reset', pressed: true }, { atMs: 900, componentId: 'reset', pressed: false },
        { atMs: 1000, componentId: 'request', pressed: true }, { atMs: 1100, componentId: 'request', pressed: false },
      ],
      assertions: [
        scenarios[0].assertions[0], scenarios[0].assertions[1],
        { id: 'no-retrigger', requirementIds: ['R3'], type: 'level', signal: 'status', value: 0, driven: true, fromMs: 920, toMs: 1500 },
      ],
    }];
    const reviewed = structuredClone(draft);
    reviewed[0].inputs = [
      { atMs: 200, componentId: 'request', pressed: true },
      { atMs: 800, componentId: 'reset', pressed: true }, { atMs: 900, componentId: 'reset', pressed: false },
      { atMs: 1600, componentId: 'request', pressed: false }, { atMs: 1800, componentId: 'request', pressed: true },
    ];
    reviewed[0].assertions.push({ id: 'fresh-press-wins', requirementIds: ['R2'], type: 'transition', signal: 'status', edge: 'rising', minCount: 1, maxCount: 1, fromMs: 1820, toMs: 1920 });
    const original = JSON.stringify({ resetSpec, draft });
    const { agents, fetchMock } = client([{ scenarios: draft }, { scenarios: reviewed }]);
    await expect(agents.verify(resetSpec.goal, resetSpec)).resolves.toEqual(reviewed);
    const reviewPayload = JSON.parse(sentBody(fetchMock, 2).messages[1].content);
    expect(reviewPayload).toMatchObject({ goal: resetSpec.goal, specification: resetSpec, draftScenarios: draft });
    expect(reviewPayload.inputTimeline[0].buttons[0].pressedIntervals).toMatchObject([
      { pressedAtMs: 200, releasedAtMs: 300 }, { pressedAtMs: 1000, releasedAtMs: 1100 },
    ]);
    expect(JSON.stringify({ resetSpec, draft })).toBe(original);
  });

  it('shares two correction allowances across draft and semantic review with at most four completions', async () => {
    const invalid = { scenarios: [] };
    const first = client([invalid, { scenarios }, invalid, { scenarios }]);
    await expect(first.agents.verify(goal, specification)).resolves.toEqual(scenarios);
    expect(first.fetchMock).toHaveBeenCalledTimes(5);
    const second = client([{ scenarios }, invalid, invalid, { scenarios }]);
    await expect(second.agents.verify(goal, specification)).resolves.toEqual(scenarios);
    expect(second.fetchMock).toHaveBeenCalledTimes(5);
    expect(JSON.parse(sentBody(second.fetchMock, 4).messages[1].content).draftScenarios).toEqual(scenarios);
    const exhausted = client([invalid, invalid, { scenarios }, invalid, { scenarios }]);
    await expect(exhausted.agents.verify(goal, specification)).rejects.toMatchObject({ code: 'INVALID_SUITE' });
    expect(exhausted.fetchMock).toHaveBeenCalledTimes(5);
  });

  it('rejects directly contradictory signal windows before semantic review', async () => {
    const contradictory = structuredClone(scenarios);
    contradictory[0].assertions.push({ id: 'forbidden-request', requirementIds: ['R2'], type: 'level', signal: 'status', value: 0, driven: true, fromMs: 200, toMs: 400 });
    const { agents, fetchMock } = client([{ scenarios: contradictory }, { scenarios: contradictory }, { scenarios: contradictory }]);
    await expect(agents.verify(goal, specification)).rejects.toMatchObject({ code: 'INVALID_SUITE' });
    expect(JSON.parse(sentBody(fetchMock, 2).messages[1].content).correction.validationDiagnostic).toContain('forbids every edge');
  });

  it('reports the precise validation reason while redacting the server key', async () => {
    const invalid = structuredClone(scenarios);
    invalid[0].assertions[0] = { ...invalid[0].assertions[0], type: 'level', signal: 'server-test-secret', value: 0 };
    const { agents } = client([{ scenarios: invalid }, { scenarios: invalid }, { scenarios: invalid }]);
    const error = await agents.verify(goal, specification).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AgentError);
    expect(String(error)).toContain('draft failed pre-freeze validation');
    expect(String(error)).toContain('Invalid output signal: [redacted]');
    expect(String(error)).not.toContain('server-test-secret');
  });

  it('anchors reset response arithmetic to the reset press instead of neighboring inputs', async () => {
    const resetSpec = structuredClone(specification);
    resetSpec.components.push({ id: 'reset', kind: 'button', label: 'Reset', meaning: 'Resets the output' });
    resetSpec.requirements.push({ id: 'R4', text: 'After reset button is stable pressed for 20 ms, turn the LED off within 100 ms.' });
    const draft = structuredClone(scenarios);
    draft[0].durationMs = 1500;
    draft[0].inputs.push({ atMs: 1100, componentId: 'reset', pressed: true }, { atMs: 1300, componentId: 'reset', pressed: false });
    draft[0].assertions.push({ id: 'reset-off', requirementIds: ['R4'], type: 'level', signal: 'status', value: 0, driven: true, fromMs: 1220, toMs: 1400 });
    const { agents, fetchMock } = client([{ scenarios: draft }, { scenarios: draft }]);
    await agents.verify(goal, resetSpec);
    const payload = JSON.parse(sentBody(fetchMock, 2).messages[1].content);
    const reset = payload.inputTimeline[0].buttons.find((button: { componentId: string }) => button.componentId === 'reset');
    expect(reset.pressedIntervals[0].responseWindows).toContainEqual({ requirementId: 'R4', becomesStable: true, stableAtMs: 1120, deadlineAtMs: 1220 });
  });

  it('executes two constrained recipe selections with exact door swaps and an immutable published baseline', async () => {
    const baseline = structuredClone(airlockScenarios);
    const freezeDeep = (value: unknown): void => {
      if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freezeDeep); }
    };
    freezeDeep(baseline);
    const original = JSON.stringify(baseline);
    const recipes = { extensions: [{ baselineScenarioId: 'held', transform: 'swap-doors' }, { baselineScenarioId: 'closed-interval', transform: 'swap-doors' }] };
    const { agents, fetchMock } = client([recipes]);
    const extras = await agents.verify(airlockSpec.goal, airlockSpec, undefined, baseline);
    expect(extras.map((scenario) => scenario.id)).toEqual(['extra-held-swapped', 'extra-closed-interval-swapped']);
    const swap: Record<string, string> = { outerRequest: 'innerRequest', innerRequest: 'outerRequest', outerDoor: 'innerDoor', innerDoor: 'outerDoor' };
    for (let index = 0; index < extras.length; index++) {
      const source = baseline.find((scenario) => scenario.id === recipes.extensions[index].baselineScenarioId)!;
      const extra = extras[index];
      expect(extra.durationMs).toBe(source.durationMs);
      expect(extra.inputs).toEqual(source.inputs.map((input) => ({ ...input, componentId: swap[input.componentId] })));
      expect(extra.assertions).toHaveLength(source.assertions.length);
      extra.assertions.forEach((assertion, checkIndex) => {
        const sourceCheck = source.assertions[checkIndex];
        expect(assertion).toEqual({
          ...sourceCheck, id: `extra-${source.id}-${checkIndex + 1}`,
          ...('signal' in sourceCheck ? { signal: swap[sourceCheck.signal] } : { signals: sourceCheck.signals.map((signal) => swap[signal]) }),
        });
      });
    }
    expect(JSON.stringify(baseline)).toBe(original);
    const draftPayload = JSON.parse(sentBody(fetchMock).messages[1].content);
    expect(draftPayload).toMatchObject({ goal: airlockSpec.goal, specification: airlockSpec, baselineScenarios: baseline });
    expect(Object.keys(draftPayload).sort()).toEqual(['allowedExtensions', 'baselineScenarios', 'goal', 'specification']);
    expect(draftPayload.allowedExtensions.map((entry: { baselineScenarioId: string }) => entry.baselineScenarioId).sort()).toEqual(['alternating', 'bounce', 'busy', 'closed-interval', 'held', 'reset']);
    expect(sentBody(fetchMock).messages[0].content).toContain('EXACTLY TWO');
    expect(sentBody(fetchMock).messages[0].content).toContain('CONSTRAINED CHALLENGE EXTENSIONS');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still requires full coverage and useful outputs when no baseline is supplied', async () => {
    const partial = [{ ...scenarios[0], id: 'extra-partial', assertions: [scenarios[0].assertions[0]] }];
    const { agents } = client([{ scenarios: partial }, { scenarios: partial }, { scenarios: partial }]);
    await expect(agents.verify(goal, specification)).rejects.toMatchObject({ code: 'INVALID_SUITE' });
  });

  it('rejects duplicate or unsupported recipes and any model-authored timing or scenario fields', async () => {
    const held = { baselineScenarioId: 'held', transform: 'swap-doors' };
    const bounce = { baselineScenarioId: 'bounce', transform: 'swap-doors' };
    for (const output of [
      { extensions: [] }, { extensions: [held] }, { extensions: [held, bounce, { ...held, baselineScenarioId: 'busy' }] },
      { extensions: [held, held] }, { extensions: [held, { baselineScenarioId: 'startup', transform: 'swap-doors' }] },
      { extensions: [held, { baselineScenarioId: 'bounce', transform: 'change-times' }] },
      { extensions: [held, { ...bounce, durationMs: 1 }] },
      { extensions: [held, bounce], baselineScenarios: [] }, { scenarios: airlockScenarios.slice(0, 2) },
    ]) {
      const { agents, fetchMock } = client([output, output, output]);
      await expect(agents.verify(airlockSpec.goal, airlockSpec, undefined, airlockScenarios)).rejects.toMatchObject({ code: 'INVALID_SUITE' });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    }
  });

  it('corrects recipe schema errors without asking the model to rewrite executable tests', async () => {
    const duplicate = { extensions: [{ baselineScenarioId: 'held', transform: 'swap-doors' }, { baselineScenarioId: 'held', transform: 'swap-doors' }] };
    const corrected = { extensions: [{ baselineScenarioId: 'reset', transform: 'swap-doors' }, { baselineScenarioId: 'bounce', transform: 'swap-doors' }] };
    const { agents, fetchMock } = client([duplicate, corrected]);
    const extras = await agents.verify(airlockSpec.goal, airlockSpec, undefined, airlockScenarios);
    expect(extras.map((scenario) => scenario.id)).toEqual(['extra-reset-swapped', 'extra-bounce-swapped']);
    expect(extras[0].inputs).toEqual(airlockScenarios.find((scenario) => scenario.id === 'reset')!.inputs.map((input) => ({ ...input, componentId: 'outerRequest' })));
    const correction = JSON.parse(sentBody(fetchMock, 2).messages[1].content).correction;
    expect(correction.validationDiagnostic).toContain('distinct');
    expect(correction.correctionInstruction).toContain('Do not author scenarios');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects a non-airlock baseline before any inference request', async () => {
    const { agents, fetchMock } = client();
    await expect(agents.verify(goal, specification, undefined, scenarios)).rejects.toMatchObject({ code: 'INVALID_BASELINE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds repair traces while retaining actual first failures, counts and the complete frozen suite', async () => {
    const failures = { error: 'Repeated candidate', previousFailures: [{
      scenario: scenarios[0].id, completed: true,
      failedChecks: Array.from({ length: 40 }, (_, index) => ({ check: index ? `failed-${index}` : 'pulse-duration', requirements: ['R3'], message: `Observed duration failure ${index}` })),
      trace: Array.from({ length: 200 }, (_, index) => ({ atMs: index * 5, cycle: index * 80_000, signal: 'status', value: index % 2, mode: 'output' })),
      omittedTracePoints: 123,
    }] };
    const original = JSON.stringify(failures);
    const { agents, fetchMock } = client([candidateOutput]);
    await agents.build(specification, scenarios, { attempt: 3, previous: candidate, failures });
    const payload = JSON.parse(sentBody(fetchMock).messages[1].content);
    expect(payload.scenarios).toEqual(scenarios);
    expect(payload).not.toHaveProperty('failures');
    expect(payload.previousCandidate).not.toHaveProperty('rationale');
    expect(payload.failureSummary.controllerErrors).toEqual(['Repeated candidate']);
    expect(payload.failureSummary.failedCheckCount).toBe(40);
    expect(payload.failureSummary.failedChecks).toHaveLength(24);
    expect(payload.failureSummary.omittedCheckCount).toBe(16);
    expect(payload.failureSummary.firstFailure).toMatchObject({ scenarioId: scenarios[0].id, checkId: 'pulse-duration', message: 'Observed duration failure 0' });
    expect(payload.failureSummary.representativeScenarios[0]).toMatchObject({ inputs: scenarios[0].inputs, expectedCheck: scenarios[0].assertions[2], traceProvided: true, omittedTracePoints: 299 });
    expect(payload.failureSummary.representativeScenarios[0].observedOutputTransitions).toHaveLength(24);
    expect(JSON.stringify(failures)).toBe(original);
  });

  it('uses a compact replan payload and ends with the exact plan-only response instruction', async () => {
    const { agents, fetchMock } = client([{ plan: 'Capture the stable press edge before consuming the eligibility latch; let IDLE consume that event exactly once.' }], ['max_completion_tokens']);
    await agents.replan(specification, scenarios, candidate, [{ scenario: scenarios[0].id, failedChecks: [{ check: 'request-on', message: 'Observed zero rising transitions.' }], trace: [] }]);
    const request = sentBody(fetchMock);
    expect(request.max_completion_tokens).toBe(6000);
    const payload = JSON.parse(request.messages[1].content);
    expect(payload).not.toHaveProperty('scenarios');
    expect(payload.acceptanceOverview).toEqual(scenarios.map((scenario) => ({ id: scenario.id, name: scenario.name, durationMs: scenario.durationMs, inputs: scenario.inputs, checkCount: scenario.assertions.length })));
    expect(payload.failureSummary.firstFailure.message).toBe('Observed zero rising transitions.');
    expect(request.messages[2].content).toContain('Return exactly {"plan":"your concise implementation plan"}');
    expect(request.messages[2].content).toContain('not firmware');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not add replan calls when the model returns the wrong response shape', async () => {
    for (const output of [candidateOutput, { plan: ['not a string'] }, { plan: '', source: 'extra field' }]) {
      const { agents, fetchMock } = client([output]);
      await expect(agents.replan(specification, scenarios, candidate, [])).rejects.toMatchObject({ code: 'INVALID_REPLAN' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it('uses thinking for repairs and replans while keeping fresh builds and Verifiers bounded', async () => {
    const supported = ['chat_template_kwargs', 'reasoning_effort', 'max_completion_tokens'];
    const recipes = { extensions: [{ baselineScenarioId: 'held', transform: 'swap-doors' }, { baselineScenarioId: 'bounce', transform: 'swap-doors' }] };
    const { agents, fetchMock } = client([specification, { scenarios }, { scenarios }, candidateOutput, candidateOutput, { plan: 'Capture a press event before consuming eligibility.' }, recipes], supported, { maxProviderTokens: 32_000 });
    await agents.specify(goal);
    await agents.verify(goal, specification);
    await agents.build(specification, scenarios, { attempt: 1 });
    await agents.build(specification, scenarios, { attempt: 2, previous: candidate });
    await agents.replan(specification, scenarios, candidate, []);
    await agents.verify(airlockSpec.goal, airlockSpec, undefined, airlockScenarios);
    for (const index of [1, 2, 3, 4, 7]) {
      expect(sentBody(fetchMock, index).chat_template_kwargs).toEqual({ thinking: false });
      expect(sentBody(fetchMock, index).max_completion_tokens).toBe(12_000);
    }
    expect(sentBody(fetchMock, 5).chat_template_kwargs).toEqual({ thinking: true, reasoning_effort: 'low' });
    expect(sentBody(fetchMock, 5).max_completion_tokens).toBe(24_000);
    expect(sentBody(fetchMock, 6).chat_template_kwargs).toEqual({ thinking: true, reasoning_effort: 'low' });
    expect(sentBody(fetchMock, 6).max_completion_tokens).toBe(6000);
    expect(JSON.parse(sentBody(fetchMock, 4).messages[1].content)).not.toHaveProperty('previousCandidate');
    expect(JSON.parse(sentBody(fetchMock, 5).messages[1].content)).toHaveProperty('previousCandidate.source', candidate.source);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('preserves non-thinking mode and the 12000-token budget during normal Verifier corrections', async () => {
    const { agents, fetchMock } = client([{ scenarios: [] }, { scenarios }, { scenarios }], ['chat_template_kwargs', 'max_completion_tokens'], { maxProviderTokens: 32_000 });
    await agents.verify(goal, specification);
    for (const index of [1, 2, 3]) {
      expect(sentBody(fetchMock, index).chat_template_kwargs).toEqual({ thinking: false });
      expect(sentBody(fetchMock, index).max_completion_tokens).toBe(12_000);
    }
  });

  it('rejects unsupported pins, duplicate pins, and a model-supplied VERIFIED status', async () => {
    for (const output of [
      { ...candidateOutput, pins: [{ componentId: 'request', pin: 1 }, { componentId: 'status', pin: 3 }] },
      { ...candidateOutput, pins: [{ componentId: 'request', pin: 2 }, { componentId: 'status', pin: 2 }] },
      { ...candidateOutput, status: 'VERIFIED' },
    ]) {
      const { agents } = client([output]);
      await expect(agents.build(specification, scenarios, { attempt: 1 })).rejects.toMatchObject({ code: 'INVALID_CANDIDATE' });
    }
  });

  it('limits attempts and produces a plan without altering the frozen contract', async () => {
    const { agents, fetchMock } = client([{ plan: 'Use debounced press edges and an independent unsigned pulse timer.' }]);
    await expect(agents.build(specification, scenarios, { attempt: 5 })).rejects.toMatchObject({ code: 'INVALID_ATTEMPT' });
    expect(fetchMock).not.toHaveBeenCalled();
    const before = JSON.stringify({ specification, scenarios });
    await expect(agents.replan(specification, scenarios, candidate, [{ id: 'pulse-duration' }])).resolves.toContain('independent unsigned pulse timer');
    expect(JSON.stringify({ specification, scenarios })).toBe(before);
    expect(sentBody(fetchMock).messages[0].content).toContain('cannot be changed, removed or weakened');
  });
});
