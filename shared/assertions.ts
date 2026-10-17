import type { Assertion, CheckResult, Scenario, TracePoint } from './types';

function stateAt(points: TracePoint[], atMs: number): TracePoint | undefined {
  let state: TracePoint | undefined;
  for (const point of points) {
    if (point.atMs > atMs) break;
    state = point;
  }
  return state;
}

/** Evaluate the full transition log, never animation frames or serial text. */
export function evaluateAssertion(assertion: Assertion, trace: TracePoint[]): { passed: boolean; message: string } {
  const { fromMs, toMs } = assertion;
  if (assertion.type === 'deadtime') {
    const states = new Map<string, TracePoint>();
    let hasOpened = false;
    let closedAt: number | undefined;
    const gaps: number[] = [];
    const relevant = trace.filter((point) => assertion.signals.includes(point.signal) && point.atMs <= toMs);
    let index = 0;
    const allClosed = () => assertion.signals.every((signal) => states.get(signal)?.value === 0 && states.get(signal)?.mode === 'output');
    while (index < relevant.length) {
      const cycle = relevant[index].cycle;
      const atMs = relevant[index].atMs;
      const wasClosed = allClosed();
      const wasHigh = new Set([...states].filter(([, point]) => point.value === 1).map(([signal]) => signal));
      while (index < relevant.length && relevant[index].cycle === cycle) {
        const point = relevant[index++];
        states.set(point.signal, point);
      }
      const rises = [...states].filter(([signal, point]) => point.value === 1 && !wasHigh.has(signal));
      if (rises.length) {
        if (hasOpened && atMs >= fromMs) {
          if (closedAt === undefined || wasHigh.size > 0) return { passed: false, message: `New opening at ${atMs.toFixed(6)} ms without a driven-LOW closed interval` };
          if (closedAt >= fromMs) {
            const gap = atMs - closedAt;
            gaps.push(gap);
            if (gap < assertion.minMs) return { passed: false, message: `All doors closed for only ${gap.toFixed(6)} ms before opening at ${atMs.toFixed(6)} ms; minimum ${assertion.minMs} ms` };
          }
        }
        hasOpened = true;
      }
      const isClosed = allClosed();
      if (hasOpened && isClosed && !wasClosed) closedAt = atMs;
      if (!isClosed) closedAt = undefined;
    }
    return { passed: gaps.length >= assertion.minCount, message: `Completed driven-LOW closed intervals: ${gaps.length ? gaps.map((gap) => `${gap.toFixed(6)} ms`).join(', ') : 'none'}; expected at least ${assertion.minCount}, each >= ${assertion.minMs} ms` };
  }
  if (assertion.type === 'mutual-exclusion') {
    const states = new Map<string, TracePoint>();
    const relevant = trace.filter((point) => assertion.signals.includes(point.signal) && point.atMs <= toMs);
    let index = 0;
    while (index < relevant.length) {
      const cycle = relevant[index].cycle;
      const atMs = relevant[index].atMs;
      // A single PORT write changes all pins atomically. Group the same CPU cycle.
      while (index < relevant.length && relevant[index].cycle === cycle) {
        const point = relevant[index++];
        states.set(point.signal, point);
      }
      if (atMs < fromMs) continue;
      const active = [...states.values()].filter((point) => point.value === 1);
      if (active.length > 1) return { passed: false, message: `${active.map((p) => p.signal).join(' and ')} overlap at ${atMs.toFixed(6)} ms (cycle ${cycle})` };
    }
    const initialActive = assertion.signals.filter((signal) => stateAt(trace.filter((p) => p.signal === signal), fromMs)?.value === 1);
    if (initialActive.length > 1) return { passed: false, message: `${initialActive.join(' and ')} overlap at window start ${fromMs} ms` };
    if (assertion.signals.some((signal) => !trace.some((p) => p.signal === signal && p.atMs <= fromMs))) return { passed: false, message: 'Missing initial signal evidence' };
    return { passed: true, message: `No overlapping HIGH signals from ${fromMs} to ${toMs} ms` };
  }
  const points = trace.filter((point) => point.signal === assertion.signal);
  const initial = stateAt(points, fromMs);
  if (!initial) return { passed: false, message: `No GPIO evidence for ${assertion.signal} at ${fromMs} ms` };
  if (assertion.type === 'level') {
    const relevant = [initial, ...points.filter((point) => point.atMs > fromMs && point.atMs <= toMs)];
    const driven = assertion.driven === true || assertion.value === 1;
    const failure = relevant.find((point) => point.value !== assertion.value || (driven && point.mode !== 'output'));
    if (failure) return { passed: false, message: `${assertion.signal} was ${failure.value} (${failure.mode}) at ${Math.max(fromMs, failure.atMs).toFixed(6)} ms; expected ${assertion.driven ? 'driven ' : ''}${assertion.value}` };
    return { passed: true, message: `${assertion.signal} stayed ${assertion.driven ? 'driven ' : ''}${assertion.value} from ${fromMs} to ${toMs} ms` };
  }
  if (assertion.type === 'transition') {
    let count = 0;
    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1];
      const current = points[i];
      if (current.atMs < fromMs || current.atMs > toMs) continue;
      if (previous.mode !== 'output' || current.mode !== 'output') continue;
      if (assertion.edge === 'rising' ? previous.value === 0 && current.value === 1 : previous.value === 1 && current.value === 0) count++;
    }
    return {
      passed: count >= assertion.minCount && (assertion.maxCount === undefined || count <= assertion.maxCount),
      message: `${assertion.signal}: ${count} ${assertion.edge} transition(s), expected ${assertion.minCount}–${assertion.maxCount ?? 'unbounded'} from ${fromMs} to ${toMs} ms`,
    };
  }
  // Only intervals whose actual beginning and end were observed can satisfy minCount.
  // Partial intervals can still disprove maxMs, but never prove a correct pulse length.
  const durations: number[] = [];
  let start: number | undefined;
  let previousValue: TracePoint['value'] | undefined;
  for (const point of points) {
    if (point.atMs > toMs) break;
    if (start !== undefined && point.mode !== 'output' && point.atMs >= fromMs) return { passed: false, message: `${assertion.signal} stopped being driven during a measured ${assertion.value} interval at ${point.atMs.toFixed(6)} ms` };
    if (point.mode === 'output' && point.value === assertion.value && previousValue !== assertion.value) start = point.atMs;
    if (point.value !== assertion.value && previousValue === assertion.value && start !== undefined) {
      if (start >= fromMs) durations.push(point.atMs - start);
      start = undefined;
    }
    previousValue = point.mode === 'output' ? point.value : undefined;
  }
  if (start !== undefined && start >= fromMs && toMs - start > assertion.maxMs) {
    return { passed: false, message: `${assertion.signal} ${assertion.value} interval still active after ${(toMs - start).toFixed(3)} ms; maximum ${assertion.maxMs} ms` };
  }
  const invalid = durations.find((duration) => duration < assertion.minMs || duration > assertion.maxMs);
  const passed = invalid === undefined && durations.length >= assertion.minCount;
  return { passed, message: `${assertion.signal} ${assertion.value} complete intervals: ${durations.length ? durations.map((d) => `${d.toFixed(3)} ms`).join(', ') : 'none'}; expected at least ${assertion.minCount}, each ${assertion.minMs}–${assertion.maxMs} ms` };
}

/** Always returns exactly one result per expected check, including incomplete runs. */
export function evaluateScenario(scenario: Scenario, trace: TracePoint[], executionError?: string): CheckResult[] {
  return scenario.assertions.map((assertion) => {
    try {
      const result = executionError
        ? { passed: false, message: `Simulation did not complete: ${executionError}` }
        : evaluateAssertion(assertion, trace);
      return { id: assertion.id, scenarioId: scenario.id, requirementIds: [...assertion.requirementIds], ...result };
    } catch (error) {
      return { id: assertion.id, scenarioId: scenario.id, requirementIds: [...assertion.requirementIds], passed: false, message: `Check evaluation failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
}
