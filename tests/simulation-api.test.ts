import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { inflateRawSync } from 'node:zlib';
import { simulationRoutes } from '../server/simulation-routes';
import type { SimulationController } from '../server/simulation-controller';
import type { SimulationRun, SimulationRunEvent, SimulationRunStatus } from '../shared/simulation-run';
import { SIMULATION_RUNTIME_VERSION } from '../shared/simulation-runtime';

const now = '2026-10-17T12:00:00.000Z';
const event = (sequence: number): SimulationRunEvent => ({ sequence, at: now, phase: sequence < 3 ? 'BUILDING' : 'READY', message: `Simulation event ${sequence}` });
const fixture: SimulationRun = {
  id: 'reservoir-test', prompt: 'Simulate an adjustable reservoir', goal: 'Simulate an adjustable reservoir',
  model: 'test-model', status: 'READY', createdAt: now, updatedAt: now, deadlineAt: now,
  messages: [{ role: 'user', content: 'Simulate an adjustable reservoir' }],
  events: [1, 2, 3].map(event), attempts: [],
  spec: {
    goal: 'Simulate an adjustable reservoir', title: 'Reservoir laboratory', summary: 'Change inflow and observe the water volume.',
    assumptions: ['Uniform reservoir cross section.'],
    controls: [{ id: 'inflow', label: 'Inflow', type: 'range', min: 0, max: 10, initial: 0 }],
    observables: [{ id: 'volume', label: 'Volume', type: 'number', unit: 'L' }],
    requirements: [{ id: 'R1', text: 'Integrate inflow over elapsed seconds.' }],
  },
  candidate: {
    id: 'candidate-1', rationale: 'Integrate flow with elapsed simulation time.',
    source: 'function createSimulation(){let volume=0,flow=0;return {reset(){volume=0;flow=0;},input(id,value){flow=value;},step(dt){volume+=flow*dt;},snapshot(){return {volume};},draw(ctx,w,h){ctx.clearRect(0,0,w,h);}};}',
  },
  scenarios: [{ id: 'fills', name: 'Adjust inflow', steps: [
    { type: 'input', controlId: 'inflow', value: 2 }, { type: 'advance', durationMs: 1000 },
    { type: 'assert', id: 'water', requirementIds: ['R1'], observable: 'volume', operator: 'approx', value: 2, tolerance: 0.001 },
  ] }],
  evidence: {
    passed: true, sourceHash: 'checked-source', specHash: 'checked-spec', suiteHash: 'checked-suite', runtimeVersion: SIMULATION_RUNTIME_VERSION, checkedAt: now,
    results: [{ scenarioId: 'fills', name: 'Adjust inflow', completed: true, checks: [{ id: 'water', requirementIds: ['R1'], passed: true, actual: 2, message: 'Observed two liters.' }] }],
  },
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function serve(patch: Partial<SimulationRun> = {}) {
  const run = { ...structuredClone(fixture), ...patch };
  const events = new EventEmitter();
  const controller = {
    events,
    get: vi.fn<SimulationController['get']>(async id => id === run.id ? structuredClone(run) : undefined),
    start: vi.fn<SimulationController['start']>(async () => structuredClone(run)),
    cancel: vi.fn<SimulationController['cancel']>(async id => id === run.id ? { ...structuredClone(run), status: 'CANCELLED' } : undefined),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/simulations', simulationRoutes(controller as unknown as SimulationController));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/simulations`;
  return { base, controller, run, events };
}

const post = (url: string, body: unknown) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function readThrough(reader: ReadableStreamDefaultReader<Uint8Array>, finalSequence: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const decoder = new TextDecoder();
        let text = '';
        while (!text.includes(`id: ${finalSequence}\n`) || !text.endsWith('\n\n')) {
          const next = await reader.read();
          if (next.done) throw new Error('Event stream ended before the expected event');
          text += decoder.decode(next.value, { stream: true });
        }
        return text;
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Timed out waiting for simulation events')), 3000); }),
    ]);
  } finally { clearTimeout(timeout); }
}

