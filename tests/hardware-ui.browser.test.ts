import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import type { HardwareConfiguration, HardwareEvidence, HardwareProjectState } from '../shared/hardware-project';
import type { ConnectedDevice, HardwareCatalog, HardwareProfile } from '../shared/hardware-types';
import type { SimulationRun } from '../shared/simulation-run';

const run: SimulationRun = {
  id: 'revision-1', projectId: 'project-shared', revision: 1, prompt: 'Control a motor with the W key', goal: 'Control a motor with the W key',
  status: 'READY', createdAt: '', updatedAt: '', deadlineAt: '', messages: [], events: [], attempts: [],
  spec: { goal: 'Control a motor', title: 'Keyboard actuator', summary: 'A keyboard controls an actuator.', assumptions: [], controls: [{ id: 'drive', label: 'Drive', type: 'key', key: 'w', initial: false }], observables: [{ id: 'motor', label: 'Motor', type: 'boolean' }], requirements: [{ id: 'R1', text: 'Drive the motor while the key is held.' }] },
  candidate: {
    id: 'controller-1', rationale: 'One controller runs in both targets.', source: '', environmentSource: 'function createEnvironment(){return {};}',
    controller: { version: 1, name: 'Keyboard actuator', inputs: [{ id: 'drive', label: 'Drive', type: 'boolean', initial: false, key: 'w', hardware: { kind: 'serial', component: 'Computer keyboard' } }], state: [], outputs: [{ id: 'motor', label: 'Motor', type: 'boolean', initial: false, hardware: { kind: 'digital-output', component: 'Motor driver', description: 'Connect through an external driver and supply.' } }], step: [], update: [{ set: 'motor', value: { ref: 'drive' } }] },
  },
};
const profile: HardwareProfile = {
  id: 'arduino:avr:uno', fqbn: 'arduino:avr:uno', name: 'Arduino Uno', architecture: 'avr', framework: 'Arduino', toolchain: 'avr-g++', adapter: 'arduino-cli', core: 'arduino:avr', version: '1.8.6', installed: true,
  supported: true, missingCapabilities: [], uploadSupported: true, options: [], constraints: ['Use a motor driver; GPIO pins cannot power motors.'], interfaces: ['GPIO', 'USB serial'], capabilities: ['digital-input', 'digital-output', 'serial'], metadataSources: ['boards.txt', 'variants/standard/pins_arduino.h'],
  pins: [{ id: '2', label: 'D2', number: 2, digital: true, analog: false, pwm: false, interfaces: [] }, { id: '3', label: 'D3', number: 3, digital: true, analog: false, pwm: true, interfaces: ['PWM'] }],
};
const catalog: HardwareCatalog = { boards: [{ id: profile.id, name: profile.name, fqbn: profile.fqbn, architecture: profile.architecture, core: profile.core, version: profile.version, installed: true, supported: true, missingCapabilities: [] }], packages: [], warnings: [] };
const evidence: HardwareEvidence = { generated: true, compiled: true, simulationChecked: true, controllerParity: true, physicalTested: false, fingerprint: 'current-fingerprint', checkedAt: '', artifactHashes: { 'firmware.hex': 'sha' }, parityChecks: 8, statement: 'The compiled controller matched the simulation.' };
const configuration: HardwareConfiguration = { fqbn: profile.fqbn, bindings: [{ signalId: 'drive', direction: 'input', kind: 'serial', component: 'Computer keyboard' }, { signalId: 'motor', direction: 'output', kind: 'digital-output', pin: '2', component: 'Motor driver', notes: 'Connect through an external driver and supply.' }], libraries: [], baudRate: 115200, serialTimeoutMs: 500 };

