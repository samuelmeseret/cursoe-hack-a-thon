import type { PortableControllerProgram } from './portable-controller';

/** A generated simulation's public contract. Its verification suite is data, never code. */
export type SimulationScalar = string | number | boolean | null;

export interface SimulationControl {
  id: string;
  label: string;
  type: 'range' | 'toggle' | 'button' | 'select' | 'key';
  initial: SimulationScalar;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  key?: string;
}

export interface SimulationObservable {
  id: string;
  label: string;
  type: 'number' | 'boolean' | 'string';
  unit?: string;
}

export interface SimulationSpec {
  goal: string;
  title: string;
  summary: string;
  assumptions: string[];
  controls: SimulationControl[];
  observables: SimulationObservable[];
  requirements: { id: string; text: string }[];
}

export interface SimulationCandidate {
  id: string;
  source: string;
  rationale: string;
  /** Authoritative behavior, compiled to browser JS and device C++. */
  controller?: PortableControllerProgram;
  /** Drawing and environmental physics; never translated into firmware. */
  environmentSource?: string;
  /** Specific reason a simulation-only candidate cannot target hardware. */
  hardwareUnavailableReason?: string;
}

export interface SimulationArtifact {
  spec: SimulationSpec;
  candidate: SimulationCandidate;
}

export type SimulationStep =
  | { type: 'input'; controlId: string; value: SimulationScalar }
  | { type: 'advance'; durationMs: number }
  | { type: 'reset' }
  | {
    type: 'assert';
    id: string;
    requirementIds: string[];
    observable: string;
    operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'approx';
    value: SimulationScalar;
    tolerance?: number;
  };

export interface SimulationScenario {
  id: string;
  name: string;
  steps: SimulationStep[];
}

export interface SimulationCheckResult {
  id: string;
  requirementIds: string[];
  passed: boolean;
  actual?: SimulationScalar;
  message: string;
}

export interface SimulationScenarioResult {
  scenarioId: string;
  name: string;
  completed: boolean;
  checks: SimulationCheckResult[];
  error?: string;
}

export interface SimulationVerification {
  passed: boolean;
  results: SimulationScenarioResult[];
  error?: string;
}
