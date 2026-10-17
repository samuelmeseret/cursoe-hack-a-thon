import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { SIMULATION_RUNTIME_VERSION } from '../shared/simulation-runtime';
import type { SimulationRun } from '../shared/simulation-run';

type HarnessWindow = Window & { emitSimulationEvent(id: string): void; simulationEventSourceCount(): number };
const baseline: SimulationRun = {
  id: 'baseline-reservoir', prompt: 'Simulate reservoir inflow', goal: 'Simulate reservoir inflow', model: 'test-model',
  status: 'READY', createdAt: '2026-10-17T12:00:00Z', updatedAt: '2026-10-17T12:00:00Z', deadlineAt: '2026-10-17T12:06:00Z',
  messages: [{ role: 'user', content: 'Simulate reservoir inflow' }, { role: 'assistant', content: 'A reservoir with adjustable inflow.' }],
  events: [1, 2, 3].map(sequence => ({ sequence, at: '', phase: sequence === 3 ? 'READY' : 'BUILDING', message: `Baseline event ${sequence}` })),
  attempts: [],
  spec: {
    goal: 'Simulate reservoir inflow', title: 'Reservoir laboratory', summary: 'A reservoir with adjustable inflow.',
    assumptions: ['Inflow is measured in liters per second.'],
    controls: [{ id: 'inflow', label: 'Inflow', type: 'range', min: 0, max: 10, initial: 0 }],
    observables: [{ id: 'volume', label: 'Water volume', type: 'number', unit: 'L' }],
    requirements: [{ id: 'R1', text: 'Integrate inflow over simulation time.' }],
  },
  candidate: {
    id: 'candidate-1', rationale: 'Integrate flow.',
    source: 'function createSimulation(){let volume=0,flow=0;return {reset(){volume=0;flow=0;},input(id,value){flow=value;},step(dt){volume+=flow*dt;},snapshot(){return {volume};},draw(ctx,w,h){ctx.fillStyle="#eaf5ff";ctx.fillRect(0,0,w,h);}};}',
  },
  scenarios: [{ id: 'fills', name: 'Reservoir fills', steps: [{ type: 'input', controlId: 'inflow', value: 2 }, { type: 'advance', durationMs: 1000 }, { type: 'assert', id: 'volume', requirementIds: ['R1'], observable: 'volume', operator: 'eq', value: 2 }] }],
  evidence: {
    passed: true, sourceHash: 'source', specHash: 'spec', suiteHash: 'suite', runtimeVersion: SIMULATION_RUNTIME_VERSION, checkedAt: '',
    results: [{ scenarioId: 'fills', name: 'Reservoir fills', completed: true, checks: [{ id: 'volume', requirementIds: ['R1'], passed: true, actual: 2, message: 'Observed baseline volume: 2 L.' }] }],
  },
};

