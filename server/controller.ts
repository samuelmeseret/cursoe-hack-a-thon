import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentName, Candidate, Evidence, RunEvent, RunSpec, RunState, Scenario, StartRunRequest } from '../shared/types.js';
import { generateCircuit } from '../shared/circuit.js';
import { validateCandidate, validateSpec, validateSuite } from '../shared/validation.js';
import { SIMULATOR_VERSION } from '../shared/simulator.js';
import { airlockSpec, airlockScenarios, badAirlockCandidate, goodAirlockCandidate, buzzerSpec, buzzerScenarios, goodBuzzerCandidate } from '../shared/fixtures.js';
import { CrusoeAgents } from './agents.js';
import { compileCandidate } from './compiler.js';
import { runSimulation } from './simulation.js';
import { artifactHashes, canonical, createEvidence, evidencePasses, hasObservedOverlap, sha256 } from './evidence.js';
import { artifactsStillMatch, json, runDirectory, saveCurrentArtifacts, saveState } from './storage.js';
import { circuitSvg } from './diagram.js';

const TERMINAL = new Set(['VERIFIED', 'FAILED', 'CANCELLED', 'STALE']);
const MAX_CANDIDATES = 4;
const DEADLINE_MS = 180_000;
export interface AgentService {
  readonly model?: string;
  validateModel(signal?: AbortSignal): Promise<void>;
  specify(goal: string, signal?: AbortSignal): Promise<RunSpec>;
  verify(goal: string, spec: RunSpec, signal?: AbortSignal, baseline?: Scenario[]): Promise<Scenario[]>;
  build(spec: RunSpec, scenarios: Scenario[], context: { attempt: number; previous?: Candidate; failures?: unknown; replan?: string }, signal?: AbortSignal): Promise<Candidate>;
  replan(spec: RunSpec, scenarios: Scenario[], previous: Candidate, failures: unknown, signal?: AbortSignal): Promise<string>;
}
interface Dependencies { agents?: AgentService; compile?: typeof compileCandidate; simulate?: typeof runSimulation; deadlineMs?: number }
const clone = <T>(value: T): T => structuredClone(value);
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
};

