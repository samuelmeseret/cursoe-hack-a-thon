import type { AgentEvent, AgentName } from '@/mock/run'
import type { Activity } from './useRunPlayback'

export type RunStatus = 'idle' | 'running' | 'replanning' | 'verified' | 'failed'
export type PanelStatus = 'empty' | 'running' | 'passed' | 'failed'

export function getRunView(events: AgentEvent[], activity: Activity | null = null) {
  const last = events.at(-1)
  const status: RunStatus = !last ? 'idle'
    : last.agent === 'supervisor' && last.type === 'passed' ? 'verified'
    : last.type === 'decision' ? 'replanning'
    : last.type === 'failed' ? 'failed' : 'running'

  return {
    status,
    attempt: activity?.attempt ?? last?.attempt ?? 0,
    startedAt: events[0]?.timestamp ?? 0,
    elapsedMs: last ? last.timestamp - events[0].timestamp : 0,
    plan: events.findLast((event) => event.agent === 'planner' && event.type === 'output')?.content,
    sketch: events.findLast((event) => event.agent === 'coder' && event.type === 'output')?.content,
    scenario: events.findLast((event) => event.agent === 'verifier' && event.type === 'output')?.content,
    compile: events.findLast((event) => event.agent === 'compile'),
    simulation: events.findLast((event) => event.agent === 'sim'),
    verdict: events.findLast((event) => event.agent === 'supervisor' && (event.type === 'passed' || event.type === 'failed')),
    decision: events.findLast((event) => event.agent === 'supervisor' && event.type === 'decision'),
    decisions: events.filter((event) => event.agent === 'supervisor' && event.type === 'decision'),
    sketches: events.filter((event) => event.agent === 'coder' && event.type === 'output'),
  }
}

export type RunView = ReturnType<typeof getRunView>

export function formatTime(milliseconds: number, precision = 1) {
  const minutes = String(Math.floor(milliseconds / 60_000)).padStart(2, '0')
  const seconds = ((milliseconds % 60_000) / 1_000).toFixed(precision).padStart(precision + 3, '0')
  return `${minutes}:${seconds}`
}

export function describeEvent(event: AgentEvent) {
  if (event.type === 'started') return event.content.summary
  switch (event.agent) {
    case 'planner': return `${event.content.acceptanceCriteria.length} acceptance criteria defined`
    case 'coder': return event.content.summary
    case 'verifier': return 'Independent test scenario. Never saw the coder’s code.'
    case 'compile': return event.type === 'failed'
      ? `FAIL: ${event.content.diagnostics[0]?.message ?? 'Compilation failed.'}`
      : `PASS: ${event.content.artifact}`
    case 'sim': return `${event.type === 'passed' ? 'PASS' : 'FAIL'}: ${event.content.criteria.filter(result => result.status === 'passed').length}/${event.content.criteria.length} criteria passed`
    case 'supervisor': return event.type === 'decision'
      ? `${event.content.decision.toUpperCase()} / attempt ${event.content.nextAttempt}\n${event.content.reason}\n\n${event.content.instructions.join('\n')}`
      : event.content.summary
  }
}

export const agentNames: Record<AgentName, string> = {
  planner: 'Planner', coder: 'Coder', verifier: 'Verifier', compile: 'Compile', sim: 'Sim', supervisor: 'Supervisor',
}

export function agentState(agent: AgentName, events: AgentEvent[], activity: Activity | null) {
  if (activity?.agent === agent) return 'running'
  const last = events.findLast(event => event.agent === agent)
  if (!last) return 'idle'
  return last.type === 'failed' ? 'failed' : last.type === 'started' ? 'running' : 'passed'
}

export function scenarioReadout(view: RunView) {
  const scenario = view.scenario
  if (!scenario) return view.status === 'idle' ? 'No test scenario yet.' : 'Waiting for the verifier’s scenario.'
  return [
    scenario.name,
    scenario.description,
    'INDEPENDENCE\nThe verifier receives the goal and acceptance criteria, never the coder’s sketch.',
    `BUTTON INPUT / PIN 2 / ${scenario.durationMs / 1000}s\nTIME          LEVEL\n${scenario.buttonTransitions.map(step => `${formatTime(step.atMs, 3)}     ${step.level}`).join('\n')}`,
    `EXPECTED SERIAL\n${scenario.expectedSerialOutput.map(line => `${formatTime(line.atMs, 3)}     ${line.text}`).join('\n')}`,
  ].join('\n\n')
}
