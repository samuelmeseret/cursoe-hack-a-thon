import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import type { SimulationHostCommand, SimulationSnapshot } from '../shared/simulation-runtime';

type HostWindow = Window & { simulationHost: { command(command: SimulationHostCommand): Promise<SimulationSnapshot> } };
type HarnessWindow = Window & { replaceSource(source: string): void };
const thermalSource = `function createSimulation(){
  let temperature=20, power=0, heating=false;
  return {
    reset(){temperature=20;power=0;heating=false},
    input(id,value){if(id==='power')power=value; if(id==='heat')heating=value; if(id==='pulse'&&value)temperature+=10},
    step(dt){if(heating)temperature+=power*dt},
    snapshot(){return {temperature,heating}},
    draw(ctx,width,height){ctx.fillStyle='#fff3da';ctx.fillRect(0,0,width,height);ctx.fillStyle=heating?'#d74919':'#667b83';ctx.fillRect(80,80,Math.max(10,temperature*4),100);ctx.fillStyle='#222';ctx.font='28px sans-serif';ctx.fillText('Thermal chamber',80,50)}
  };
}`;

describe('Generated React preview with the actual sandbox Worker', () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let origin: string;
  beforeAll(async () => {
    const bundle = await build({
      stdin: { loader: 'tsx', resolveDir: process.cwd(), contents: `
        import { createRoot } from 'react-dom/client';
        import { SimulationPreview } from './src/SimulationPreview';
        const root=createRoot(document.getElementById('root'));
        const spec={goal:'Explore a thermal chamber',title:'Thermal chamber',summary:'A configurable heating experiment',assumptions:[],
          controls:[{id:'power',label:'Heating power',type:'range',initial:2,min:1,max:10,step:1},{id:'heat',label:'Apply heat',type:'key',key:'h',initial:false},{id:'pulse',label:'Add energy pulse',type:'button',initial:false}],
          observables:[{id:'temperature',label:'Temperature',type:'number',unit:'°C'},{id:'heating',label:'Heater active',type:'boolean'}],requirements:[{id:'behavior',text:'Heat raises temperature'}]};
        let generation=0;
        window.replaceSource=(source)=>{const id=String(++generation);root.render(<SimulationPreview key={id} run={{id,prompt:spec.goal,goal:spec.goal,status:'READY',createdAt:'',updatedAt:'',deadlineAt:'',messages:[],events:[],attempts:[],spec,candidate:{id,source,rationale:'Generated test model'}}}/>)};
        window.replaceSource(${JSON.stringify(thermalSource)});
      ` },
      bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', write: false,
    });
    const source = bundle.outputFiles[0].text;
    server = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/harness.js' ? 'text/javascript' : 'text/html');
      response.end(request.url === '/harness.js' ? source : '<!doctype html><style>iframe{width:720px;height:405px}.sim-live-values,.sim-control-grid{display:flex;gap:20px}</style><textarea aria-label="Simulation prompt"></textarea><div id="root"></div><script type="module" src="/harness.js"></script>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
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
    await page.goto(origin);
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Play' && !button.disabled));
  });
  afterEach(async () => { await page?.close(); });
  const frame = async (): Promise<Frame> => (await (await page.locator('iframe').elementHandle())!.contentFrame())!;
  const snapshot = async () => (await frame()).evaluate(() => (window as unknown as HostWindow).simulationHost.command({ type: 'snapshot' }));
  const waitInput = (id: string, value: boolean | number) => vi.waitFor(async () => {
    expect((await snapshot()).inputs?.[id]).toBe(value);
  }, { timeout: 5000, interval: 25 });

  it('updates controls, metrics, keyboard input after Play focus, and reset from real Worker messages', async () => {
    expect((await snapshot()).inputs?.power).toBe(2);
    expect((await snapshot()).state.temperature).toBe(20);
    await page.getByLabel('Heating power').fill('7');
    await waitInput('power', 7);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    // Play retains button focus. Configured shortcuts must still reach the model.
    await page.keyboard.down('h');
    await waitInput('heat', true);
    await vi.waitFor(async () => expect(Number((await snapshot()).state.temperature)).toBeGreaterThan(20), { timeout: 5000, interval: 25 });
    await page.keyboard.up('h');
    await waitInput('heat', false);
    await page.getByRole('button', { name: /Apply heat/, pressed: false }).waitFor();
    expect(await page.getByRole('button', { name: /Apply heat/ }).getAttribute('aria-pressed')).toBe('false');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    expect((await snapshot()).running).toBe(false);
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await page.waitForFunction(() => (document.getElementById('control-power') as HTMLInputElement)?.value === '2');
    const reset = await snapshot();
    expect(reset.timeMs).toBe(0);
    expect(reset.state.temperature).toBe(20);
    expect(reset.inputs?.power).toBe(2);
    expect(reset.inputs?.heat).toBe(false);
    expect(await page.locator('.sim-live-values').textContent()).toContain('Temperature20 °C');
  });

  it('uses shortcuts in the focused canvas while paused, and leaves prompt typing alone', async () => {
    await (await frame()).locator('canvas').click();
    await page.keyboard.down('h');
    await waitInput('heat', true);
    await page.getByRole('button', { name: /Apply heat/, pressed: true }).waitFor();
    expect(await page.getByRole('button', { name: /Apply heat/ }).getAttribute('aria-pressed')).toBe('true');
    await page.keyboard.up('h');
    await waitInput('heat', false);
    await page.getByRole('textbox', { name: 'Simulation prompt' }).focus();
    await page.keyboard.type('heat the chamber');
    expect((await snapshot()).inputs?.heat).toBe(false);
    expect(await page.getByRole('textbox', { name: 'Simulation prompt' }).inputValue()).toBe('heat the chamber');
  });

  it('delivers repeated button activations without leaving keyboard controls held', async () => {
    await page.getByRole('button', { name: 'Add energy pulse', exact: true }).click();
    await page.getByRole('button', { name: 'Add energy pulse', exact: true }).click();
    await vi.waitFor(async () => expect((await snapshot()).state.temperature).toBe(40), { timeout: 5000, interval: 25 });
    const heat = page.getByRole('button', { name: /Apply heat/ });
    // Native mouse input verifies the same pointer capture path as the product.
    await heat.hover();
    await page.mouse.down();
    await waitInput('heat', true);
    await page.mouse.up();
    await waitInput('heat', false);
    expect((await snapshot()).state.temperature).toBe(40);
  });

  it('surfaces actual Worker execution failures and disables playback', async () => {
    await page.evaluate(source => (window as unknown as HarnessWindow).replaceSource(source), thermalSource.replace("if(heating)temperature+=power*dt", "throw new Error('Thermal model failed during step')"));
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Play' && !button.disabled));
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').textContent()).toContain('Thermal model failed during step');
    expect(await page.getByRole('button', { name: /Play|Pause/, exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Reset', exact: true }).isDisabled()).toBe(true);
  });
});
