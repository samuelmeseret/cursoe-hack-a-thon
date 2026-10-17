import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from '@playwright/test';
import { compileCandidate } from '../server/compiler';
import { runSimulation } from '../server/simulation';
import { generateCircuit } from '../shared/circuit';
import {
  blinkSpec, blinkCandidate, blinkScenarios, buttonSpec, buttonCandidate, buttonScenarios,
  airlockSpec, goodAirlockCandidate, airlockScenarios,
} from '../shared/fixtures';
import type { ScenarioResult } from '../shared/types';

describe('Actual browser Worker / authoritative Node Worker trace parity', () => {
  let server: Server;
  let browser: Browser;
  let origin: string;
  let directory: string;
  const externalVite = process.env.PARITY_BASE_URL;
  beforeAll(async () => {
    await mkdir('.artifacts/tests', { recursive: true });
    directory = await mkdtemp(path.resolve('.artifacts/tests/browser-'));
    // Serve the real production browser-worker source, bundled for a browser, to Chromium.
    const bundle = await build({ entryPoints: ['src/simulator.worker.ts'], bundle: true, platform: 'browser', format: 'esm', write: false });
    const workerSource = bundle.outputFiles[0].text;
    server = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/worker.js' ? 'text/javascript' : 'text/html');
      response.end(request.url === '/worker.js' ? workerSource : '<!doctype html><title>AVR worker parity harness</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = externalVite ?? `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const packaged = chromium.executablePath();
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? (existsSync(packaged) ? packaged : existsSync(macChrome) ? macChrome : undefined);
    browser = await chromium.launch({ headless: true, executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => { if (server?.listening) server.close(() => resolve()); else resolve(); });
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each([
    { name: 'known Blink', spec: blinkSpec, candidate: blinkCandidate, scenario: blinkScenarios[0] },
    { name: 'known button sketch', spec: buttonSpec, candidate: buttonCandidate, scenario: buttonScenarios[0] },
    { name: 'airlock with scripted bounce', spec: airlockSpec, candidate: goodAirlockCandidate, scenario: airlockScenarios.find((scenario) => scenario.id === 'bounce')! },
  ])('$name produces identical instruction-timestamped GPIO evidence', async ({ spec, candidate, scenario }) => {
    const { hex } = await compileCandidate(candidate, path.join(directory, candidate.id));
    const circuit = generateCircuit(spec, candidate.pins);
    const [nodeResult] = await runSimulation(hex, circuit, [scenario]);
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      const browserResult = await page.evaluate(({ hex, circuit, scenario, externalVite }) => {
        const workerUrl = externalVite ? '/src/simulator.worker.ts?worker_file&type=module' : '/worker.js';
        return new Promise<ScenarioResult>((resolve, reject) => {
          const worker = new Worker(workerUrl, { type: 'module' });
          const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Browser simulation timed out')); }, 40_000);
          worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
          worker.onmessage = (event) => {
            if (event.data.type === 'result') { clearTimeout(timeout); worker.terminate(); resolve(event.data.result); }
            if (event.data.type === 'error') { clearTimeout(timeout); worker.terminate(); reject(new Error(event.data.message)); }
          };
          worker.postMessage({ type: 'scenario', hex, circuit, scenario });
        });
      }, { hex, circuit, scenario, externalVite });
      expect(nodeResult.completed).toBe(true);
      expect(nodeResult.checks.every((check) => check.passed)).toBe(true);
      expect(browserResult).toEqual(nodeResult);
    } finally { await page.close(); }
  });
});
