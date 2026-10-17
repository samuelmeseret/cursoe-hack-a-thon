/** Public integration contract. These structures are data, never executable model code. */
export type ComponentKind = 'button' | 'led';
export interface LogicalComponent { id: string; kind: ComponentKind; label: string; meaning: string }
export interface Requirement { id: string; text: string }
export interface RunSpec { goal: string; assumptions: string[]; components: LogicalComponent[]; requirements: Requirement[] }
export interface PinAssignment { componentId: string; pin: number }
export interface Candidate { id: string; source: string; pins: PinAssignment[]; rationale: string }
export interface Connection { from: string; to: string }
export interface CircuitComponent extends LogicalComponent { pin: number; template: 'button-to-ground-pullup' | 'led-series-resistor'; resistanceOhms?: number }
export interface Circuit { board: 'arduino:avr:uno'; frequencyHz: 16000000; components: CircuitComponent[]; connections: Connection[] }
export interface ButtonInput { atMs: number; componentId: string; pressed: boolean }
export interface AssertionBase { id: string; requirementIds: string[]; fromMs: number; toMs: number }
export type Assertion =
  | (AssertionBase & { type: 'level'; signal: string; value: 0 | 1; driven?: boolean })
  | (AssertionBase & { type: 'transition'; signal: string; edge: 'rising' | 'falling'; minCount: number; maxCount?: number })
  | (AssertionBase & { type: 'duration'; signal: string; value: 0 | 1; minMs: number; maxMs: number; minCount: number })
  | (AssertionBase & { type: 'deadtime'; signals: string[]; minMs: number; minCount: number })
  | (AssertionBase & { type: 'mutual-exclusion'; signals: string[] });
export interface Scenario { id: string; name: string; durationMs: number; inputs: ButtonInput[]; assertions: Assertion[] }
export type SignalValue = 0 | 1 | 'floating';
export type PinMode = 'input' | 'input-pullup' | 'output';
/** Each point is an actual GPIO state/mode change, captured at AVR instruction boundaries. */
export interface TracePoint { cycle: number; atMs: number; signal: string; value: SignalValue; mode: PinMode }
export interface CheckResult { id: string; scenarioId: string; requirementIds: string[]; passed: boolean; message: string }
export interface ScenarioResult { scenarioId: string; completed: boolean; durationMs: number; trace: TracePoint[]; checks: CheckResult[]; error?: string }
export interface ArtifactHashes { source: string; circuit: string; hex: string; requirements: string; tests: string }
export interface Evidence { runId: string; candidateId: string; hashes: ArtifactHashes; simulatorVersion: string; createdAt: string; expectedCheckIds: string[]; results: ScenarioResult[]; passed: boolean }
export type RunStatus = 'QUEUED' | 'SPECIFYING' | 'VERIFYING_SPEC' | 'BUILDING' | 'COMPILING' | 'SIMULATING' | 'REPLANNING' | 'VERIFIED' | 'FAILED' | 'CANCELLED' | 'STALE';
export type AgentName = 'controller' | 'specifier' | 'verifier' | 'builder' | 'simulator';
export interface RunEvent { sequence: number; at: string; agent: AgentName; kind: 'activity' | 'frozen' | 'attempt' | 'failure' | 'replan' | 'terminal'; message: string; attempt?: number; details?: unknown }
export type RunMode = 'generate' | 'airlock-repair';
export type InferenceMode = 'crusoe' | 'fixture';
export interface StartRunRequest { goal: string; mode: RunMode; inference?: InferenceMode }
export interface AttemptRecord { attempt: number; candidate: Candidate; circuit?: Circuit; hex?: string; evidence?: Evidence; error?: string }
export interface RunState {
  id: string; goal: string; mode: RunMode; inference: InferenceMode; model?: string; status: RunStatus;
  createdAt: string; deadlineAt: string; attempts: AttemptRecord[]; replanCount: number;
  events: RunEvent[]; spec?: RunSpec; scenarios?: Scenario[]; candidate?: Candidate; circuit?: Circuit;
  hex?: string; evidence?: Evidence; failureEvidence?: Evidence; error?: string;
}
export interface HealthResponse { status: 'ok'; model: string; keyConfigured: boolean; compilerAvailable: boolean; artifactDirectory: string }
export type SimulatorCommand =
  | { type: 'load'; hex: string; circuit: Circuit }
  | { type: 'play' | 'pause' | 'reset' }
  | { type: 'button'; componentId: string; pressed: boolean }
  | { type: 'scenario'; hex: string; circuit: Circuit; scenario: Scenario };
export type SimulatorMessage =
  | { type: 'trace'; trace: TracePoint[]; atMs: number }
  | { type: 'state'; running: boolean; atMs: number }
  | { type: 'result'; result: ScenarioResult }
  | { type: 'error'; message: string };
