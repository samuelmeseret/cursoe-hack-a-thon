import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SimulationCandidate, SimulationScenario, SimulationSpec, SimulationVerification } from '../shared/simulation-types.js';
import { simulationTerminal, type SimulationRun } from '../shared/simulation-run.js';
import { validateSimulationCandidate, validateSimulationSpec, validateSimulationSuite } from '../shared/simulation-validation.js';
import { SIMULATION_RUNTIME_VERSION } from '../shared/simulation-runtime.js';
import { SimulationAgents } from './simulation-agents.js';
import { smokeSimulation, verifySimulation } from './simulation-browser.js';
import { artifactDirectory } from './storage.js';
import { canonical, sha256 } from './evidence.js';
import { AgentError } from './agents.js';

export interface SimulationAgentService {
  readonly model?: string;
  validateModel(signal?: AbortSignal): Promise<void>;
  specify(goal: string, signal?: AbortSignal, previousSpec?: SimulationSpec): Promise<SimulationSpec>;
  verify(spec: SimulationSpec, signal?: AbortSignal): Promise<SimulationScenario[]>;
  build(spec: SimulationSpec, scenarios: SimulationScenario[], context: { attempt: number; previous?: SimulationCandidate; previousSpec?: SimulationSpec; failures?: unknown; draft?: boolean }, signal?: AbortSignal): Promise<SimulationCandidate>;
}
interface Dependencies { agents?: SimulationAgentService; verify?: typeof verifySimulation; smoke?: typeof smokeSimulation; deadlineMs?: number; directory?: string }
interface RefinementContext { specification?: SimulationSpec; candidate?: SimulationCandidate; candidateSpecification?: SimulationSpec }
const clone = <T>(value: T): T => structuredClone(value);
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

/** A draft fallback cannot conceal a crashed runtime or incomplete verification. */
function hasCompleteBehaviorFailures(scenarios: SimulationScenario[], result: SimulationVerification): boolean {
  if (!scenarios.length || result.error || result.results.length !== scenarios.length || !result.results.some(outcome => outcome.checks.some(check => check.passed === false))) return false;
  if (new Set(result.results.map(outcome => outcome.scenarioId)).size !== scenarios.length) return false;
  return scenarios.every(scenario => {
    const outcome = result.results.find(outcome => outcome.scenarioId === scenario.id);
    const assertions = scenario.steps.filter(step => step.type === 'assert');
    if (!outcome?.completed || outcome.error || outcome.checks.length !== assertions.length || new Set(outcome.checks.map(check => check.id)).size !== assertions.length) return false;
    return assertions.every(assertion => {
      const check = outcome.checks.find(check => check.id === assertion.id);
      return check && canonical(check.requirementIds) === canonical(assertion.requirementIds) && typeof check.actual === typeof assertion.value
        && (typeof check.actual !== 'number' || Number.isFinite(check.actual));
    });
  });
}

/** A browser model is ready only after all independently authored checks execute. */
export function simulationChecksPass(scenarios: SimulationScenario[], result: SimulationVerification): boolean {
  if (!scenarios.length || result.error || result.results.length !== scenarios.length) return false;
  if (new Set(result.results.map(entry => entry.scenarioId)).size !== scenarios.length) return false;
  return scenarios.every(scenario => {
    const outcome = result.results.find(entry => entry.scenarioId === scenario.id);
    const assertions = scenario.steps.filter(step => step.type === 'assert');
    if (!outcome?.completed || outcome.error || !assertions.length || outcome.checks.length !== assertions.length) return false;
    if (new Set(outcome.checks.map(check => check.id)).size !== assertions.length) return false;
    return assertions.every(assertion => {
      const check = outcome.checks.find(entry => entry.id === assertion.id);
      if (!check?.passed || canonical(check.requirementIds) !== canonical(assertion.requirementIds)) return false;
      const actual = check.actual;
      if (typeof actual !== typeof assertion.value || (typeof actual === 'number' && !Number.isFinite(actual))) return false;
      switch (assertion.operator) {
        case 'eq': return actual === assertion.value;
        case 'ne': return actual !== assertion.value;
        case 'gt': return (actual as number) > (assertion.value as number);
        case 'gte': return (actual as number) >= (assertion.value as number);
        case 'lt': return (actual as number) < (assertion.value as number);
        case 'lte': return (actual as number) <= (assertion.value as number);
        case 'approx': return Math.abs((actual as number) - (assertion.value as number)) <= assertion.tolerance!;
      }
    });
  });
}