/** Read the ZIP central directory so compressed entries with data descriptors work. */
function unzip(bytes: Buffer): Map<string, string> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('Missing ZIP central directory');
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory entry');
    const method = bytes.readUInt16LE(cursor + 10);
    const size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression');
    entries.set(name, (method === 8 ? inflateRawSync(compressed) : compressed).toString());
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('generated simulation HTTP API', () => {
  it.each([
    {}, { prompt: 'tiny' }, { prompt: '     ' }, { prompt: 'a'.repeat(5001) }, { prompt: 12 },
    { prompt: 'A valid request', source: 'untrusted source' },
    { prompt: 'A valid request', previousId: '../outside' },
    { prompt: 'A valid request', previousId: '' },
    { prompt: 'A valid request', previousId: 'a'.repeat(81) },
  ])('rejects invalid or unknown payload fields: %j', async payload => {
    const { base, controller } = await serve();
    const response = await post(base, payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('5–5000') });
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('accepts trimmed prompts and passes the previous simulation ID for refinements', async () => {
    const { base, controller, run } = await serve();
    const response = await post(base, { prompt: '  Add a drain valve  ', previousId: run.id });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(run);
    expect(controller.start).toHaveBeenCalledWith({ prompt: 'Add a drain valve', previousId: run.id });
  });

  it('returns concrete controller start failures without accepting a run', async () => {
    const { base, controller } = await serve();
    controller.start.mockRejectedValue(new Error('A simulation is being built.'));
    const response = await post(base, { prompt: fixture.prompt });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'A simulation is being built.' });
  });

  it('retrieves and cancels an existing simulation', async () => {
    const { base, controller, run } = await serve();
    const read = await fetch(`${base}/${run.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(run);
    const cancelled = await fetch(`${base}/${run.id}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ id: run.id, status: 'CANCELLED' });
    expect(controller.cancel).toHaveBeenCalledWith(run.id);
  });

  it.each([
    ['', 'GET'], ['/cancel', 'POST'], ['/events', 'GET'], ['/artifacts', 'GET'],
  ])('returns 404 for a missing simulation at %s', async (suffix, method) => {
    const { base, events } = await serve();
    const response = await fetch(`${base}/missing${suffix}`, { method });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Simulation not found.' });
    expect(events.listenerCount('missing')).toBe(0);
  });
});

describe('generated simulation event stream', () => {
  it('replays after Last-Event-ID, streams changes once, and removes listeners on disconnect', async () => {
    const { base, events, run } = await serve();
    const abort = new AbortController();
    const response = await fetch(`${base}/${run.id}/events?after=0`, { headers: { 'Last-Event-ID': '1' }, signal: abort.signal });
    const reader = response.body!.getReader();
    try {
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/event-stream');
      const replay = await readThrough(reader, 3);
      expect(replay.match(/^id: \d+$/gm)).toEqual(['id: 2', 'id: 3']);
      expect(replay).toContain('event: simulation-event');
      expect(replay).toContain(JSON.stringify(event(3)));
      events.emit(run.id, event(3));
      events.emit(run.id, event(4));
      events.emit(run.id, event(5));
      const updates = await readThrough(reader, 5);
      expect(updates.match(/^id: \d+$/gm)).toEqual(['id: 4', 'id: 5']);
      expect(events.listenerCount(run.id)).toBe(1);
    } finally { await reader.cancel(); abort.abort(); }
    await vi.waitFor(() => expect(events.listenerCount(run.id)).toBe(0), { timeout: 1000, interval: 10 });
  });

  it.each([['?after=2', undefined, ['id: 3']], ['?after=1', '2', ['id: 3']], ['?after=bad', undefined, ['id: 1', 'id: 2', 'id: 3']]] as const)(
    'uses reconnect cursor %s with header %s', async (query, header, expected) => {
      const { base, run } = await serve();
      const abort = new AbortController();
      const response = await fetch(`${base}/${run.id}/events${query}`, { headers: header ? { 'Last-Event-ID': header } : {}, signal: abort.signal });
      const reader = response.body!.getReader();
      try { expect((await readThrough(reader, 3)).match(/^id: \d+$/gm)).toEqual(expected); }
      finally { await reader.cancel(); abort.abort(); }
    },
  );

  it('buffers events emitted during replay and deduplicates overlapping snapshots', async () => {
    const { base, controller, events, run } = await serve();
    let release!: (run: SimulationRun) => void;
    let entered!: () => void;
    const secondRead = new Promise<void>(resolve => { entered = resolve; });
    controller.get.mockResolvedValueOnce({ ...run, events: run.events.slice(0, 2) }).mockImplementationOnce(async () => {
      entered();
      return new Promise<SimulationRun>(resolve => { release = resolve; });
    });
    const abort = new AbortController();
    const response = await fetch(`${base}/${run.id}/events`, { signal: abort.signal });
    const reader = response.body!.getReader();
    try {
      await secondRead;
      events.emit(run.id, event(4));
      events.emit(run.id, event(3));
      release(run);
      const replay = await readThrough(reader, 4);
      expect(replay.match(/^id: \d+$/gm)).toEqual(['id: 1', 'id: 2', 'id: 3', 'id: 4']);
    } finally { await reader.cancel(); abort.abort(); }
    await vi.waitFor(() => expect(events.listenerCount(run.id)).toBe(0), { timeout: 1000, interval: 10 });
  });
});