/** Local process controller. The only assignment of VERIFIED lives after the completion gate. */
export class RunController {
  readonly events = new EventEmitter();
  private runs = new Map<string, RunState>();
  private aborts = new Map<string, AbortController>();
  private tasks = new Map<string, Promise<void>>();
  private writes = new Map<string, Promise<void>>();
  private agents: AgentService;
  private compile: typeof compileCandidate;
  private simulate: typeof runSimulation;
  private deadlineMs: number;
  private starting = false;
  constructor(dependencies: Dependencies = {}) {
    this.agents = dependencies.agents ?? new CrusoeAgents();
    this.compile = dependencies.compile ?? compileCandidate;
    this.simulate = dependencies.simulate ?? runSimulation;
    this.deadlineMs = dependencies.deadlineMs ?? DEADLINE_MS;
  }
  async start(request: StartRunRequest): Promise<RunState> {
    if (this.starting || [...this.runs.values()].some(r => !TERMINAL.has(r.status))) throw new Error('A run is already active. Cancel it or wait for completion.');
    this.starting = true;
    try {
    const inference = request.inference ?? 'crusoe';
    if (inference === 'crusoe') await this.agents.validateModel(AbortSignal.timeout(15_000));
    if (inference === 'fixture' && request.mode !== 'airlock-repair' && !/buzz|two.player/i.test(request.goal)) throw new Error('Offline rehearsal supports only the labeled airlock repair or two-player buzzer fixtures. Choose Crusoe for generation.');
    const now = Date.now();
    const run: RunState = { id: randomUUID(), goal: request.goal, mode: request.mode, inference, model: inference === 'crusoe' ? this.agents.model : undefined, status: 'QUEUED', createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + this.deadlineMs).toISOString(), attempts: [], replanCount: 0, events: [] };
    const abort = new AbortController();
    await mkdir(runDirectory(run.id), { recursive: true });
    this.runs.set(run.id, run);
    this.aborts.set(run.id, abort);
    this.event(run, 'controller', 'activity', inference === 'fixture' ? 'OFFLINE REHEARSAL — deterministic fixtures; no agent inference is being claimed.' : 'Crusoe model catalog validated. Starting the three-agent run.');
    const task = this.execute(run, abort).finally(() => { this.aborts.delete(run.id); });
    this.tasks.set(run.id, task);
    return clone(run);
    } finally { this.starting = false; }
  }
  async wait(id: string) { await this.tasks.get(id); await this.writes.get(id); return this.get(id); }
  async get(id: string): Promise<RunState | undefined> {
    const run = this.runs.get(id);
    if (run?.status === 'VERIFIED' && !await artifactsStillMatch(run)) {
      run.status = 'STALE'; run.error = 'Artifact integrity changed. Run verification again to restore a verified result.';
      this.event(run, 'controller', 'terminal', run.error);
    }
    return run ? clone(run) : undefined;
  }
  async cancel(id: string) {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (!TERMINAL.has(run.status)) {
      run.status = 'CANCELLED'; run.error = 'Cancelled by user';
      this.aborts.get(id)?.abort(new Error(run.error));
      this.event(run, 'controller', 'terminal', run.error);
    }
    return clone(run);
  }
  private persist(run: RunState) {
    const snapshot = clone(run);
    const write = (this.writes.get(run.id) ?? Promise.resolve()).catch(() => {}).then(() => saveState(snapshot));
    this.writes.set(run.id, write);
    // The terminal path awaits this promise and fails closed on write failure.
    void write.catch(() => {});
  }
  private event(run: RunState, agent: AgentName, kind: RunEvent['kind'], message: string, details?: unknown) {
    const event: RunEvent = { sequence: run.events.length + 1, at: new Date().toISOString(), agent, kind, message, attempt: run.attempts.length || undefined, details };
    run.events.push(event); this.persist(run); this.events.emit(run.id, clone(event));
  }
  private status(run: RunState, status: RunState['status'], agent: AgentName, message: string) {
    // Cancellation can arrive during any preceding file write or agent request.
    // Never overwrite its terminal state with a later phase transition.
    this.aborts.get(run.id)?.signal.throwIfAborted();
    run.status = status;
    this.event(run, agent, 'activity', message);
  }
  private async execute(run: RunState, abort: AbortController) {
    const timer = setTimeout(() => abort.abort(new Error('Three-minute run deadline exceeded')), this.deadlineMs);
    const signal = abort.signal;
    let previous: Candidate | undefined;
    let diagnostics: unknown;
    let replan: string | undefined;
    let lastFailureSet: string | undefined;
    const fingerprints = new Set<string>();
    try {
      this.status(run, 'SPECIFYING', run.inference === 'fixture' ? 'controller' : 'specifier', run.mode === 'airlock-repair' ? 'Loading the published airlock challenge contract.' : 'Making the goal explicit: assumptions, components, and numbered requirements.');
      const isBuzzer = run.inference === 'fixture' && run.mode !== 'airlock-repair';
      const generatedSpec = run.inference === 'crusoe' ? await this.agents.specify(run.goal, signal) : undefined;
      signal.throwIfAborted();
      const spec = run.mode === 'airlock-repair' ? { ...clone(airlockSpec), assumptions: [...airlockSpec.assumptions, ...(generatedSpec?.assumptions ?? [])].slice(0, 30) } : run.inference === 'fixture' ? clone(buzzerSpec) : generatedSpec!;
      spec.goal = run.goal;
      run.spec = freeze(validateSpec(spec));
      signal.throwIfAborted();
      this.status(run, 'VERIFYING_SPEC', run.inference === 'fixture' ? 'controller' : 'verifier', run.mode === 'airlock-repair' ? 'Loading the published, immutable airlock acceptance suite before any candidate build.' : 'Creating executable checks without access to Builder code.');
      // The challenge adds a stable published contract; real runs still use independent Verifier scenarios.
      const scenarios = run.inference === 'fixture' ? clone(isBuzzer ? buzzerScenarios : airlockScenarios) : await this.agents.verify(run.goal, run.spec, signal, run.mode === 'airlock-repair' ? clone(airlockScenarios) : undefined);
      signal.throwIfAborted();
      const combined = run.mode === 'airlock-repair' && run.inference === 'crusoe'
        ? [...clone(airlockScenarios), ...scenarios.map((s, i) => ({ ...s, id: `verifier-${i + 1}`, assertions: s.assertions.map((a, j) => ({ ...a, id: `verifier-${i + 1}-${j + 1}` })) }))] : scenarios;
      run.scenarios = freeze(validateSuite(combined, run.spec));
      this.event(run, 'controller', 'frozen', `Frozen ${run.spec.requirements.length} requirements, ${run.spec.components.length} component meanings, and ${run.scenarios.reduce((n, s) => n + s.assertions.length, 0)} checks.`, { requirements: run.spec.requirements, scenarioIds: run.scenarios.map(s => s.id) });
      await writeFile(path.join(runDirectory(run.id), 'requirements.json'), json(run.spec));
      await writeFile(path.join(runDirectory(run.id), 'tests.json'), json(run.scenarios));
      signal.throwIfAborted();
      const immutableHash = sha256(canonical({ spec: run.spec, scenarios: run.scenarios }));
      for (let attempt = 1; attempt <= MAX_CANDIDATES; attempt++) {
        signal.throwIfAborted();
        this.status(run, 'BUILDING', run.inference === 'fixture' || (run.mode === 'airlock-repair' && attempt === 1) ? 'controller' : 'builder', run.mode === 'airlock-repair' && attempt === 1 ? 'Repair challenge: loading the explicitly known-bad sketch.' : run.inference === 'fixture' ? 'Loading the documented reference repair fixture.' : `Builder preparing candidate ${attempt} of ${MAX_CANDIDATES}.`);
        let candidate: Candidate;
        if (run.mode === 'airlock-repair' && attempt === 1) candidate = clone(badAirlockCandidate);
        else if (run.inference === 'fixture') candidate = clone(isBuzzer ? goodBuzzerCandidate : goodAirlockCandidate);
        else candidate = await this.agents.build(clone(run.spec), clone(run.scenarios), { attempt, previous, failures: diagnostics, replan }, signal);
        signal.throwIfAborted();
        candidate.id = `candidate-${attempt}`;
        run.candidate = clone(candidate); run.evidence = undefined; run.hex = undefined; run.circuit = undefined;
        for (const file of ['firmware.hex', 'verification.json', 'circuit.json', 'circuit.svg']) await rm(path.join(runDirectory(run.id), file), { force: true });
        await writeFile(path.join(runDirectory(run.id), 'sketch.ino'), candidate.source);
        signal.throwIfAborted();
        const record = { attempt, candidate: clone(candidate) } as RunState['attempts'][number];
        run.attempts.push(record);
        this.event(run, run.inference === 'fixture' || (run.mode === 'airlock-repair' && attempt === 1) ? 'controller' : 'builder', 'attempt', `${run.inference === 'fixture' ? 'Fixture' : 'Candidate'} ${attempt} submitted.`, { candidateId: candidate.id });
        const fingerprint = sha256(canonical({ source: candidate.source, pins: [...candidate.pins].sort((a, b) => a.componentId.localeCompare(b.componentId)) }));
        let stalled = fingerprints.has(fingerprint);
        fingerprints.add(fingerprint);
        previous = clone(candidate);
        try {
          validateCandidate(run.spec, candidate);
          const circuit = generateCircuit(run.spec, candidate.pins);
          run.circuit = circuit; record.circuit = circuit;
          await writeFile(path.join(runDirectory(run.id), 'circuit.json'), json(circuit));
          await writeFile(path.join(runDirectory(run.id), 'circuit.svg'), circuitSvg(circuit));
          if (stalled) throw new Error('Repeated candidate: firmware and pin assignments match a previous attempt.');
          this.status(run, 'COMPILING', 'controller', `Compiling candidate ${attempt} for arduino:avr:uno.`);
          const directory = path.join(runDirectory(run.id), `attempt-${attempt}`);
          await mkdir(directory, { recursive: true });
          const compiled = await this.compile(candidate, directory, { signal, timeoutMs: Math.min(45_000, this.remaining(run)) });
          signal.throwIfAborted();
          run.hex = compiled.hex; record.hex = compiled.hex;
          await writeFile(path.join(runDirectory(run.id), 'firmware.hex'), compiled.hex);
          this.status(run, 'SIMULATING', 'simulator', `Executing ${run.scenarios.length} frozen scenarios in fresh 16 MHz Uno machines.`);
          const results = await this.simulate(compiled.hex, circuit, run.scenarios, { signal, timeoutMs: this.remaining(run) });
          signal.throwIfAborted();
          const hashes = artifactHashes(candidate, circuit, compiled.hex, run.spec, run.scenarios);
          const evidence = createEvidence(run.id, candidate, hashes, run.scenarios, results, SIMULATOR_VERSION);
          run.evidence = evidence; record.evidence = evidence;
          await saveCurrentArtifacts(run, circuitSvg(circuit));
          signal.throwIfAborted();
          await writeFile(path.join(directory, 'verification.json'), json(evidence));
          signal.throwIfAborted();
          if (sha256(canonical({ spec: run.spec, scenarios: run.scenarios })) !== immutableHash) throw new Error('Frozen specification or tests changed during the run.');
          const passed = evidencePasses(evidence, hashes, run.scenarios, candidate.id);
          if (run.mode === 'airlock-repair' && attempt === 1) {
            if (passed) throw new Error('The known-bad challenge unexpectedly passed. Refusing a fabricated repair.');
            const outputs = run.spec.components.filter(c => c.kind === 'led').map(c => c.id);
            if (results.length !== run.scenarios.length || results.some(r => !r.completed || r.error) || !results.some(r => hasObservedOverlap(r.trace, outputs))) {
              throw new Error('Challenge seed did not produce a complete, observed door-conflict failure. Stopping before repair.');
            }
            run.failureEvidence = clone(evidence);
            this.event(run, 'simulator', 'failure', 'Known-bad sketch actually failed the frozen suite. Recording signal conflicts before requesting repair.', this.failures(evidence));
          } else if (passed) {
            if (!await artifactsStillMatch(run)) throw new Error('Stored artifacts failed the integrity check.');
            signal.throwIfAborted();
            run.status = 'VERIFIED';
            this.event(run, 'controller', 'terminal', `Verified in simulation: all ${evidence.expectedCheckIds.length} listed checks passed against the current artifacts.`, { hashes, simulatorVersion: evidence.simulatorVersion });
            await this.writes.get(run.id);
            return;
          }
          diagnostics = this.failures(evidence);
          const failureSet = canonical(results.flatMap(r => r.checks.filter(c => !c.passed).map(c => `${r.scenarioId}/${c.id}`)).sort());
          stalled ||= lastFailureSet === failureSet;
          lastFailureSet = failureSet;
          if (!(run.mode === 'airlock-repair' && attempt === 1)) this.event(run, 'simulator', 'failure', 'Candidate failed acceptance checks.', diagnostics);
        } catch (error) {
          signal.throwIfAborted();
          record.error = error instanceof Error ? error.message : String(error);
          if (run.mode === 'airlock-repair' && attempt === 1) throw new Error(`Known-bad challenge could not be demonstrated: ${record.error}`);
          const priorFailures = diagnostics;
          diagnostics = { error: record.error, ...(stalled && priorFailures ? { previousFailures: priorFailures } : {}) };
          const failureSet = canonical({ error: record.error });
          stalled ||= lastFailureSet === failureSet;
          lastFailureSet = failureSet;
          this.event(run, 'controller', 'failure', record.error);
        }
        if (attempt === MAX_CANDIDATES) throw new Error('Four-candidate build budget exhausted. No verified result.');
        if (stalled) {
          if (run.replanCount >= 1) throw new Error('Implementation stalled again after the one permitted replan.');
          run.replanCount++;
          this.status(run, 'REPLANNING', 'controller', 'Repeated candidate or identical failures: requesting one implementation replan. Frozen requirements and tests remain authoritative.');
          replan = run.inference === 'fixture' ? 'Reference implementation fixture; frozen suite unchanged.' : await this.agents.replan(clone(run.spec), clone(run.scenarios), previous!, diagnostics, signal);
          signal.throwIfAborted();
          this.event(run, run.inference === 'fixture' ? 'controller' : 'builder', 'replan', replan);
          lastFailureSet = undefined;
        }
      }
    } catch (error) {
      if (run.status !== 'CANCELLED') {
        run.status = 'FAILED';
        run.error = signal.aborted ? String(signal.reason?.message ?? 'Run aborted') : error instanceof Error ? error.message : String(error);
        this.event(run, 'controller', 'terminal', run.error);
      }
    } finally {
      clearTimeout(timer);
      this.persist(run);
      await this.writes.get(run.id)?.catch(() => {});
    }
  }
  private remaining(run: RunState) { return Math.max(1, new Date(run.deadlineAt).getTime() - Date.now()); }
  private failures(evidence: Evidence) {
    return evidence.results.filter(result => !result.completed || result.checks.some(check => !check.passed)).map(result => ({
      scenario: result.scenarioId, completed: result.completed, error: result.error,
      failedChecks: result.checks.filter(check => !check.passed).map(check => ({ check: check.id, requirements: check.requirementIds, message: check.message })),
      // One trace per scenario keeps concrete observed times readable in the Builder context.
      trace: result.trace.length <= 120 ? result.trace : [...result.trace.slice(0, 80), ...result.trace.slice(-40)],
      omittedTracePoints: Math.max(0, result.trace.length - 120),
    }));
  }
}
