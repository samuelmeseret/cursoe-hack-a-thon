import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { compilerAvailable } from '../server/compiler';
import { hardwareEnvironment } from '../server/hardware-adapters';
import { HardwareProjectService } from '../server/hardware-project';
import { hardwareCatalogRoutes } from '../server/hardware-routes';
import { SimulationController } from '../server/simulation-controller';
import { simulationRoutes } from '../server/simulation-routes';
import { HardwareFixtureAgents, timedLight } from './hardware-fixtures';

const execute = promisify(execFile);
const evidenceDirectory = path.resolve('.artifacts/hardware-verification');

function downloadedEntries(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('The browser download has no ZIP central directory.');
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP central directory entry.');
    const method = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20), nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) throw new Error('Unsafe path in browser ZIP download.');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    if (![0, 8].includes(method)) throw new Error('Unsupported ZIP compression.');
    entries.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('browser to real hardware build and ZIP download', () => {
  let server: Server, browser: Browser, page: Page, directory: string, origin: string;
  let simulations: SimulationController, hardware: HardwareProjectService;
  const requests: { method: string; path: string }[] = [];

  beforeAll(async () => {
    await mkdir('.artifacts/tests', { recursive: true });
    await mkdir(evidenceDirectory, { recursive: true });
    directory = await mkdtemp(path.resolve('.artifacts/tests/hardware-browser-'));
    simulations = new SimulationController({ agents: new HardwareFixtureAgents(timedLight), directory: path.join(directory, 'simulations') });
    hardware = new HardwareProjectService(simulations, { directory: path.join(directory, 'hardware') });
    const bundle = await build({ stdin: { loader: 'tsx', resolveDir: process.cwd(), contents: `
      import {createRoot} from 'react-dom/client';
      import {SimulationWorkbench} from './src/SimulationWorkbench';
      import './src/style.css';
      createRoot(document.getElementById('root')).render(<SimulationWorkbench/>);
    ` }, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', write: false, outdir: '/hardware-real-browser' });
    const source = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
    const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
    const app = express();
    app.use(express.json());
    app.use('/api', (request, response, next) => { requests.push({ method: request.method, path: request.originalUrl }); response.setHeader('Cache-Control', 'no-store'); next(); });
    app.get('/api/health', async (_request, response) => response.json({ status: 'ok', model: 'deterministic-hardware-fixture', keyConfigured: false, compilerAvailable: await compilerAvailable(), artifactDirectory: directory }));
    app.use('/api/simulations', simulationRoutes(simulations, hardware));
    app.use('/api/hardware', hardwareCatalogRoutes());
    app.get('/app.js', (_request, response) => response.type('js').send(source));
    app.get('/', (_request, response) => response.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script type="module" src="/app.js"></script>`));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const bundled = chromium.executablePath(), macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH ?? (existsSync(bundled) ? bundled : existsSync(macChrome) ? macChrome : undefined) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(20000);
  });
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('describes, simulates, selects a catalog board, configures, compiles, downloads and independently rebuilds through the UI', async () => {
    await page.goto(origin);
    await page.getByLabel('Describe your simulation', { exact: true }).fill(timedLight.spec.goal);
    await page.getByRole('button', { name: /Build simulation/ }).click();
    await page.locator('.sim-build-status').filter({ hasText: 'Ready to explore' }).waitFor({ timeout: 120000 });
    const id = new URL(page.url()).searchParams.get('simulation');
    expect(id).toBeTruthy();
    const simulation = await simulations.get(id!);
    expect(simulation?.evidence?.passed).toBe(true);
    expect(simulation?.candidate?.controller).toEqual(timedLight.program);
    await page.getByRole('button', { name: 'Start timer', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.sim-live-values')?.textContent?.includes('Lamp outputYes'));
    await page.getByRole('button', { name: 'Reset', exact: true }).click();

    await page.getByRole('button', { name: 'Choose hardware', exact: true }).click();
    await page.getByLabel('Board or device name').fill(timedLight.configuration.fqbn);
    await page.getByRole('button', { name: 'Search catalog', exact: true }).click();
    const board = page.locator('.hardware-catalog li').filter({ has: page.locator('code', { hasText: /^arduino:avr:uno$/ }) });
    await board.getByRole('button', { name: 'Select board', exact: true }).click();
    await page.getByLabel('Start timer pin', { exact: true }).selectOption('2');
    await page.getByLabel('Start timer component', { exact: true }).fill('Pushbutton to ground');
    await page.locator('.hardware-binding').filter({ has: page.locator('legend', { hasText: 'Start timer' }) }).getByRole('checkbox').check();
    await page.getByLabel('Lamp pin', { exact: true }).selectOption('8');
    await page.getByLabel('Lamp component', { exact: true }).fill('LED with 330 ohm series resistor');
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await page.getByRole('button', { name: 'Build & check', exact: true }).click();
    const downloadLink = page.getByRole('link', { name: 'Download hardware project ZIP', exact: true });
    try { await downloadLink.waitFor({ timeout: 120000 }); }
    catch (error) { const state = await hardware.get(id!); throw new Error(`UI hardware build did not reach download: ${state.status}. ${state.error ?? state.log ?? String(error)}`); }
    const built = await hardware.get(id!);
    expect(built.configuration).toEqual(timedLight.configuration);
    expect(built.evidence).toMatchObject({ generated: true, compiled: true, simulationChecked: true, controllerParity: true, physicalTested: false });
    expect(await page.locator('.hardware-verification [data-passed=true]').count()).toBe(3);
    expect(await page.locator('.hardware-verification').textContent()).toContain('Physical hardware · untested');
    const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
    expect(download.suggestedFilename()).toContain(id!);
    const downloadedPath = path.join(evidenceDirectory, 'browser-timed-light.zip');
    await download.saveAs(downloadedPath);
    expect(await download.failure()).toBeNull();
    const bytes = await readFile(downloadedPath);
    const entries = downloadedEntries(bytes);
    expect(bytes.length).toBeGreaterThan(10000);
    for (const name of ['device/device.ino', 'device/controller.h', 'controller.json', 'simulation.html', 'WIRING.md', 'README.md', 'dependency-lock.json', 'verification-report.json', 'firmware/device.ino.hex']) expect(entries.has(name), name).toBe(true);
    expect(JSON.parse(entries.get('controller.json')!.toString())).toEqual(timedLight.program);
    expect(JSON.parse(entries.get('verification-report.json')!.toString())).toMatchObject({ compiled: true, simulationChecked: true, controllerParity: true, physicalTested: false });
    expect(requests.some(request => request.path.endsWith('/hardware/upload'))).toBe(false);
    expect(requests).toEqual(expect.arrayContaining([
      { method: 'POST', path: '/api/simulations' },
      { method: 'PUT', path: `/api/simulations/${id}/hardware` },
      { method: 'POST', path: `/api/simulations/${id}/hardware/build` },
      { method: 'GET', path: `/api/simulations/${id}/hardware/export` },
    ]));

    // Rebuild only files saved by the browser, outside the app's generator and service.
    const extracted = path.join(directory, 'browser-download');
    for (const [name, content] of entries) { await mkdir(path.dirname(path.join(extracted, name)), { recursive: true }); await writeFile(path.join(extracted, name), content); }
    const localCli = path.resolve('.arduino/bin/arduino-cli');
    const cli = process.env.ARDUINO_CLI_PATH ?? (existsSync(localCli) ? localCli : 'arduino-cli');
    const compileArgs = ['compile', '--fqbn', timedLight.configuration.fqbn, '--warnings', 'all', '--jobs', '2', '--build-path', path.join(extracted, 'independent-build'), '--output-dir', path.join(extracted, 'independent-firmware'), 'device'];
    const independent = await execute(cli, compileArgs, { cwd: extracted, env: hardwareEnvironment(), timeout: 120000, maxBuffer: 8_000_000 });
    expect((await readdir(path.join(extracted, 'independent-firmware'))).some(file => file.endsWith('.hex'))).toBe(true);
    await writeFile(path.join(evidenceDirectory, 'browser-timed-light-independent-compile.log'), `${independent.stdout}\n${independent.stderr}`);
    await writeFile(path.join(evidenceDirectory, 'browser-workflow-report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), method: 'Real browser UI, HTTP API, catalog, board profile, simulation worker, native controller parity, Arduino CLI compile, browser ZIP download and independent CLI rebuild. Only generation uses deterministic fixture agents.', project: timedLight.name, revisionId: id, fqbn: built.profile?.fqbn, architecture: built.profile?.architecture, evidence: built.evidence, zipSha256: createHash('sha256').update(bytes).digest('hex'), zipBytes: bytes.length, downloadedZipRecompiled: true, uploaded: false, physicalTests: [], requests }, null, 2));
  }, 180000);
});
