import Badge1 from '@/components/watermelon/badge-1'
import Badge12 from '@/components/watermelon/badge-12'
import Card9 from '@/components/watermelon/card-9'
import Card10 from '@/components/watermelon/card-10'
import Alert12 from '@/components/watermelon/alert-12'
import { formatTime, type RunView } from './run-view'

export function RunContext({ view, isPlaying, elapsedMs, error }: {
  view: RunView; isPlaying: boolean; elapsedMs: number; error: string | null
}) {
  const result = view.simulation && view.simulation.type !== 'started' ? view.simulation.content : null
  const criteria = view.plan?.acceptanceCriteria ?? []
  const decisions = <div className="context-decisions">
    {view.decisions.length ? view.decisions.map(event => <Alert12 key={event.timestamp} text={<>
      <span className="decision-eyebrow">Supervisor / attempt {event.attempt}</span>
      <strong>{event.content.decision === 'replan' ? 'A new approach' : event.content.decision}</strong>
      <span className="decision-reason">{event.content.reason}</span>
      <span className="decision-instruction">{event.content.instructions.join(' ')}</span>
    </>} />) : <Card9 className="context-section" title="Supervisor decisions" body={isPlaying
      ? 'Watching the run. No intervention needed yet.' : view.status === 'idle'
        ? 'Decisions will appear here when the supervisor intervenes.' : 'The run finished without intervention.'} />}
  </div>
  const verdict = view.verdict
  return <aside className="context-sidebar" aria-label="Run context">
    <Card10 className="context-tabs" tabs={[
      { value: 'overview', label: 'Overview', content: <>
        <Card9 className="run-title-card" title={view.plan ? 'LED & button' : 'Your next run'} body={view.plan
          ? 'Arduino Uno · D13 LED · D2 button' : 'One goal. A verified sketch.'} />
        <Card9 className="context-section criteria-section" title={<>
          <span>Definition of Done</span><Badge1 label={criteria.length ? `${result?.criteria.filter(item => item.status === 'passed').length ?? 0}/${criteria.length}` : 'Pending'} className="caption mono" />
        </>} body={criteria.length ? criteria.map((criterion, index) => {
          const finding = result?.criteria.find(item => item.criterionId === criterion.id)
          const state = finding?.status ?? (verdict?.type === 'failed' || error ? 'failed' : 'pending')
          return <Card9 key={criterion.id} className="criterion" title={<>
            <Badge1 className="criterion-number mono" label={String(index + 1).padStart(2, '0')} />
            <Badge1 className={`text-state state-${state}`} label={state === 'passed' ? 'PASS' : state === 'failed' ? 'FAIL' : 'PENDING'} />
          </>} body={criterion.description} />
        }) : <span>{isPlaying ? 'The planner is defining acceptance criteria.' : 'The planner will turn your goal into measurable checks.'}</span>} />
        <Card9 className="context-section overview-decisions" title="Supervisor" body={view.decisions.length ? decisions
          : isPlaying ? 'Monitoring each attempt.' : 'Ready to retry, replan, or stop when needed.'} />
        <Card9 className={`context-section verdict-section ${verdict ? `verdict-${verdict.type}` : ''}`} title="Final verdict" body={verdict ? <>
          <Badge12 className={`state-${verdict.type}`} label={verdict.type === 'passed' ? 'Goal verified' : 'Verification failed'} />
          <div className="verdict-values"><span><b>{view.attempt}</b>attempts</span><span><b>{formatTime(elapsedMs)}</b>elapsed</span></div>
          <p>{verdict.content.summary.replace(/^PASS: |^FAIL: /, '')}</p>
          <p className="caption">{verdict.content.limitations.join(' ')}</p>
        </> : error ? <span className="state-failed">FAIL: {error}</span>
          : isPlaying ? 'RUNNING · Waiting for compilation and simulation.' : 'No verdict yet. Start a run to begin.'} />
      </> },
      { value: 'decisions', label: 'Decisions', content: decisions },
    ]} />
  </aside>
}
