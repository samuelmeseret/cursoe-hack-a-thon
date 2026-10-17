import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { buildSimulationDocument, type SimulationHostCommand, type SimulationSnapshot } from '../shared/simulation-runtime';
import type {
  SimulationArtifact, SimulationCheckResult, SimulationScenario, SimulationScenarioResult,
  SimulationScalar, SimulationStep, SimulationVerification,
} from '../shared/simulation-types';

type AssertionStep = Extract<SimulationStep, { type: 'assert' }>;
type HostWindow = Window & { simulationHost: { ready: Promise<SimulationSnapshot>; command(command: SimulationHostCommand): Promise<SimulationSnapshot> } };

function checkAssertion(assertion: AssertionStep, state: SimulationSnapshot['state']): SimulationCheckResult {
  const actual = state[assertion.observable];
  const present = Object.prototype.hasOwnProperty.call(state, assertion.observable);
  let passed = false;
  if (present) {
    if (assertion.operator === 'eq') passed = actual === assertion.value;
    else if (assertion.operator === 'ne') passed = typeof actual === typeof assertion.value && actual !== assertion.value;
    else if (typeof actual === 'number' && typeof assertion.value === 'number' && Number.isFinite(actual)) {
      if (assertion.operator === 'gt') passed = actual > assertion.value;
      else if (assertion.operator === 'gte') passed = actual >= assertion.value;
      else if (assertion.operator === 'lt') passed = actual < assertion.value;
      else if (assertion.operator === 'lte') passed = actual <= assertion.value;
      else if (assertion.operator === 'approx') passed = Math.abs(actual - assertion.value) <= (assertion.tolerance ?? 0.001);
    }
  }
  const expectation = `${assertion.observable} ${assertion.operator} ${JSON.stringify(assertion.value)}${assertion.operator === 'approx' ? ` ± ${assertion.tolerance ?? 0.001}` : ''}`;
  return {
    id: assertion.id, requirementIds: assertion.requirementIds, passed,
    ...(present ? { actual: actual as SimulationScalar } : {}),
    message: present ? `${expectation}; observed ${JSON.stringify(actual)}` : `Missing observable: ${assertion.observable}`,
  };
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type BrowserExecutionOptions = { signal?: AbortSignal; timeoutMs?: number };

/** Shared process boundary and cleanup for both acceptance tests and runtime-only checks. */
async function withSimulationBrowser<T>(
  { signal, timeoutMs = 60000 }: BrowserExecutionOptions,
  action: (context: BrowserContext, checkpoint: () => void) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new Error('Simulation cancelled');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Simulation timeout');
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let stopReason: string | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const checkpoint = () => { if (stopReason) throw new Error(stopReason); };
  const interrupted = new Promise<never>((_, reject) => {
    const stop = (message: string) => { stopReason = message; reject(new Error(message)); void browser?.close().catch(() => {}); };
    deadline = setTimeout(() => stop(`Simulation exceeded wall-clock timeout (${timeoutMs} ms)`), timeoutMs);
    cancel = () => stop('Simulation cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
  });
  const work = async (): Promise<T> => {
    const packaged = chromium.executablePath();
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? (existsSync(packaged) ? packaged : existsSync(macChrome) ? macChrome : undefined);
    browser = await chromium.launch({ headless: true, executablePath, timeout: Math.min(timeoutMs, 30000), args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    if (stopReason) { await browser.close(); checkpoint(); }
    context = await browser.newContext({ viewport: { width: 960, height: 540 }, serviceWorkers: 'block' });
    context.setDefaultTimeout(Math.min(timeoutMs, 10000));
    // Defense in depth: CSP blocks the model's network APIs; the isolated browser
    // context also refuses every resource request, including attempted imports.
    await context.route('**/*', route => route.abort('blockedbyclient'));
    checkpoint();
    return action(context, checkpoint);
  };
  try { return await Promise.race([work(), interrupted]); }
  catch (error) { throw new Error(stopReason ?? errorText(error)); }
  finally {
    if (deadline) clearTimeout(deadline);
    signal?.removeEventListener('abort', cancel);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

async function loadSimulation(page: Page, html: string): Promise<{ frame: Frame; snapshot: SimulationSnapshot }> {
  await page.setContent('<!doctype html><iframe id="simulation" sandbox="allow-scripts" style="border:0;width:960px;height:540px"></iframe>');
  await page.locator('#simulation').evaluate((element, document) => { (element as HTMLIFrameElement).srcdoc = document; }, html);
  const handle = await page.locator('#simulation').elementHandle();
  const frame = await handle!.contentFrame();
  if (!frame) throw new Error('Simulation frame was unavailable');
  await frame.waitForFunction(() => Boolean((window as unknown as HostWindow).simulationHost));
  const snapshot = await frame.evaluate(() => (window as unknown as HostWindow).simulationHost.ready);
  return { frame, snapshot };
}

/**
 * Execute independent structured tests in the same opaque iframe and Worker used
 * by the preview. No generated source is evaluated in the server process.
 */
export async function verifySimulation(
  artifact: SimulationArtifact,
  scenarios: SimulationScenario[],
  options: BrowserExecutionOptions = {},
): Promise<SimulationVerification> {
  if (!scenarios.length || scenarios.some(scenario => !scenario.steps.some(step => step.type === 'assert'))) {
    return { passed: false, results: [], error: 'Every simulation scenario must contain assertions' };
  }
  const results: SimulationScenarioResult[] = [];
  try {
    return await withSimulationBrowser(options, async (context, checkpoint) => {
      const html = buildSimulationDocument(artifact);
      for (const scenario of scenarios) {
        checkpoint();
        const page = await context.newPage();
        const result: SimulationScenarioResult = { scenarioId: scenario.id, name: scenario.name, completed: false, checks: [] };
        try {
          const loaded = await loadSimulation(page, html);
          let snapshot = loaded.snapshot;
          for (const step of scenario.steps) {
            checkpoint();
            if (step.type === 'assert') result.checks.push(checkAssertion(step, snapshot.state));
            else {
              const command: SimulationHostCommand = step.type === 'input'
                ? { type: 'input', id: step.controlId, value: step.value }
                : step.type === 'advance' ? { type: 'advance', durationMs: step.durationMs } : { type: 'reset' };
              snapshot = await loaded.frame.evaluate(command => (window as unknown as HostWindow).simulationHost.command(command), command);
            }
          }
          result.completed = true;
        } catch (error) {
          result.error = errorText(error);
          for (const step of scenario.steps) {
            if (step.type === 'assert' && !result.checks.some(check => check.id === step.id)) {
              result.checks.push({ id: step.id, requirementIds: step.requirementIds, passed: false, message: `Not evaluated: ${result.error}` });
            }
          }
        } finally {
          results.push(result);
          await page.close().catch(() => {});
        }
      }
      const passed = results.length === scenarios.length && results.every(result => result.completed && result.checks.length > 0 && result.checks.every(check => check.passed));
      return { passed, results };
    });
  } catch (error) { return { passed: false, results: [...results], error: errorText(error) }; }
}

/**
 * Check only that a draft initializes, renders, advances, and resets in the real
 * sandbox. This is not behavioral verification and returns no assertion evidence.
 */
export async function smokeSimulation(
  artifact: SimulationArtifact,
  options: BrowserExecutionOptions = {},
): Promise<{ passed: boolean; error?: string }> {
  try {
    await withSimulationBrowser(options, async (context, checkpoint) => {
      const page = await context.newPage();
      try {
        const { frame } = await loadSimulation(page, buildSimulationDocument(artifact));
        checkpoint();
        await frame.evaluate(() => (window as unknown as HostWindow).simulationHost.command({ type: 'advance', durationMs: 1000 }));
        checkpoint();
        await frame.evaluate(() => (window as unknown as HostWindow).simulationHost.command({ type: 'reset' }));
      } finally { await page.close().catch(() => {}); }
    });
    return { passed: true };
  } catch (error) { return { passed: false, error: errorText(error) }; }
}
