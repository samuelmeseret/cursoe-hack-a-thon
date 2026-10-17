import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { SimulatorCommand } from '../shared/types';

type HarnessWindow = Window & { commands: SimulatorCommand[]; setEnabled: (enabled: boolean) => void };

describe('Keyboard serial controls in a real browser', () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let origin: string;
  beforeAll(async () => {
    const bundle = await build({
      stdin: { loader: 'tsx', resolveDir: process.cwd(), contents: `
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { SerialControls } from './src/ProjectSimulation';
        window.commands = [];
        const config = { baudRate: 9600, controls: [
          { key: 'w', label: 'Forward', data: 'W', releaseData: 'X' },
          { key: 's', label: 'Backward', data: 'S', releaseData: 'X' },
          { key: ' ', label: 'Stop', data: 'X' },
          { key: 'q', label: 'Lift', data: 'Q', releaseData: 'Z' },
        ] };
        function Harness() {
          const [enabled, setEnabled] = useState(true);
          window.setEnabled = setEnabled;
          return <><textarea aria-label="Project goal"/><SerialControls config={config} enabled={enabled} send={command => window.commands.push(command)}/></>;
        }
        createRoot(document.getElementById('root')).render(<Harness/>);
      ` },
      bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', write: false, outdir: '/virtual-controls-harness',
    });
    const source = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
    server = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/harness.js' ? 'text/javascript' : 'text/html');
      response.end(request.url === '/harness.js' ? source : '<!doctype html><div id="root"></div><script type="module" src="/harness.js"></script>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const packaged = chromium.executablePath();
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? (existsSync(packaged) ? packaged : existsSync(macChrome) ? macChrome : undefined);
    browser = await chromium.launch({ headless: true, executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>(resolve => { if (server?.listening) server.close(() => resolve()); else resolve(); });
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(origin);
    await page.getByRole('button', { name: /Forward/ }).waitFor();
  });
  afterEach(async () => { await page?.close(); });
  const commands = () => page.evaluate(() => (window as unknown as HarnessWindow).commands);
  const clearCommands = () => page.evaluate(() => { (window as unknown as HarnessWindow).commands = []; });

  it('uses the configured Space stop command even when Forward has focus', async () => {
    await page.getByRole('button', { name: /Forward/ }).click();
    await clearCommands();
    await page.keyboard.down('Space');
    expect(await commands()).toEqual([{ type: 'serial', data: 'X' }]);
    expect(await page.getByRole('button', { name: /Forward/ }).getAttribute('aria-pressed')).toBe('false');
    await page.keyboard.up('Space');
    expect(await commands()).toEqual([{ type: 'serial', data: 'X' }]);
  });

  it('clears controls sharing a stop command while retaining independent held controls', async () => {
    await page.keyboard.down('w');
    await page.keyboard.down('s');
    await page.keyboard.down('q');
    await page.keyboard.up('w');
    expect(await commands()).toEqual(['W', 'S', 'Q', 'X'].map(data => ({ type: 'serial', data })));
    expect(await page.getByRole('button', { name: /Forward/ }).getAttribute('aria-pressed')).toBe('false');
    expect(await page.getByRole('button', { name: /Backward/ }).getAttribute('aria-pressed')).toBe('false');
    expect(await page.getByRole('button', { name: /Lift/ }).getAttribute('aria-pressed')).toBe('true');
    await page.keyboard.up('s');
    await page.keyboard.up('q');
    expect(await commands()).toEqual(['W', 'S', 'Q', 'X', 'Z'].map(data => ({ type: 'serial', data })));
  });

  it('does not drive motors when typing a project goal', async () => {
    const goal = page.getByRole('textbox', { name: 'Project goal' });
    await goal.focus();
    await page.keyboard.type('w s q');
    expect(await goal.inputValue()).toBe('w s q');
    expect(await commands()).toEqual([]);
  });

  it('releases held controls on window blur without duplicating later key releases', async () => {
    await page.keyboard.down('w');
    await page.keyboard.down('s');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(await commands()).toEqual(['W', 'S', 'X'].map(data => ({ type: 'serial', data })));
    expect(await page.locator('[aria-pressed="true"]').count()).toBe(0);
    await page.keyboard.up('w');
    await page.keyboard.up('s');
    expect(await commands()).toEqual(['W', 'S', 'X'].map(data => ({ type: 'serial', data })));
  });

  it('disables keyboard commands when paused and releases an active hold once', async () => {
    await page.keyboard.down('w');
    await page.evaluate(() => (window as unknown as HarnessWindow).setEnabled(false));
    await page.waitForFunction(() => [...document.querySelectorAll('.keyboard-controls button')].every(button => (button as HTMLButtonElement).disabled));
    expect(await commands()).toEqual(['W', 'X'].map(data => ({ type: 'serial', data })));
    await clearCommands();
    await page.keyboard.up('w');
    await page.keyboard.press('s');
    await page.keyboard.press('Space');
    expect(await commands()).toEqual([]);
    expect(await page.locator('[aria-pressed="true"]').count()).toBe(0);
  });
});