export class SimulationController {
  readonly events = new EventEmitter();
  private readonly runs = new Map<string, SimulationRun>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly agents: SimulationAgentService;
  private readonly verify: typeof verifySimulation;
  private readonly smoke: typeof smokeSimulation;
  private readonly deadlineMs: number;
  private readonly directory: string;
  private starting = false;
  constructor(dependencies: Dependencies = {}) {
    this.agents = dependencies.agents ?? new SimulationAgents();
    this.verify = dependencies.verify ?? verifySimulation;
    this.smoke = dependencies.smoke ?? smokeSimulation;
    this.deadlineMs = dependencies.deadlineMs ?? 360000;
    this.directory = dependencies.directory ?? path.join(artifactDirectory, 'simulations');
  }
  private folder(id: string) { if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid simulation ID'); return path.join(this.directory, id); }
  private async saveFile(run: SimulationRun, name: string, value: unknown) {
    await mkdir(this.folder(run.id), { recursive: true });
    await writeFile(path.join(this.folder(run.id), name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  private persist(run: SimulationRun) {
    const snapshot = clone(run);
    const write = (this.writes.get(run.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await this.saveFile(snapshot, 'run.json.tmp', snapshot);
      await rename(path.join(this.folder(run.id), 'run.json.tmp'), path.join(this.folder(run.id), 'run.json'));
    });
    this.writes.set(run.id, write);
    void write.catch(() => {});
  }
  private event(run: SimulationRun, phase: string, message: string) {
    run.updatedAt = new Date().toISOString();
    const event = { sequence: run.events.length + 1, at: run.updatedAt, phase, message };
    run.events.push(event); this.persist(run); this.events.emit(run.id, clone(event));
  }
  private status(run: SimulationRun, status: SimulationRun['status'], message: string) {
    this.aborts.get(run.id)?.signal.throwIfAborted();
    run.status = status; this.event(run, status, message);
  }
  async start({ prompt, previousId }: { prompt: string; previousId?: string }): Promise<SimulationRun> {
    if (typeof prompt !== 'string' || prompt.trim().length < 5 || prompt.length > 5000) throw new Error('Describe your simulation in 5–5000 characters.');
    if (this.starting || [...this.runs.values()].some(run => !simulationTerminal(run.status))) throw new Error('A simulation is being built. Wait for it or cancel before starting another.');
    this.starting = true;
    try {
      const previous = previousId ? await this.get(previousId) : undefined;
      if (previousId && !previous) throw new Error('The simulation to update could not be found.');
      if (previous && !simulationTerminal(previous.status)) throw new Error('Wait for the previous build before requesting a change.');
      if (previous && await this.projectHead(previous) !== previous.id) throw new Error('This is an older project revision. Open the latest revision before requesting another change.');
      const goal = previous ? `${previous.goal}\n\nRequested change:\n${prompt.trim()}` : prompt.trim();
      if (goal.length > 24000) throw new Error('This conversation is too long. Start a new simulation with a summary of the desired behavior.');
      const refinement = previous ? await this.refinementContext(previous) : undefined;
      await this.agents.validateModel(AbortSignal.timeout(15000));
      const now = Date.now();
      const id = randomUUID();
      const run: SimulationRun = { id, projectId: previous?.projectId ?? previous?.id ?? id, revision: (previous?.revision ?? 0) + 1, parentId: previous?.id, prompt: prompt.trim(), goal, model: this.agents.model,
        status: 'QUEUED', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), deadlineAt: new Date(now + this.deadlineMs).toISOString(),
        messages: [...(previous?.messages ?? []), { role: 'user', content: prompt.trim() }], events: [], attempts: [] };
      await mkdir(this.folder(run.id), { recursive: true });
      await mkdir(path.join(this.directory, 'project-heads'), { recursive: true });
      await writeFile(path.join(this.directory, 'project-heads', `${run.projectId}.json`), JSON.stringify({ revisionId: run.id }));
      this.runs.set(run.id, run);
      const abort = new AbortController(); this.aborts.set(run.id, abort);
      this.event(run, 'QUEUED', 'Live Crusoe agents are generating a new simulation from your request.');
      const task = this.execute(run, abort, refinement).finally(() => this.aborts.delete(run.id));
      this.tasks.set(run.id, task);
      return clone(run);
    } finally { this.starting = false; }
  }
  async get(id: string): Promise<SimulationRun | undefined> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return undefined;
    let run = this.runs.get(id);
    if (!run) {
      try {
        const stored = JSON.parse(await readFile(path.join(this.folder(id), 'run.json'), 'utf8')) as SimulationRun;
        if (stored.id !== id || !Array.isArray(stored.events) || !Array.isArray(stored.attempts)) return undefined;
        run = stored; this.runs.set(id, run);
        if (!simulationTerminal(run.status)) {
          run.status = 'FAILED'; run.error = 'The server restarted during this build. Submit a follow-up to try again.';
          this.event(run, 'FAILED', run.error);
        }
      } catch { return undefined; }
    }
    if ((run.status === 'READY' || run.status === 'DRAFT') && !await this.integrity(run)) {
      run.status = 'STALE'; run.error = 'The saved simulation changed after its checks. Build it again to check the current version.';
      this.event(run, 'STALE', run.error);
    }
    return clone(run);
  }
  async wait(id: string) { await this.tasks.get(id); await this.writes.get(id); return this.get(id); }
  async projectHead(run: SimulationRun): Promise<string> {
    const projectId = run.projectId ?? run.id;
    if (!/^[a-zA-Z0-9-]+$/.test(projectId)) throw new Error('Invalid project ID');
    try { return JSON.parse(await readFile(path.join(this.directory, 'project-heads', `${projectId}.json`), 'utf8')).revisionId; }
    catch { return run.id; }
  }
  /** Repair the authoritative controller after a real toolchain failure, preserving the frozen contract. */
  async repairHardware(id: string, diagnostics: string): Promise<SimulationRun> {
    const snapshot = await this.get(id);
    if (!snapshot?.candidate?.controller || !snapshot.spec || !snapshot.scenarios || !['READY', 'DRAFT'].includes(snapshot.status)) throw new Error('The current portable simulation is not available for a hardware repair.');
    if (await this.projectHead(snapshot) !== id) throw new Error('A newer project revision superseded this hardware repair.');
    if (this.starting || [...this.runs.values()].some(run => !simulationTerminal(run.status))) throw new Error('A simulation is already being built.');
    const run = this.runs.get(id)!;
    const previous = clone(run.candidate!);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    const timer = setTimeout(() => abort.abort(new Error('Hardware controller repair timed out.')), this.deadlineMs);
    run.deadlineAt = new Date(Date.now() + this.deadlineMs).toISOString();
    run.evidence = undefined; run.draftEvidence = undefined;
    this.status(run, 'BUILDING', 'The selected hardware toolchain failed. Repairing the shared controller while preserving its requirements and checks.');
    try {
      const candidate = validateSimulationCandidate(await this.agents.build(clone(run.spec!), clone(run.scenarios!), { attempt: 1, previous, previousSpec: clone(run.spec!), failures: { error: `Real hardware compilation failed. Preserve the frozen behavior, input/output IDs, and visual environment. Repair the portable controller or declare a precise missing capability; never generate separate firmware.\n${diagnostics.slice(-12000)}` }, ...(run.scenarios!.length ? {} : { draft: true }) }, abort.signal));
      if (!candidate.controller) throw new Error(candidate.hardwareUnavailableReason ?? 'The repaired candidate lacks a portable controller.');
      candidate.id = `hardware-repair-${run.attempts.length + 1}`;
      run.candidate = candidate;
      const record: SimulationRun['attempts'][number] = { candidate: clone(candidate) }; run.attempts.push(record);
      await this.saveFile(run, 'simulation.js', candidate.source);
      await this.saveFile(run, `${candidate.id}.js`, candidate.source);
      this.status(run, 'CHECKING', 'Checking the repaired controller in the simulation before rebuilding its firmware.');
      const verification = run.scenarios!.length ? await this.verify({ spec: clone(run.spec!), candidate: clone(candidate) }, clone(run.scenarios!), { signal: abort.signal }) : { passed: false, results: [], error: 'No behavior scenarios available.' };
      record.verification = verification;
      if (simulationChecksPass(run.scenarios!, verification)) {
        run.evidence = { ...verification, passed: true, sourceHash: sha256(candidate.source), specHash: sha256(canonical(run.spec)), suiteHash: sha256(canonical(run.scenarios)), runtimeVersion: SIMULATION_RUNTIME_VERSION, checkedAt: new Date().toISOString() };
        await this.saveFile(run, 'verification.json', run.evidence);
        this.status(run, 'READY', 'Repaired controller passed the frozen simulation checks. Rebuilding selected hardware.');
      } else {
        const smoke = await this.smokeCandidate(run, abort.signal); record.smoke = smoke;
        if (!smoke.passed) throw new Error(smoke.error ?? 'Repaired controller could not run.');
        run.warning = 'The hardware repair changed the shared controller; behavior checks are incomplete or failing.';
        await this.finishDraft(run);
      }
      return clone(run);
    } catch (error) {
      run.status = 'FAILED'; run.error = error instanceof Error ? error.message : String(error);
      this.event(run, 'FAILED', run.error); throw error;
    } finally { clearTimeout(timer); this.aborts.delete(id); this.persist(run); await this.writes.get(id); }
  }
  async cancel(id: string) {
    const snapshot = await this.get(id);
    if (!snapshot) return undefined;
    const run = this.runs.get(id)!;
    if (!simulationTerminal(run.status)) {
      run.status = 'CANCELLED'; run.error = 'Build cancelled.';
      this.aborts.get(id)?.abort(new Error(run.error)); this.event(run, 'CANCELLED', run.error);
    }
    return clone(run);
  }
  private async refinementContext(previous: SimulationRun): Promise<RefinementContext> {
    const context: RefinementContext = {};
    const visited = new Set<string>();
    let ancestor: SimulationRun | undefined = previous;
    while (ancestor && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      // A failed update can still contain the latest requested model. Preserve
      // that specification even when its implementation never arrived.
      if (!context.specification && ancestor.spec) context.specification = clone(ancestor.spec);
      if (!context.candidate && ancestor.candidate && ancestor.spec) {
        context.candidate = clone(ancestor.candidate);
        context.candidateSpecification = clone(ancestor.spec);
      }
      if (context.specification && context.candidate) break;
      ancestor = ancestor.parentId ? await this.get(ancestor.parentId) : undefined;
    }
    return context;
  }
  private async integrity(run: SimulationRun, kind: 'verified' | 'draft' = run.status === 'DRAFT' ? 'draft' : 'verified') {
    const evidence = kind === 'draft' ? run.draftEvidence : run.evidence;
    if (!run.candidate || !run.spec || !run.scenarios || !evidence) return false;
    try {
      if (validateSimulationCandidate(run.candidate).source !== run.candidate.source) return false;
      const read = (name: string) => readFile(path.join(this.folder(run.id), name), 'utf8');
      const [source, spec, tests, report] = await Promise.all(['simulation.js', 'specification.json', 'scenarios.json', kind === 'draft' ? 'draft-evidence.json' : 'verification.json'].map(read));
      return evidence.runtimeVersion === SIMULATION_RUNTIME_VERSION && sha256(run.candidate.source) === evidence.sourceHash && sha256(canonical(run.spec)) === evidence.specHash
        && sha256(canonical(run.scenarios)) === evidence.suiteHash
        && sha256(source) === evidence.sourceHash && sha256(canonical(JSON.parse(spec))) === evidence.specHash
        && sha256(canonical(JSON.parse(tests))) === evidence.suiteHash && canonical(JSON.parse(report)) === canonical(evidence)
        && (kind === 'draft' || simulationChecksPass(run.scenarios, run.evidence!));
    } catch { return false; }
  }
  private async smokeCandidate(run: SimulationRun, signal: AbortSignal) {
    try {
      const result = await this.smoke({ spec: clone(run.spec!), candidate: clone(run.candidate!) }, { signal, timeoutMs: Math.min(60000, Math.max(1, Date.parse(run.deadlineAt) - Date.now())) });
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      return { passed: false, error: error instanceof Error ? error.message.slice(0, 3000) : 'The simulation could not run.' };
    }
  }
  private async finishDraft(run: SimulationRun) {
    run.evidence = undefined;
    run.draftEvidence = {
      sourceHash: sha256(run.candidate!.source), specHash: sha256(canonical(run.spec)), suiteHash: sha256(canonical(run.scenarios)),
      runtimeVersion: SIMULATION_RUNTIME_VERSION, checkedAt: new Date().toISOString(),
    };
    await this.saveFile(run, 'draft-evidence.json', run.draftEvidence);
    if (!await this.integrity(run, 'draft')) throw new Error('The draft artifacts did not match the simulation that ran.');
    this.aborts.get(run.id)?.signal.throwIfAborted();
    run.messages.push({ role: 'assistant', content: `Created a runnable draft. ${run.warning} ${run.spec!.summary}` });
    this.status(run, 'DRAFT', 'The simulation runs and renders. Its behavior has not been fully verified.');
  }
  private async execute(run: SimulationRun, abort: AbortController, refinement?: RefinementContext) {
    const signal = abort.signal;
    const timer = setTimeout(() => abort.abort(new Error('The six-minute build deadline was reached.')), this.deadlineMs);
    let previous = refinement?.candidate;
    let previousSpec = refinement?.candidateSpecification;
    let failures: unknown;
    let draftOnly = false;
    let lastVerification: SimulationVerification | undefined;
    try {
      this.status(run, 'PLANNING', 'Defining this simulation’s rules, interactions, and observable behavior.');
      const specified = refinement?.specification ? await this.agents.specify(run.goal, signal, clone(refinement.specification)) : await this.agents.specify(run.goal, signal);
      run.spec = freeze(validateSimulationSpec(specified, run.goal));
      signal.throwIfAborted();
      this.status(run, 'DESIGNING_TESTS', 'An independent verifier is designing behavior checks before any implementation is built.');
      try {
        run.scenarios = freeze(validateSimulationSuite(await this.agents.verify(clone(run.spec), signal), run.spec));
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && (error.name === 'AbortError' || ('code' in error && error.code === 'CANCELLED') || ('finishReason' in error && error.finishReason === 'content_filter'))) throw error;
        const diagnostic = error instanceof Error ? error.message.slice(0, 3000) : 'The verifier could not prepare behavior checks.';
        run.warning = `Behavior checks could not be prepared: ${diagnostic}`;
        run.scenarios = freeze([]);
        draftOnly = true;
        this.event(run, 'DESIGNING_TESTS', `${run.warning} Building an unverified draft from the specification.`);
      }
      signal.throwIfAborted();
      await this.saveFile(run, 'specification.json', run.spec);
      await this.saveFile(run, 'scenarios.json', run.scenarios);
      const frozenHash = sha256(canonical({ spec: run.spec, scenarios: run.scenarios }));
      for (let attempt = 1; attempt <= 3; attempt++) {
        this.status(run, 'BUILDING', attempt === 1 ? 'Writing the simulation model and its interactive scene.' : `Repairing the observed failures (attempt ${attempt} of 3).`);
        const candidate = validateSimulationCandidate(await this.agents.build(clone(run.spec), clone(run.scenarios), {
          attempt, previous: previous ? clone(previous) : undefined, failures,
          ...(previousSpec ? { previousSpec: clone(previousSpec) } : {}),
          ...(draftOnly ? { draft: true } : {}),
        }, signal));
        signal.throwIfAborted();
        candidate.id = `candidate-${attempt}`; run.candidate = candidate; run.evidence = undefined; run.draftEvidence = undefined;
        const record = { candidate: clone(candidate) } as SimulationRun['attempts'][number]; run.attempts.push(record);
        previous = candidate;
        previousSpec = run.spec;
        await this.saveFile(run, 'simulation.js', candidate.source);
        await this.saveFile(run, `candidate-${attempt}.js`, candidate.source);
        this.status(run, 'CHECKING', draftOnly ? `Checking that draft ${attempt} initializes, advances, and renders in an isolated browser.` : `Running candidate ${attempt} in an isolated browser and exercising ${run.scenarios.length} scenarios.`);
        if (draftOnly) {
          const smoke = await this.smokeCandidate(run, signal);
          record.smoke = smoke;
          if (smoke.passed) { await this.finishDraft(run); return; }
          record.error = smoke.error ?? 'The draft could not run.';
          failures = smoke;
          this.event(run, 'CHECKING', `${record.error} Sending the runtime failure back to the builder.`);
          continue;
        }
        let verification: SimulationVerification;
        try {
          verification = await this.verify({ spec: clone(run.spec), candidate: clone(candidate) }, clone(run.scenarios), { signal, timeoutMs: Math.min(60000, Math.max(1, Date.parse(run.deadlineAt) - Date.now())) });
        } catch (error) {
          signal.throwIfAborted();
          record.error = error instanceof Error ? error.message.slice(0, 3000) : 'The simulation could not run.';
          verification = { passed: false, results: [], error: record.error };
        }
        signal.throwIfAborted();
        record.verification = verification;
        lastVerification = verification;
        if (sha256(canonical({ spec: run.spec, scenarios: run.scenarios })) !== frozenHash) throw new Error('The frozen specification or scenarios changed during the build.');
        if (simulationChecksPass(run.scenarios, verification)) {
          run.evidence = { ...verification, passed: true, sourceHash: sha256(candidate.source), specHash: sha256(canonical(run.spec)), suiteHash: sha256(canonical(run.scenarios)), runtimeVersion: SIMULATION_RUNTIME_VERSION, checkedAt: new Date().toISOString() };
          await this.saveFile(run, 'verification.json', run.evidence);
          if (!await this.integrity(run)) throw new Error('The generated artifacts did not match the checked simulation.');
          signal.throwIfAborted();
          run.messages.push({ role: 'assistant', content: run.spec.summary });
          this.status(run, 'READY', `Ready to explore. ${verification.results.reduce((count, result) => count + result.checks.length, 0)} browser behavior checks passed.`);
          return;
        }
        failures = verification;
        this.event(run, 'CHECKING', verification.error ?? `${verification.results.flatMap(result => result.checks).filter(check => !check.passed).length} behavior checks failed. Sending the observations back to the builder.`);
      }
      if (!draftOnly && lastVerification && hasCompleteBehaviorFailures(run.scenarios, lastVerification)) {
        const smoke = await this.smokeCandidate(run, signal);
        run.attempts.at(-1)!.smoke = smoke;
        if (smoke.passed) {
          const failed = lastVerification.results.flatMap(result => result.checks).filter(check => !check.passed).length;
          run.warning = `${failed} behavior checks still fail after three builds. This runnable draft has not been fully verified.`;
          await this.finishDraft(run);
          return;
        }
        run.attempts.at(-1)!.error = smoke.error ?? 'The simulation could not run.';
        throw new Error(run.attempts.at(-1)!.error);
      }
      if (draftOnly) throw new Error('The generated draft could not run after three builds. Describe a change to continue working on it.');
      throw new Error('The generated simulation still has failing checks after three builds. Describe a change to continue working on it.');
    } catch (error) {
      if (run.status !== 'CANCELLED') {
        run.status = 'FAILED';
        if (error instanceof AgentError) { run.errorCode = error.code; run.errorFinishReason = error.finishReason; }
        run.error = signal.aborted ? String(signal.reason?.message ?? 'Build interrupted.') : error instanceof Error ? error.message.slice(0, 3000) : 'Simulation build failed.';
        this.event(run, 'FAILED', run.error);
      }
    } finally { clearTimeout(timer); this.persist(run); await this.writes.get(run.id)?.catch(() => {}); }
  }
}