describe('generated simulation artifact export', () => {
  it('exports a standalone HTML simulation, exact source, frozen spec, scenarios, and verification report', async () => {
    const { base, run } = await serve();
    const response = await fetch(`${base}/${run.id}/artifacts`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain(`simulation-${run.id}.zip`);
    expect(response.headers.get('Content-Type')).toContain('application/zip');
    const entries = unzip(Buffer.from(await response.arrayBuffer()));
    expect([...entries.keys()].sort()).toEqual(['scenarios.json', 'simulation.html', 'simulation.js', 'specification.json', 'verification-report.json']);
    expect(entries.get('simulation.js')).toBe(run.candidate!.source);
    expect(JSON.parse(entries.get('specification.json')!)).toEqual(run.spec);
    expect(JSON.parse(entries.get('scenarios.json')!)).toEqual(run.scenarios);
    const html = entries.get('simulation.html')!;
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Reservoir laboratory');
    expect(html).toContain('createSimulation');
    expect(html).toContain('simulation-toolbar');
    expect(html).toContain("connect-src 'none'");
    expect(html).toMatch(/,\s*true\);\s*<\/script>/);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(JSON.parse(entries.get('verification-report.json')!)).toMatchObject({ status: 'READY', prompt: run.prompt, model: run.model, evidence: run.evidence, attempts: [], events: run.events });
  });

  it.each(['QUEUED', 'PLANNING', 'DESIGNING_TESTS', 'BUILDING', 'CHECKING'] as SimulationRunStatus[])('refuses incomplete artifacts while %s', async status => {
    const { base, run } = await serve({ status });
    const response = await fetch(`${base}/${run.id}/artifacts`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Wait for the build to finish before downloading.' });
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });

  it.each(['FAILED', 'CANCELLED', 'STALE'] as SimulationRunStatus[])('exports the report for terminal %s runs even without generated artifacts', async status => {
    const { base, run } = await serve({ status, spec: undefined, candidate: undefined, scenarios: undefined, evidence: undefined, error: 'The build did not complete.' });
    const response = await fetch(`${base}/${run.id}/artifacts`);
    expect(response.status).toBe(200);
    const entries = unzip(Buffer.from(await response.arrayBuffer()));
    expect([...entries.keys()]).toEqual(['verification-report.json']);
    const report = JSON.parse(entries.get('verification-report.json')!);
    expect(report).toMatchObject({ status, error: run.error, attempts: [] });
    expect(report.evidence).toBeUndefined();
  });
});
