import { useEffect, useRef, useState } from 'react'
import AnimatedList from '@/components/AnimatedList'
import Alert12 from '@/components/watermelon/alert-12'
import Badge1 from '@/components/watermelon/badge-1'
import Card9 from '@/components/watermelon/card-9'
import type { AgentEvent } from '@/mock/run'
import { agentNames, describeEvent, formatTime } from './run-view'
import type { AgentFilter } from './AgentSidebar'
import type { Activity } from './useRunPlayback'
import { Logo } from '@/components/brand/Logo'

export function AgentTimeline({ events, filter, activity, error }: {
  events: AgentEvent[]; filter: AgentFilter; activity: Activity | null; error: string | null
}) {
  const visible = events.filter(event => filter === 'all' || event.agent === filter)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    const viewport = root.current?.querySelector<HTMLElement>('[role="listbox"]')
    if (!viewport || !follow.current) return
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
  }, [events.length, filter])
  return <section className="timeline-section" aria-label="Agent timeline">
    <div className="section-heading">
      <h2>{filter === 'all' ? 'Agent timeline' : `${agentNames[filter]} activity`}</h2>
      <Badge1 className="caption mono" label={`${visible.length} ${visible.length === 1 ? 'event' : 'events'}`} />
    </div>
    <div ref={root} onScrollCapture={event => {
      const target = event.target as HTMLElement
      follow.current = target.scrollHeight - target.scrollTop - target.clientHeight < 48
    }}>
      {visible.length ? <AnimatedList
        items={visible.map(event => ({ id: event.timestamp, title: agentNames[event.agent] }))}
        className="timeline-list" itemClassName="timeline-list-item" theme="light"
        frame={false} showGradients={false} selectOnHover={false} animation="slide" animateOnce
        radius={12} gap={8} stagger={0} maxHeight={360} width="100%"
        onItemSelect={(_, index) => setSelectedId(visible[index].timestamp)}
        renderItem={(_, index) => {
          const event = visible[index]
          if (event.agent === 'supervisor' && event.type === 'decision') return <Alert12 className={activity && event.timestamp === events.at(-1)?.timestamp ? 'decision-new' : ''} text={<>
            <span className="decision-eyebrow">Supervisor <span className="mono">{formatTime(event.timestamp - events[0].timestamp)}</span></span>
            <strong>{event.content.decision === 'replan' ? 'Replan for attempt ' + event.content.nextAttempt : event.content.decision}</strong>
            <span className="decision-reason">{event.content.reason}</span>
            <span className="decision-instruction">{event.content.instructions.join(' ')}</span>
            {selectedId === event.timestamp && <span className="event-detail">{event.content.diagnosticFingerprint}</span>}
          </>} />
          return <Card9 className={`timeline-event outcome-${event.type} ${selectedId === event.timestamp ? 'event-selected' : ''}`}
            title={<><span className={`event-agent agent-label-${event.agent}`}><span className={`agent-square agent-${event.agent}`} />{agentNames[event.agent]}
              {event.type === 'started' && activity?.agent === event.agent && activity?.attempt === event.attempt && <Logo size={16} animated />}</span>
              <span className="event-time mono">A{event.attempt} <span>{formatTime(event.timestamp - events[0].timestamp)}</span></span></>}
            body={<><span>{describeEvent(event)}</span>
              {event.agent === 'verifier' && <Badge1 className="independence-label" label="never saw coder's code" />}
              {selectedId === event.timestamp && <span className="event-detail">{event.agent === 'compile' && event.type === 'failed'
                ? event.content.diagnostics.map(diagnostic => `${diagnostic.filename}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`).join('\n')
                : `Attempt ${event.attempt} · ${event.type} · ${new Date(event.timestamp).toLocaleTimeString('en-US', {hour12: false})}`}</span>}
            </>} />
        }} /> : <Card9 className="timeline-placeholder" title="No events yet" body={activity
          ? `${agentNames[activity.agent]} is working. This filter has no events yet.` : error ?? 'No events for this agent.'} />}
    </div>
    <div className={`activity-caption ${error ? 'state-failed' : ''}`} role="status">
      <span className={`working-indicator ${activity ? 'is-working' : ''}`} aria-hidden="true"><Logo size={16} animated={!!activity} /></span>
      {error ? `FAIL: ${error}` : activity ? `${agentNames[activity.agent]} running · attempt ${activity.attempt}` : 'Run complete. Select an event to inspect its details.'}
    </div>
  </section>
}
