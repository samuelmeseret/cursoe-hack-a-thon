import Badge1 from '@/components/watermelon/badge-1'
import Button1 from '@/components/watermelon/button-1'
import type { AgentEvent, AgentName } from '@/mock/run'
import { agentNames, agentState } from './run-view'
import type { Activity } from './useRunPlayback'
import { Logo } from '@/components/brand/Logo'

export type AgentFilter = AgentName | 'all'

export function AgentSidebar({ events, activity, filter, onFilter, isPlaying, error }: {
  events: AgentEvent[]; activity: Activity | null; filter: AgentFilter
  onFilter: (filter: AgentFilter) => void; isPlaying: boolean; error: string | null
}) {
  const last = events.at(-1)
  const allState = error ? 'failed' : isPlaying ? 'running' : last?.type === 'failed' ? 'failed' : events.length ? 'passed' : 'idle'
  return (
    <aside className="primary-sidebar" aria-label="Agent filters">
      <Badge1 label="Agents" className="section-label" />
      <nav className="agent-navigation" aria-label="Filter timeline by agent">
        {(['all', ...Object.keys(agentNames)] as AgentFilter[]).map(agent => {
          const state = agent === 'all' ? allState : agentState(agent, events, activity)
          const working = activity?.agent === agent
          return <Button1 key={agent} className={`agent-row ${filter === agent ? 'is-selected' : ''}`}
            onClick={() => onFilter(agent)} aria-pressed={filter === agent}
            label={<><span className={`agent-square agent-${agent}`} aria-hidden="true" />
              <span className={`agent-name agent-label-${agent}`}>{agent === 'all' ? 'All agents' : agentNames[agent]}</span>
              <span className={`working-indicator ${working ? 'is-working' : ''}`} aria-hidden="true"><Logo size={16} animated={working} /></span>
              <span className={`agent-state state-${state}`}>{state}</span></>} />
        })}
      </nav>
      <div className="sidebar-footnote">
        <Badge1 label="Arduino Uno" className="board-name" />
        <Badge1 label="Recorded sample" className="caption" />
      </div>
    </aside>
  )
}
