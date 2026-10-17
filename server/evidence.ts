import { createHash } from 'node:crypto';
import type { ArtifactHashes, Candidate, Circuit, Evidence, RunSpec, Scenario, ScenarioResult, TracePoint } from '../shared/types.js';
import { evaluateScenario } from '../shared/assertions.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function artifactHashes(candidate: Candidate, circuit: Circuit, hex: string, spec: RunSpec, scenarios: Scenario[]): ArtifactHashes {
  return { source: sha256(candidate.source), circuit: sha256(canonical(circuit)), hex: sha256(hex), requirements: sha256(canonical(spec)), tests: sha256(canonical(scenarios)) };
}
export const expectedChecks = (scenarios: Scenario[]) => scenarios.flatMap(s => s.assertions.map(a => `${s.id}/${a.id}`)).sort();
export function hasObservedOverlap(trace: TracePoint[], signals: string[]): boolean {
  const states = new Map<string, TracePoint>();
  for (let i = 0; i < trace.length;) {
    const cycle = trace[i].cycle;
    while (i < trace.length && trace[i].cycle === cycle) { const point = trace[i++]; if (signals.includes(point.signal)) states.set(point.signal, point); }
    if ([...states.values()].filter(point => point.value === 1 && point.mode === 'output').length > 1) return true;
  }
  return false;
}

/** Fail closed: the model's claims and the evidence.passed summary are never inputs to this gate. */
export function evidencePasses(evidence: Evidence, hashes: ArtifactHashes, scenarios: Scenario[], candidateId: string): boolean {
  const expected = expectedChecks(scenarios);
  if (!expected.length || evidence.candidateId !== candidateId || canonical(evidence.hashes) !== canonical(hashes)) return false;
  if (canonical([...evidence.expectedCheckIds].sort()) !== canonical(expected)) return false;
  if (evidence.results.length !== scenarios.length || new Set(evidence.results.map(r => r.scenarioId)).size !== scenarios.length) return false;
  for (const scenario of scenarios) {
    const result = evidence.results.find(r => r.scenarioId === scenario.id);
    if (!result || !result.completed || result.error || !Number.isFinite(result.durationMs) || result.durationMs < scenario.durationMs || !result.trace.length) return false;
    let lastCycle = -1;
    for (const point of result.trace) {
      if (!Number.isSafeInteger(point.cycle) || point.cycle < lastCycle || !Number.isFinite(point.atMs) || point.atMs < 0 || point.atMs > scenario.durationMs + 1 || Math.abs(point.atMs - point.cycle / 16000) > 0.000001) return false;
      if (![0, 1, 'floating'].includes(point.value) || !['input', 'input-pullup', 'output'].includes(point.mode)) return false;
      lastCycle = point.cycle;
    }
    const expectedIds = scenario.assertions.map(a => a.id).sort();
    if (canonical(result.checks.map(c => c.id).sort()) !== canonical(expectedIds)) return false;
    for (const check of result.checks) {
      const assertion = scenario.assertions.find(a => a.id === check.id);
      if (!assertion || check.scenarioId !== scenario.id || check.passed !== true || canonical([...check.requirementIds].sort()) !== canonical([...assertion.requirementIds].sort())) return false;
    }
    // Independently recompute structured assertions; passed:true without supporting GPIO is insufficient.
    if (evaluateScenario(scenario, result.trace).some(check => !check.passed)) return false;
  }
  return true;
}
export function createEvidence(runId: string, candidate: Candidate, hashes: ArtifactHashes, scenarios: Scenario[], results: ScenarioResult[], simulatorVersion: string): Evidence {
  const evidence: Evidence = { runId, candidateId: candidate.id, hashes, simulatorVersion, createdAt: new Date().toISOString(), expectedCheckIds: expectedChecks(scenarios), results, passed: false };
  evidence.passed = evidencePasses(evidence, hashes, scenarios, candidate.id);
  return evidence;
}