describe('integrated hardware workflow', () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let origin: string;
  beforeAll(async () => {
    const bundle = await build({ stdin: { loader: 'tsx', resolveDir: process.cwd(), contents: `
      import {createRoot} from 'react-dom/client';
      import {HardwarePanel} from './src/HardwarePanel';
      import './src/style.css';
      const root = createRoot(document.getElementById('root'));
      window.setHardwareRun = run => root.render(<main style={{maxWidth:1050}}><HardwarePanel key={run.id} run={run}/></main>);
      window.setHardwareRun(window.hardwareFixture);
    ` }, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', write: false, outdir: '/hardware-harness' });
    const js = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
    const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
    server = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/harness.js' ? 'text/javascript' : 'text/html');
      response.end(request.url === '/harness.js' ? js : `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script type="module" src="/harness.js"></script>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const bundled = chromium.executablePath();
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH ?? (existsSync(bundled) ? bundled : existsSync(macChrome) ? macChrome : undefined) });
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server?.listening ? server.close(() => resolve()) : resolve()); });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(7000);
    await page.addInitScript(fixture => { (window as unknown as { hardwareFixture: SimulationRun }).hardwareFixture = fixture; }, run);
  });
  afterEach(async () => { await page?.close(); });

  async function mockApi(initial?: HardwareProjectState) {
    let state: HardwareProjectState = initial ?? { projectId: 'project-shared', revisionId: run.id, status: 'UNCONFIGURED', issues: [], updatedAt: '1' };
    let nextProfile = structuredClone(profile);
    let nextCatalog = structuredClone(catalog);
    let nextDevices: ConnectedDevice[] = [{ port: '/dev/tty.usbmodem1', label: 'USB connected Arduino', protocol: 'serial', identified: true, boards: [{ name: 'Arduino Uno', fqbn: profile.fqbn }] }];
    const save = vi.fn((value: HardwareConfiguration) => { state = { ...state, configuration: value, profile: nextProfile, status: 'CONFIGURED', evidence: undefined, updatedAt: String(Number(state.updatedAt) + 1) }; return state; });
    const compile = vi.fn(() => { state = { ...state, status: 'BUILDING', updatedAt: String(Number(state.updatedAt) + 1) }; return state; });
    const upload = vi.fn((value: { port: string; confirm: boolean }) => ({ ...state, upload: { port: value.port, uploadedAt: '', log: 'Uploaded', statement: 'Firmware uploaded successfully.' } }));
    const install = vi.fn(() => catalog);
    const get = vi.fn(async () => state);
    await page.route('**/api/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.pathname === '/api/hardware/catalog') await route.fulfill({ json: nextCatalog });
      else if (url.pathname === '/api/hardware/profile') await route.fulfill({ json: nextProfile });
      else if (url.pathname === '/api/hardware/packages') await route.fulfill({ json: install() });
      else if (url.pathname === '/api/hardware/devices') await route.fulfill({ json: { devices: nextDevices, warnings: [] } });
      else if (url.pathname.endsWith('/hardware/build')) await route.fulfill({ status: 202, json: compile() });
      else if (url.pathname.endsWith('/hardware/upload')) await route.fulfill({ json: upload(request.postDataJSON()) });
      else if (url.pathname.endsWith('/hardware')) await route.fulfill({ json: request.method() === 'PUT' ? save(request.postDataJSON()) : await get() });
      else await route.fulfill({ status: 404, json: { error: 'Unknown test endpoint' } });
    });
    return { save, compile, upload, install, get, finish: () => { state = { ...state, status: 'COMPILED', evidence, log: 'avr-g++ completed. Shared controller parity passed.', updatedAt: String(Number(state.updatedAt) + 1) }; }, profile: (next: HardwareProfile) => { nextProfile = next; }, catalog: (next: HardwareCatalog) => { nextCatalog = next; }, devices: (next: ConnectedDevice[]) => { nextDevices = next; } };
  }
  async function openHardware() { await page.goto(origin); await page.getByRole('button', { name: 'Choose hardware', exact: true }).click(); await page.getByRole('button', { name: 'Search catalog', exact: true }).waitFor({ state: 'visible' }); }
  async function chooseBoard() { await page.getByLabel('Board or device name').fill('Arduino Uno'); await page.getByRole('button', { name: 'Search catalog', exact: true }).click(); await page.getByRole('button', { name: 'Select board', exact: true }).click(); await page.getByLabel('Motor pin', { exact: true }).waitFor(); }

  it('configures, builds, exports and uploads only after the user selects a device and requests it', async () => {
    const api = await mockApi();
    await openHardware(); await chooseBoard();
    expect(await page.getByRole('button', { name: 'Build & check', exact: true }).isDisabled()).toBe(true);
    expect(await page.locator('.hardware-communication').textContent()).toContain('Browser controls do not send commands');
    await page.getByLabel('Motor pin', { exact: true }).selectOption('2');
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0][0]).toMatchObject(configuration);
    await page.getByRole('button', { name: 'Build & check', exact: true }).click();
    await vi.waitFor(() => expect(api.compile).toHaveBeenCalledTimes(1));
    expect(await page.getByRole('link', { name: 'Download hardware project ZIP' }).count()).toBe(0);
    api.finish();
    await page.getByRole('link', { name: 'Download hardware project ZIP' }).waitFor();
    expect(await page.getByRole('link', { name: 'Download hardware project ZIP' }).getAttribute('href')).toBe(`/api/simulations/${run.id}/hardware/export`);
    expect(await page.locator('.hardware-verification').textContent()).toContain('Physical hardware · untested');
    expect(await page.locator('.hardware-verification [data-passed=true]').count()).toBe(3);
    expect(api.upload).not.toHaveBeenCalled();
    await page.getByText('Upload to a selected device', { exact: true }).click();
    await page.getByRole('button', { name: 'Refresh connected devices', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Upload firmware to selected device', exact: true }).isDisabled()).toBe(true);
    await page.getByLabel('Device to upload to').selectOption('/dev/tty.usbmodem1');
    expect(api.upload).not.toHaveBeenCalled();
    await page.getByRole('button', { name: 'Upload firmware to selected device', exact: true }).click();
    await vi.waitFor(() => expect(api.upload).toHaveBeenCalledWith({ port: '/dev/tty.usbmodem1', confirm: true }));
    expect(await page.locator('.hardware-verification').textContent()).toContain('Physical hardware · untested');
    await mkdir('.artifacts/hardware-ui', { recursive: true });
    await page.screenshot({ path: '.artifacts/hardware-ui/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.artifacts/hardware-ui/mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  it('invalidates compiled evidence immediately on edits and preserves unsaved edits when hidden and reopened', async () => {
    await mockApi({ projectId: run.projectId!, revisionId: run.id, status: 'COMPILED', configuration, profile, evidence, issues: [], updatedAt: '1' });
    await openHardware();
    await page.getByRole('link', { name: 'Download hardware project ZIP' }).waitFor();
    await page.getByLabel('Motor pin', { exact: true }).selectOption('3');
    expect(await page.getByRole('link', { name: 'Download hardware project ZIP' }).count()).toBe(0);
    expect(await page.locator('.hardware-verification [data-passed=true]').count()).toBe(0);
    expect(await page.locator('#hardware-workflow').textContent()).toContain('Previous build and check results do not apply');
    await page.getByRole('button', { name: 'Hide hardware', exact: true }).click();
    await page.getByRole('button', { name: 'Configure hardware', exact: true }).click();
    expect(await page.getByLabel('Motor pin', { exact: true }).inputValue()).toBe('3');
    expect(await page.getByRole('link', { name: 'Download hardware project ZIP' }).count()).toBe(0);
  });

  it('labels a compiled but behavior-unverified export as a draft and keeps upload unavailable', async () => {
    await mockApi({ projectId: run.projectId!, revisionId: run.id, status: 'COMPILED', configuration, profile, evidence: { ...evidence, simulationChecked: false }, issues: [], updatedAt: '1' });
    await openHardware();
    await page.getByRole('link', { name: 'Download compiled draft ZIP', exact: true }).waitFor();
    expect(await page.locator('.hardware-verification [data-passed=true]').count()).toBe(2);
    expect(await page.locator('.hardware-build').textContent()).toContain('simulation requirements are not fully verified');
    expect(await page.getByText('Upload to a selected device', { exact: true }).count()).toBe(0);
  });

  it('allows an explicitly selected unidentified port and explains that its board model must be checked', async () => {
    const api = await mockApi({ projectId: run.projectId!, revisionId: run.id, status: 'COMPILED', configuration, profile, evidence, issues: [], updatedAt: '1' });
    api.devices([{ port: '/dev/tty.unknown', label: 'USB serial device', protocol: 'serial', identified: false, boards: [] }]);
    await openHardware();
    await page.getByText('Upload to a selected device', { exact: true }).click();
    await page.getByRole('button', { name: 'Refresh connected devices', exact: true }).click();
    await page.getByLabel('Device to upload to').locator('option').filter({ hasText: 'unidentified' }).waitFor({ state: 'attached' });
    expect(await page.getByLabel('Device to upload to').textContent()).toContain('unidentified — verify selected board model');
    await page.getByLabel('Device to upload to').selectOption('/dev/tty.unknown');
    expect(await page.locator('.hardware-upload').textContent()).toContain('Verify that the connected device is Arduino Uno');
    expect(api.upload).not.toHaveBeenCalled();
    await page.getByRole('button', { name: 'Upload firmware to selected device', exact: true }).click();
    await vi.waitFor(() => expect(api.upload).toHaveBeenCalledWith({ port: '/dev/tty.unknown', confirm: true }));
  });

  it('invalidates evidence when a hardware repair changes controller content in the same revision', async () => {
    const api = await mockApi({ projectId: run.projectId!, revisionId: run.id, status: 'COMPILED', configuration, profile, evidence, issues: [], updatedAt: '1' });
    await openHardware();
    await page.getByRole('link', { name: 'Download hardware project ZIP' }).waitFor();
    const repaired = structuredClone(run);
    repaired.candidate!.controller!.update = [{ set: 'motor', value: false }];
    api.get.mockResolvedValue({ projectId: run.projectId!, revisionId: run.id, status: 'STALE', configuration, profile, issues: [], updatedAt: '2' });
    await page.evaluate(next => (window as unknown as { setHardwareRun: (run: SimulationRun) => void }).setHardwareRun(next), repaired);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(await page.getByRole('link', { name: 'Download hardware project ZIP' }).count()).toBe(0);
    expect(await page.locator('.hardware-verification [data-passed=true]').count()).toBe(0);
  });

  it('explains missing target capabilities and prevents unsupported builds', async () => {
    const api = await mockApi();
    api.profile({ ...profile, id: 'unsupported', name: 'Unsupported wireless module', supported: false, missingCapabilities: ['No build adapter provides this architecture’s required radio driver.'] });
    await openHardware(); await chooseBoard();
    expect(await page.locator('.hardware-issues').textContent()).toContain('No build adapter provides this architecture’s required radio driver.');
    expect(await page.getByRole('button', { name: 'Build & check', exact: true }).isDisabled()).toBe(true);
    expect(api.compile).not.toHaveBeenCalled();
  });

  it('installs missing real board packages before resolving a board', async () => {
    const api = await mockApi();
    api.catalog({ ...catalog, boards: [{ ...catalog.boards[0], fqbn: undefined, installed: false }] });
    await openHardware();
    await page.getByLabel('Board or device name').fill('Uno');
    await page.getByRole('button', { name: 'Search catalog', exact: true }).click();
    api.catalog(catalog);
    await page.getByRole('button', { name: 'Install board package', exact: true }).click();
    await page.getByRole('button', { name: 'Select board', exact: true }).waitFor();
    expect(api.install).toHaveBeenCalledTimes(1);
  });

  it('keeps revision changes separate from delayed build responses', async () => {
    const api = await mockApi({ projectId: run.projectId!, revisionId: run.id, status: 'BUILDING', configuration, profile, issues: [], updatedAt: '1' });
    await openHardware();
    await page.getByRole('button', { name: 'Building & checking…', exact: true }).waitFor();
    const revision2 = { ...structuredClone(run), id: 'revision-2', revision: 2 };
    await page.evaluate(next => (window as unknown as { setHardwareRun: (run: SimulationRun) => void }).setHardwareRun(next), revision2);
    api.finish();
    await page.getByRole('button', { name: 'Choose hardware', exact: true }).click();
    // The backend may still return the earlier revision during a race. It is never accepted.
    await page.getByRole('button', { name: 'Search catalog', exact: true }).waitFor();
    expect(await page.getByRole('link', { name: 'Download hardware project ZIP' }).count()).toBe(0);
    expect(await page.locator('.hardware-verification [data-passed=true]').count()).toBe(0);
  });

  it('reports a specific missing controller capability for simulation-only projects', async () => {
    const api = await mockApi();
    const simulationOnly = structuredClone(run);
    simulationOnly.candidate = { id: 'visual', source: '', rationale: '', hardwareUnavailableReason: 'This chemical model requires a solver that the portable controller runtime does not support.' };
    await page.goto(origin);
    await page.evaluate(next => (window as unknown as { setHardwareRun: (run: SimulationRun) => void }).setHardwareRun(next), simulationOnly);
    await page.getByRole('button', { name: 'Choose hardware', exact: true }).click();
    expect(await page.locator('.hardware-missing').textContent()).toContain('requires a solver');
    expect(api.get).not.toHaveBeenCalled();
    expect(await page.getByRole('button', { name: 'Build & check', exact: true }).count()).toBe(0);
  });
});
