import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { SimulationController } from './simulation-controller.js';
import { simulationChecksPass } from './simulation-controller.js';
import type { SimulationRun } from '../shared/simulation-run.js';
import type { HardwareConfiguration, HardwareProjectState } from '../shared/hardware-project.js';
import { canonical, sha256 } from './evidence.js';
import { artifactDirectory } from './storage.js';
import { configurationIssues, generateProjectFiles, HARDWARE_GENERATOR_VERSION } from './hardware-generation.js';
import { buildHardwareProject, connectedHardware, getDeviceProfile, installHardwarePackage, uploadHardwareProject } from './hardware-adapters.js';
import { checkControllerParity } from './controller-parity.js';
import { verifySimulation } from './simulation-browser.js';
import { validateSimulationCandidate } from '../shared/simulation-validation.js';

type StoredState = HardwareProjectState & { artifactFolder?: string };
interface Dependencies {
  directory?: string;
  profile?: typeof getDeviceProfile;
  compile?: typeof buildHardwareProject;
  parity?: typeof checkControllerParity;
  verify?: typeof verifySimulation;
}
export class HardwareProjectService {
  private readonly states = new Map<string, StoredState>();
  private readonly loads = new Map<string, Promise<StoredState>>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly operations = new Set<string>();
  private readonly directory: string;
  private readonly profile: typeof getDeviceProfile;
  private readonly compile: typeof buildHardwareProject;
  private readonly parity: typeof checkControllerParity;
  private readonly verify: typeof verifySimulation;
  constructor(private readonly simulations: SimulationController, dependencies: Dependencies = {}) {
    this.directory = dependencies.directory ?? path.join(artifactDirectory, 'hardware-projects');
    this.profile = dependencies.profile ?? getDeviceProfile;
    this.compile = dependencies.compile ?? buildHardwareProject;
    this.parity = dependencies.parity ?? checkControllerParity;
    this.verify = dependencies.verify ?? verifySimulation;
  }
  private folder(id: string) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('Invalid project ID.');
    return path.join(this.directory, id);
  }
  private publicState(state: StoredState): HardwareProjectState {
    const { artifactFolder: _folder, ...result } = state;
    return structuredClone(result);
  }
  private lock(projectId: string) {
    if (this.operations.has(projectId)) throw new Error('A hardware operation is already running for this project. Wait before changing configuration, rebuilding, or uploading.');
    this.operations.add(projectId);
    return () => this.operations.delete(projectId);
  }
  private async save(state: StoredState) {
    state.updatedAt = new Date().toISOString();
    this.states.set(state.projectId, state);
    await mkdir(this.folder(state.projectId), { recursive: true });
    const temporary = path.join(this.folder(state.projectId), `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, path.join(this.folder(state.projectId), 'state.json'));
  }
  private async revision(id: string): Promise<SimulationRun> {
    const run = await this.simulations.get(id);
    if (!run) throw new Error('Simulation not found.');
    if (this.simulations.projectHead && await this.simulations.projectHead(run) !== id) throw new Error('This is an older project revision. Open the latest simulation before configuring, building, exporting, or uploading hardware.');
    return run;
  }
  private fingerprint(run: SimulationRun, state: StoredState) {
    return sha256(canonical({ revision: run.id, candidate: run.candidate, spec: run.spec, scenarios: run.scenarios, configuration: state.configuration, profile: state.profile, generator: HARDWARE_GENERATOR_VERSION }));
  }
  private async stateFor(run: SimulationRun): Promise<StoredState> {
    const projectId = run.projectId ?? run.id;
    let state = this.states.get(projectId);
    if (!state) {
      let loading = this.loads.get(projectId);
      if (!loading) {
        loading = (async (): Promise<StoredState> => {
          let loaded: StoredState;
          try {
            loaded = JSON.parse(await readFile(path.join(this.folder(projectId), 'state.json'), 'utf8')) as StoredState;
            if (loaded.projectId !== projectId) throw new Error('Invalid stored state');
            if (loaded.status === 'BUILDING') { loaded.status = 'FAILED'; loaded.error = 'The server restarted during hardware compilation. Build again.'; loaded.evidence = undefined; }
          } catch { loaded = { projectId, revisionId: run.id, status: 'UNCONFIGURED', issues: [], updatedAt: new Date().toISOString() }; }
          if (!this.states.has(projectId)) this.states.set(projectId, loaded);
          return this.states.get(projectId)!;
        })();
        this.loads.set(projectId, loading);
      }
      try { await loading; state = this.states.get(projectId)!; }
      finally { this.loads.delete(projectId); }
    }
    if (this.simulations.projectHead && await this.simulations.projectHead(run) !== run.id) throw new Error('A newer project revision replaced this request. Open the current simulation.');
    if (state.revisionId !== run.id) {
      state = { projectId, revisionId: run.id, configuration: state.configuration, profile: state.profile, status: state.configuration ? 'STALE' : 'UNCONFIGURED', issues: ['The project changed. Review hardware bindings and rebuild this revision.'], updatedAt: new Date().toISOString() };
      await this.save(state);
    }
    if (state.evidence && (state.evidence.fingerprint !== this.fingerprint(run, state) || run.status === 'STALE')) {
      state.status = 'STALE'; state.evidence = undefined; state.upload = undefined; state.error = 'Controller, simulation, requirements, or hardware configuration changed. Build again.';
      await this.save(state);
    }
    return state;
  }
  async get(id: string): Promise<HardwareProjectState> {
    const run = await this.revision(id);
    const state = await this.stateFor(run);
    if (state.evidence && !await this.artifactsMatch(state)) {
      state.status = 'STALE'; state.evidence = undefined; state.upload = undefined; state.error = 'Exported files changed after verification. Build again.'; await this.save(state);
    }
    return this.publicState(state);
  }
  async configure(id: string, configuration: HardwareConfiguration): Promise<HardwareProjectState> {
    const run = await this.revision(id);
    const unlock = this.lock(run.projectId ?? run.id);
    try {
    if (!run.candidate?.controller) throw new Error('This browser-only simulation has no shared controller. Ask for a follow-up that creates a portable controller before selecting hardware.');
    if (!['READY', 'DRAFT'].includes(run.status)) throw new Error('Finish the simulation revision before configuring hardware.');
    validateSimulationCandidate(run.candidate);
    const previous = await this.stateFor(run);
    if (this.tasks.has(previous.projectId)) throw new Error('Wait for the hardware build to finish before changing its configuration.');
    const profile = await this.profile(configuration.fqbn, { install: true });
    const state: StoredState = { projectId: previous.projectId, revisionId: run.id, configuration: structuredClone(configuration), profile, status: 'CONFIGURED', issues: configurationIssues(run.candidate.controller, configuration, profile), updatedAt: new Date().toISOString() };
    await this.revision(id); // A new chat revision may have arrived during package installation.
    await this.save(state);
    return this.publicState(state);
    } finally { unlock(); }
  }
  async build(id: string): Promise<HardwareProjectState> {
    const run = await this.revision(id);
    const unlock = this.lock(run.projectId ?? run.id);
    let started = false;
    try {
    if (!run.candidate?.controller || !run.spec || !['READY', 'DRAFT'].includes(run.status)) throw new Error('A runnable simulation with a portable controller is required before building hardware.');
    validateSimulationCandidate(run.candidate);
    const state = await this.stateFor(run);
    if (this.tasks.has(state.projectId)) throw new Error('A hardware build is already running for this project.');
    if (!state.configuration || !state.profile) throw new Error('Select your board and save its pin configuration first.');
    state.issues = configurationIssues(run.candidate.controller, state.configuration, state.profile);
    if (state.issues.length) { await this.save(state); throw new Error(state.issues.join('\n')); }
    state.status = 'BUILDING'; state.error = undefined; state.evidence = undefined; state.upload = undefined; state.log = 'Generating shared controller, firmware, and documentation.\n';
    await this.save(state);
    const task = this.execute(run, structuredClone(state)).finally(() => { this.tasks.delete(state.projectId); unlock(); });
    this.tasks.set(state.projectId, task);
    started = true;
    return this.publicState(state);
    } finally { if (!started) unlock(); }
  }
  async wait(id: string) { const run = await this.revision(id); await this.tasks.get(run.projectId ?? run.id); return this.get(id); }
  private async execute(run: SimulationRun, state: StoredState, repairAttempt = 0) {
    const directory = path.join(this.folder(state.projectId), 'builds', randomUUID());
    state.artifactFolder = directory;
    const configuration = state.configuration!;
    let generated = false;
    const append = async (message: string) => { state.log = `${state.log ?? ''}${message}\n`.slice(-100000); await this.saveIfCurrent(run, state); };
    try {
      const files = generateProjectFiles(run, configuration, state.profile!);
      for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await writeFile(path.join(directory, name), content); }
      generated = true;
      await append('Source generated. Checking the JavaScript controller against compiled native C++.');
      const parity = await this.parity(run.candidate!.controller!, run.spec!, run.scenarios ?? [], path.join(directory, 'checks'));
      await append(parity.log);
      await append('Replaying the frozen simulation scenarios in the same isolated browser runtime used by the preview.');
      const verification = run.scenarios?.length ? await this.verify({ spec: run.spec!, candidate: run.candidate! }, run.scenarios) : { passed: false, results: [], error: 'No frozen simulation checks are available.' };
      const simulationChecked = simulationChecksPass(run.scenarios ?? [], verification);
      files['simulation-verification.json'] = JSON.stringify(verification, null, 2);
      await writeFile(path.join(directory, 'simulation-verification.json'), files['simulation-verification.json']);
      await append(simulationChecked ? 'Simulation checks passed.' : 'Draft: simulation checks are incomplete or failing. This remains visible in the export.');
      let compiled: Awaited<ReturnType<typeof buildHardwareProject>> | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await append(`Compiling ${configuration.fqbn} with its real toolchain (attempt ${attempt}/2).`);
          compiled = await this.compile({ adapter: state.profile!.adapter, fqbn: configuration.fqbn, sketchDirectory: path.join(directory, 'device'), outputDirectory: path.join(directory, 'firmware'), libraries: configuration.libraries });
          break;
        } catch (error) {
          const diagnostic = error instanceof Error ? error.message : String(error);
          await append(diagnostic);
          if (attempt === 2) {
            if (repairAttempt === 0 && this.simulations.repairHardware) {
              await append('Toolchain retry failed. Asking the agent to repair the shared controller against the same frozen requirements and simulation checks.');
              const repaired = await this.simulations.repairHardware(run.id, `Target ${configuration.fqbn}\n${diagnostic}`);
              const issues = configurationIssues(repaired.candidate!.controller!, configuration, state.profile!);
              if (issues.length) throw new Error(`Review the repaired controller's hardware bindings: ${issues.join('; ')}`);
              state.evidence = undefined;
              await this.execute(repaired, state, 1);
              return;
            }
            throw error;
          }
          await append('Repairing missing toolchain/package requirements and retrying the deterministic generated project.');
          await installHardwarePackage(state.profile!.core, state.profile!.version);
        }
      }
      if (!compiled?.artifacts.length) throw new Error('The toolchain returned no compiled firmware artifacts.');
      state.profile = compiled.profile;
      // Recreate documentation with resolved dependency versions, so an external
      // build uses the same libraries rather than a later Library Manager release.
      Object.assign(files, generateProjectFiles(run, { ...configuration, libraries: compiled.dependencies }, compiled.profile));
      await append(compiled.log);
      files['dependency-lock.json'] = JSON.stringify({ core: { id: compiled.profile.core, version: compiled.profile.version }, libraries: compiled.dependencies, fqbn: configuration.fqbn, framework: compiled.profile.framework, toolchain: compiled.profile.toolchain }, null, 2);
      files['compile.log'] = compiled.log;
      const hashes: Record<string, string> = {};
      for (const [name, content] of Object.entries(files)) { await writeFile(path.join(directory, name), content); hashes[name] = sha256(content); }
      for (const artifact of compiled.artifacts) hashes[`firmware/${artifact.name}`] = sha256(await readFile(artifact.path));
      for (const name of ['parity.cpp', 'controller.h', 'parity-report.json']) hashes[`checks/${name}`] = sha256(await readFile(path.join(directory, 'checks', name)));
      state.evidence = { generated: true, compiled: true, simulationChecked, controllerParity: parity.passed, physicalTested: false, checkedAt: new Date().toISOString(), fingerprint: this.fingerprint(run, state), artifactHashes: hashes, parityChecks: parity.checks, statement: 'Real selected-target compilation and native controller parity checks were run. Simulation checks cover the frozen modeled requirements. No physical hardware behavior was tested; uploading does not establish that behavior.' };
      state.status = 'COMPILED';
      state.issues = simulationChecked ? [] : ['Draft: compiled successfully, but simulation behavior checks are incomplete or failing.'];
      await writeFile(path.join(directory, 'verification-report.json'), JSON.stringify(state.evidence, null, 2));
      await this.saveIfCurrent(run, state);
    } catch (error) {
      state.status = 'FAILED'; state.error = error instanceof Error ? error.message : String(error);
      state.log = `${state.log ?? ''}\n${state.error}`;
      state.issues = [generated ? 'Source was generated, but the required compilation/checks did not finish. This is an unverified draft.' : 'Project generation did not finish.'];
      await this.saveIfCurrent(run, state);
    }
  }
  private async saveIfCurrent(run: SimulationRun, state: StoredState) {
    const current = await this.simulations.get(run.id);
    if (!current || this.simulations.projectHead && await this.simulations.projectHead(current) !== run.id || this.states.get(state.projectId)?.revisionId !== run.id) return;
    if (this.fingerprint(current, state) !== this.fingerprint(run, state) || current.status === 'STALE') { state.status = 'STALE'; state.evidence = undefined; state.error = 'The simulation changed during compilation. Build its current revision again.'; }
    await this.save(state);
  }
  private async artifactsMatch(state: StoredState) {
    if (!state.artifactFolder || !state.evidence) return false;
    try {
      if (canonical(JSON.parse(await readFile(path.join(state.artifactFolder, 'verification-report.json'), 'utf8'))) !== canonical(state.evidence)) return false;
      for (const [name, hash] of Object.entries(state.evidence.artifactHashes)) if (sha256(await readFile(path.join(state.artifactFolder, name))) !== hash) return false;
      return true;
    } catch { return false; }
  }
  async exportFiles(id: string): Promise<Record<string, Buffer>> {
    const current = await this.get(id);
    if (current.status !== 'COMPILED' || !current.evidence?.compiled) throw new Error('Build and check this revision with its selected device toolchain before downloading the hardware project.');
    const state = this.states.get(current.projectId)!;
    const result: Record<string, Buffer> = {};
    for (const [name, hash] of Object.entries(current.evidence.artifactHashes)) {
      const content = await readFile(path.join(state.artifactFolder!, name));
      if (sha256(content) !== hash) throw new Error('An artifact changed while preparing the download. Rebuild this project.');
      result[name] = content;
    }
    result['verification-report.json'] = Buffer.from(JSON.stringify(current.evidence, null, 2));
    const latestRun = await this.revision(id);
    const latestState = this.states.get(current.projectId)!;
    if (latestState.status !== 'COMPILED' || latestState.evidence?.fingerprint !== current.evidence.fingerprint || this.fingerprint(latestRun, latestState) !== current.evidence.fingerprint) throw new Error('The project changed while preparing its download. Build the current configuration.');
    return result;
  }
  async upload(id: string, port: string, confirm: boolean): Promise<HardwareProjectState> {
    if (confirm !== true || !port) throw new Error('Explicitly select a connected device and request upload.');
    const run = await this.revision(id);
    const unlock = this.lock(run.projectId ?? run.id);
    try {
    const current = await this.get(id);
    if (current.status !== 'COMPILED' || !current.profile?.uploadSupported) throw new Error('Build the current project for a board with upload support first.');
    const devices = await connectedHardware();
    const device = devices.find(device => device.port === port);
    if (!device) throw new Error('The explicitly selected device is no longer connected. Select it again.');
    if (device.boards.length && !device.boards.some(board => board.fqbn.split(':').slice(0, 3).join(':') === current.configuration!.fqbn.split(':').slice(0, 3).join(':'))) throw new Error('The connected board does not match the configured target. Select the matching board before upload.');
    const state = this.states.get(current.projectId)!;
    const latestRun = await this.revision(id);
    if (!current.evidence || this.fingerprint(latestRun, state) !== current.evidence.fingerprint || !await this.artifactsMatch(state)) throw new Error('The project changed before upload. Rebuild and explicitly select the device again.');
    const result = await uploadHardwareProject({ adapter: current.profile!.adapter, fqbn: current.configuration!.fqbn, port, inputDirectory: path.join(state.artifactFolder!, 'firmware'), explicitRequest: true });
    state.upload = { port, uploadedAt: new Date().toISOString(), log: typeof result === 'string' ? result : JSON.stringify(result), statement: 'Upload completed. Physical behavior has not been tested.' };
    await this.saveIfCurrent(latestRun, state);
    return this.publicState(state);
    } finally { unlock(); }
  }
}
