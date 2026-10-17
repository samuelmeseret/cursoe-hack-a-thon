import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { createApp } from '../server/index';
import type { RunController } from '../server/controller';
import type { RunEvent, RunState } from '../shared/types';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
const run: RunState = { id: 'test-run', goal: 'A test goal', mode: 'generate', inference: 'fixture', status: 'FAILED', createdAt: new Date().toISOString(), deadlineAt: new Date().toISOString(), attempts: [], replanCount: 0, events: [1, 2, 3].map(sequence => ({ sequence, at: new Date().toISOString(), agent: 'controller', kind: sequence === 3 ? 'terminal' : 'activity', message: `event ${sequence}` })) };
async function serve() {
  const events = new EventEmitter();
  const controller = { events, get: async (id: string) => id === run.id ? structuredClone(run) : undefined, cancel: async (id: string) => id === run.id ? { ...run, status: 'CANCELLED' } : undefined, start: async () => structuredClone(run) } as unknown as RunController;
  const { app } = createApp(controller);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.on('listening', resolve));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, events };
}
describe('local API contract', () => {
  it('validates start payloads and rejects external browser origins', async () => {
    const { base } = await serve();
    const bad = await fetch(base + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: 'short', mode: 'invalid', evidence: { passed: true } }) });
    expect(bad.status).toBe(400);
    const external = await fetch(base + '/api/runs/test-run', { headers: { Origin: 'https://unrelated.example' } });
    expect(external.status).toBe(403);
    const accepted = await fetch(base + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }, body: JSON.stringify({ goal: 'A useful goal', mode: 'generate' }) });
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).id).toBe(run.id);
  });
  it('retrieves, cancels, and rejects unknown runs', async () => {
    const { base } = await serve();
    expect((await (await fetch(base + '/api/runs/test-run')).json()).status).toBe('FAILED');
    expect((await (await fetch(base + '/api/runs/test-run/cancel', { method: 'POST' })).json()).status).toBe('CANCELLED');
    expect((await fetch(base + '/api/runs/missing')).status).toBe(404);
  });
  it('SSE replays only events after Last-Event-ID and streams ordered changes', async () => {
    const { base, events } = await serve();
    const abort = new AbortController();
    const response = await fetch(base + '/api/runs/test-run/events', { headers: { 'Last-Event-ID': '1' }, signal: abort.signal });
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    const reader = response.body!.getReader(); const decoder = new TextDecoder();
    let data = decoder.decode((await reader.read()).value);
    expect(data).toContain('id: 2'); expect(data).toContain('id: 3'); expect(data).not.toContain('id: 1');
    const next: RunEvent = { sequence: 4, at: new Date().toISOString(), agent: 'controller', kind: 'terminal', message: 'next' };
    events.emit(run.id, next); data = decoder.decode((await reader.read()).value); expect(data).toContain('id: 4');
    await reader.cancel(); abort.abort();
  });
  it('exports a ZIP artifact snapshot with the report', async () => {
    const { base } = await serve(); const response = await fetch(base + '/api/runs/test-run/artifacts');
    expect(response.status).toBe(200); expect(response.headers.get('content-disposition')).toContain('.zip');
    const bytes = new Uint8Array(await response.arrayBuffer()); expect([...bytes.slice(0, 2)]).toEqual([80, 75]);
    expect(Buffer.from(bytes).includes(Buffer.from('verification-report.json'))).toBe(true);
  });
});