function updateRun(status: 'BUILDING' | 'FAILED'): SimulationRun {
  const run: SimulationRun = {
    ...structuredClone(baseline), id: 'drain-update', parentId: baseline.id, prompt: 'Add a drain valve',
    goal: `${baseline.goal}\n\nRequested change:\nAdd a drain valve`, status,
    messages: [...baseline.messages, { role: 'user', content: 'Add a drain valve' }], evidence: undefined,
    events: [{ sequence: 1, at: '', phase: 'BUILDING', message: 'Building a drain valve.' }],
    spec: { ...structuredClone(baseline.spec!), title: 'Reservoir with drain', summary: 'This revision adds a controllable drain valve.' },
    candidate: { ...structuredClone(baseline.candidate!), source: `${baseline.candidate!.source}\n// failed update model` },
  };
  if (status === 'FAILED') {
    run.error = 'The drain update failed its behavior checks.';
    run.events.push({ sequence: 2, at: '', phase: 'FAILED', message: run.error });
    run.attempts = [{ candidate: run.candidate!, verification: {
      passed: false,
      results: [{ scenarioId: 'drains', name: 'Drain responds to its control', completed: true, checks: [{ id: 'drain', requirementIds: ['R1'], passed: false, actual: 0, message: 'Drain remained closed; expected 1 L/s.' }] }],
    } }];
  }
  return run;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe('simulation workbench conversation and saved results', () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let origin: string;
  beforeAll(async () => {
    const bundle = await build({
      stdin: { loader: 'tsx', resolveDir: process.cwd(), contents: `
        import {createRoot} from 'react-dom/client';
        import {SimulationWorkbench} from './src/SimulationWorkbench';
        createRoot(document.getElementById('root')).render(<SimulationWorkbench/>);
      ` },
      bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' }, write: false,
    });
    const source = bundle.outputFiles[0].text;
    server = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/harness.js' ? 'text/javascript' : 'text/html');
      response.end(request.url === '/harness.js' ? source : '<!doctype html><style>iframe{width:720px;height:405px}.sim-messages{max-height:300px;overflow:auto}</style><div id="root"></div><script type="module" src="/harness.js"></script>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const executable = chromium.executablePath();
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH ?? (existsSync(executable) ? executable : existsSync(macChrome) ? macChrome : undefined) });
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>(resolve => { if (server?.listening) server.close(() => resolve()); else resolve(); });
  });
  beforeEach(async () => {
    page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => {
      const instances = new Set<{ url: string; dispatchEvent(event: Event): boolean }>();
      class MockEventSource extends EventTarget {
        readonly url: string;
        constructor(url: string) { super(); this.url = url; instances.add(this); }
        close() { instances.delete(this); }
      }
      (window as unknown as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;
      const harness = window as unknown as HarnessWindow;
      harness.emitSimulationEvent = id => {
        for (const source of instances) if (source.url.includes(`/${id}/events`)) source.dispatchEvent(new Event('simulation-event'));
      };
      harness.simulationEventSourceCount = () => instances.size;
    });
  });
  afterEach(async () => { await page?.close(); });

  async function mockApi() {
    const runs = new Map([[baseline.id, structuredClone(baseline)]]);
    const get = vi.fn(async (id: string): Promise<SimulationRun | undefined> => runs.get(id));
    const start = vi.fn(async (_request: { prompt: string; previousId?: string }): Promise<SimulationRun> => structuredClone(baseline));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/health') {
        await route.fulfill({ json: { status: 'ok', model: 'test-model', keyConfigured: true, compilerAvailable: false, artifactDirectory: '/test-artifacts' } });
      } else if (url.pathname === '/api/simulations' && request.method() === 'POST') {
        await route.fulfill({ status: 202, json: await start(request.postDataJSON()) });
      } else if (url.pathname.startsWith('/api/simulations/')) {
        const run = await get(url.pathname.slice('/api/simulations/'.length));
        await route.fulfill({ status: run ? 200 : 404, json: run ?? { error: 'Simulation not found.' } });
      } else {
        await route.fulfill({ status: 404, json: { error: 'Unexpected endpoint' } });
      }
    });
    return { runs, get, start };
  }

  const signalRefresh = (id: string) => page.evaluate(id => (window as unknown as HarnessWindow).emitSimulationEvent(id), id);
  const waitForPreview = () => page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Play' && !button.disabled));

  it('loads the requested saved simulation, its controls, and its verified results from the query', async () => {
    const { get } = await mockApi();
    await page.goto(`${origin}/?simulation=${baseline.id}`);
    await waitForPreview();
    expect(get).toHaveBeenCalledWith(baseline.id);
    expect(await page.locator('.sim-build-status').textContent()).toContain('Ready to explore');
    expect(await page.locator('iframe').getAttribute('title')).toBe('Reservoir laboratory');
    expect(await page.getByLabel('Inflow').inputValue()).toBe('0');
    expect(await page.getByRole('link', { name: /Download simulation files/ }).getAttribute('href')).toBe(`/api/simulations/${baseline.id}/artifacts`);
    await page.getByRole('button', { name: 'Behavior checks', exact: true }).click();
    await page.locator('.sim-inspector summary').click();
    expect(await page.locator('.sim-inspector').textContent()).toContain('Observed baseline volume: 2 L.');
    expect(await page.locator('.sim-messages').textContent()).toContain(baseline.prompt);
  });

  it('sends a new freeform prompt to the generic endpoint without a legacy project or previous ID', async () => {
    const { start } = await mockApi();
    await page.goto(origin);
    const prompt = 'Show how pollen spreads between flowers on a windy day';
    await page.getByLabel('Describe your simulation').fill(prompt);
    await page.getByRole('button', { name: /Build simulation/ }).click();
    await waitForPreview();
    expect(start).toHaveBeenCalledWith({ prompt });
    expect(new URL(page.url()).searchParams.get('simulation')).toBe(baseline.id);
    expect(new URL(page.url()).searchParams.has('run')).toBe(false);
  });

  it('opens a runnable draft with controls while keeping its missing behavior verification explicit', async () => {
    const { runs } = await mockApi();
    const draft: SimulationRun = {
      ...structuredClone(baseline), status: 'DRAFT', evidence: undefined,
      warning: 'The verifier could not finish its checks.',
      draftEvidence: { sourceHash: 'source', specHash: 'spec', suiteHash: 'suite', runtimeVersion: SIMULATION_RUNTIME_VERSION, checkedAt: '' },
    };
    runs.set(draft.id, draft);
    await page.goto(`${origin}/?simulation=${draft.id}`);
    await waitForPreview();
    expect(await page.locator('.sim-build-status').textContent()).toContain('Draft · behavior not verified');
    expect(await page.locator('.sim-preview-caption').textContent()).toContain('behavior not verified');
    expect(await page.locator('.sim-preview-caption').textContent()).not.toContain('checks passed');
    expect(await page.locator('.sim-build-warning').textContent()).toContain(draft.warning);
    await page.getByLabel('Inflow').fill('3');
    const frame = await (await page.locator('iframe').elementHandle())!.contentFrame();
    const snapshot = () => frame!.evaluate(() => (window as unknown as { simulationHost: { command(command: { type: 'snapshot' }): Promise<{ state: { volume: number }; inputs: { inflow: number } }> } }).simulationHost.command({ type: 'snapshot' }));
    await vi.waitFor(async () => expect((await snapshot()).inputs.inflow).toBe(3));
    await page.getByRole('button', { name: 'Play', exact: true }).press('Enter');
    await page.locator('iframe').scrollIntoViewIfNeeded();
    await vi.waitFor(async () => expect((await snapshot()).state.volume).toBeGreaterThan(0));
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Behavior checks', exact: true }).press('Enter');
    await vi.waitFor(async () => expect(await page.locator('.sim-inspector').textContent()).toContain('Behavior checks could not be completed.'));
    expect(await page.getByRole('button', { name: /Update simulation/ }).isDisabled()).toBe(true);
    await page.getByLabel('Continue the conversation').fill('Make the tank wider');
    expect(await page.getByRole('button', { name: /Update simulation/ }).isEnabled()).toBe(true);
  });

  it('labels the previous preview after a failed follow-up and shows the current attempted checks and source', async () => {
    const { runs, start } = await mockApi();
    const building = updateRun('BUILDING');
    runs.set(building.id, building);
    start.mockResolvedValue(building);
    await page.goto(`${origin}/?simulation=${baseline.id}`);
    await waitForPreview();
    await page.getByLabel('Continue the conversation').fill('Add a drain valve');
    await page.getByRole('button', { name: /Update simulation/ }).click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('simulation') === 'drain-update');
    expect(start).toHaveBeenCalledWith({ prompt: 'Add a drain valve', previousId: baseline.id });
    const failed = updateRun('FAILED');
    runs.set(failed.id, failed);
    await signalRefresh(failed.id);
    await page.getByRole('status').filter({ hasText: 'Build needs a revision' }).waitFor();
    expect(await page.locator('iframe').getAttribute('title')).toBe(baseline.spec!.title);
    expect(await page.locator('.sim-preview-caption').textContent()).toMatch(/previous|earlier/i);
    expect(await page.getByRole('link', { name: /Download previous version/ }).getAttribute('href')).toBe(`/api/simulations/${baseline.id}/artifacts`);
    await page.getByRole('button', { name: 'Behavior checks', exact: true }).click();
    await page.locator('.sim-inspector summary').click();
    expect(await page.locator('.sim-inspector').textContent()).toContain('Drain remained closed; expected 1 L/s.');
    expect(await page.locator('.sim-inspector').textContent()).not.toContain('Observed baseline volume: 2 L.');
    await page.getByRole('button', { name: 'Generated source', exact: true }).click();
    expect(await page.locator('.sim-inspector pre').textContent()).toContain('// failed update model');
    await page.getByRole('button', { name: 'New simulation', exact: true }).press('Enter');
    await page.getByLabel('Describe your simulation').waitFor();
    expect(await page.locator('iframe').count()).toBe(0);
    expect(new URL(page.url()).search).toBe('');
    await vi.waitFor(async () => expect(await page.evaluate(() => (window as unknown as HarnessWindow).simulationEventSourceCount())).toBe(0));
  });

  it('shows failure observations when the initial build has no previously verified preview', async () => {
    const { runs } = await mockApi();
    const failed = updateRun('FAILED');
    delete failed.parentId;
    runs.set(failed.id, failed);
    await page.goto(`${origin}/?simulation=${failed.id}`);
    await page.getByRole('status').filter({ hasText: 'Build needs a revision' }).waitFor();
    expect(await page.locator('iframe').count()).toBe(0);
    await page.getByRole('button', { name: 'Behavior checks', exact: true }).click();
    await page.locator('.sim-inspector summary').click();
    expect(await page.locator('.sim-inspector').textContent()).toContain('Drain remained closed; expected 1 L/s.');
  });

  it.each(['BUILDING', 'FAILED'] as const)('restores the last verified ancestor when reloading a %s follow-up', async status => {
    const { runs, get } = await mockApi();
    const child = updateRun(status);
    runs.set(child.id, child);
    await page.goto(`${origin}/?simulation=${child.id}`);
    await waitForPreview();
    expect(get).toHaveBeenCalledWith(child.id);
    expect(get).toHaveBeenCalledWith(baseline.id);
    expect(await page.locator('iframe').getAttribute('title')).toBe(baseline.spec!.title);
    expect(await page.locator('.sim-preview-caption').textContent()).toContain('Previous version');
    expect(new URL(page.url()).searchParams.get('simulation')).toBe(child.id);
  });

  it('skips stale ancestors when restoring a saved conversation', async () => {
    const { runs, get } = await mockApi();
    const stale: SimulationRun = { ...structuredClone(baseline), id: 'stale-intermediate', parentId: baseline.id, status: 'STALE', spec: { ...structuredClone(baseline.spec!), title: 'Unverified stale model' } };
    const child = { ...updateRun('FAILED'), parentId: stale.id };
    runs.set(stale.id, stale);
    runs.set(child.id, child);
    await page.goto(`${origin}/?simulation=${child.id}`);
    await waitForPreview();
    expect(get).toHaveBeenCalledWith(stale.id);
    expect(get).toHaveBeenCalledWith(baseline.id);
    expect(await page.locator('iframe').getAttribute('title')).toBe(baseline.spec!.title);
  });

  it('does not replace a completed current model with a delayed ancestor restoration', async () => {
    const { runs, get } = await mockApi();
    const child = updateRun('BUILDING');
    runs.set(child.id, child);
    const started = deferred<void>();
    const oldAncestor = deferred<SimulationRun>();
    get.mockImplementation(async id => {
      if (id === baseline.id) { started.resolve(); return oldAncestor.promise; }
      return runs.get(id);
    });
    await page.goto(`${origin}/?simulation=${child.id}`);
    await started.promise;
    const ready: SimulationRun = { ...child, status: 'READY', evidence: baseline.evidence, events: [...child.events, { sequence: 2, at: '', phase: 'READY', message: 'The new drain model passed.' }] };
    runs.set(ready.id, ready);
    await signalRefresh(ready.id);
    await waitForPreview();
    expect(await page.locator('iframe').getAttribute('title')).toBe('Reservoir with drain');
    const response = page.waitForResponse(url => url.url().endsWith(`/api/simulations/${baseline.id}`));
    oldAncestor.resolve(structuredClone(baseline));
    await response;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.locator('iframe').getAttribute('title')).toBe('Reservoir with drain');
    expect(await page.locator('.sim-preview-caption').textContent()).not.toContain('Previous version');
  });

  it('removes a retained ancestor that becomes stale and ignores its delayed READY response', async () => {
    const { runs, get } = await mockApi();
    const child = updateRun('FAILED');
    runs.set(child.id, child);
    await page.goto(`${origin}/?simulation=${child.id}`);
    await waitForPreview();
    const stale: SimulationRun = { ...structuredClone(baseline), status: 'STALE', events: [...baseline.events, { sequence: 4, at: '', phase: 'STALE', message: 'Ancestor source changed.' }] };
    const started = deferred<void>();
    const lateReady = deferred<SimulationRun>();
    get.mockImplementationOnce(async () => { started.resolve(); return lateReady.promise; }).mockImplementation(async id => id === baseline.id ? stale : runs.get(id));
    await signalRefresh(baseline.id);
    await started.promise;
    await signalRefresh(baseline.id);
    await page.locator('iframe').waitFor({ state: 'detached' });
    const response = page.waitForResponse(url => url.url().endsWith(`/api/simulations/${baseline.id}`));
    lateReady.resolve(structuredClone(baseline));
    await response;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.locator('iframe').count()).toBe(0);
    expect(await page.locator('.sim-build-status').textContent()).toContain('Build needs a revision');
  });

  it('ignores a delayed READY response after a newer STALE response removed the preview', async () => {
    const { get } = await mockApi();
    await page.goto(`${origin}/?simulation=${baseline.id}`);
    await waitForPreview();
    const started = deferred<void>();
    const lateReady = deferred<SimulationRun>();
    const stale: SimulationRun = { ...structuredClone(baseline), status: 'STALE', error: 'The saved source changed.', events: [...baseline.events, { sequence: 4, at: '', phase: 'STALE', message: 'The saved source changed.' }] };
    get.mockImplementationOnce(async () => { started.resolve(); return lateReady.promise; }).mockResolvedValue(stale);
    await signalRefresh(baseline.id);
    await started.promise;
    await signalRefresh(baseline.id);
    await page.getByRole('status').filter({ hasText: 'Saved files changed' }).waitFor();
    expect(await page.locator('iframe').count()).toBe(0);
    const response = page.waitForResponse(url => url.url().endsWith(`/api/simulations/${baseline.id}`));
    lateReady.resolve(structuredClone(baseline));
    await response;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.locator('.sim-build-status').textContent()).toContain('Saved files changed');
    expect(await page.locator('iframe').count()).toBe(0);
    expect(await page.getByRole('link', { name: /Download simulation files/ }).count()).toBe(0);
  });

  it('reloads repaired controller source within the same revision instead of retaining an older preview', async () => {
    const { runs } = await mockApi();
    await page.goto(`${origin}/?simulation=${baseline.id}`);
    await waitForPreview();
    const repaired = structuredClone(baseline);
    repaired.candidate!.source = repaired.candidate!.source.replaceAll('volume=0', 'volume=10');
    repaired.events.push({ sequence: 4, at: '', phase: 'READY', message: 'The same revision was repaired for its hardware target.' });
    runs.set(repaired.id, repaired);
    await signalRefresh(repaired.id);
    await vi.waitFor(async () => expect(await page.locator('.sim-live-values').textContent()).toContain('10'));
    expect(new URL(page.url()).searchParams.get('simulation')).toBe(baseline.id);
    expect(await page.locator('.sim-preview-caption').textContent()).not.toContain('Previous');
  });
});
