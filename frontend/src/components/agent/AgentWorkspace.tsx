import { useState } from 'react'
import Badge1 from '@/components/watermelon/badge-1'
import Badge12 from '@/components/watermelon/badge-12'
import Button1 from '@/components/watermelon/button-1'
import Card9 from '@/components/watermelon/card-9'
import CountUp from '@/components/CountUp'
import { Logo } from '@/components/brand/Logo'
import { LogoMotion } from './LogoMotion'
import { mockGoal } from '@/mock/run'
import { AgentSidebar, type AgentFilter } from './AgentSidebar'
import { AgentTimeline } from './AgentTimeline'
import { RunArtifacts } from './RunArtifacts'
import { RunComposer } from './RunComposer'
import { RunContext } from './RunContext'
import { getRunView } from './run-view'
import { mockEventSource, useRunPlayback } from './useRunPlayback'
import './workspace.css'

const suggestions = [
  { label: 'Blink + button', goal: mockGoal },
  { label: 'Debounce a button', goal: "Blink the pin 13 LED every 500ms while debouncing a pin 2 button and printing 'pressed' once per press." },
  { label: 'Keep the loop responsive', goal: "Use millis() to blink pin 13 every 500ms without blocking, and print 'pressed' for each debounced button press on pin 2." },
]

export function AgentWorkspace() {
  const playback = useRunPlayback(mockEventSource)
  const [goal, setGoal] = useState('')
  const [filter, setFilter] = useState<AgentFilter>('all')
  const [runId, setRunId] = useState(0)
  const view = getRunView(playback.events, playback.activity)
  const hasRun = playback.isPlaying || playback.events.length > 0 || !!playback.error
  const status = playback.error ? 'failed' : view.verdict?.type ?? (playback.isPlaying
    ? view.status === 'replanning' ? 'replanning' : 'running' : 'idle')
  const statusLabel = { idle: 'Ready to run', running: 'Running', replanning: 'Replanning', passed: 'Verified', failed: 'Failed' }[status]

  function start() {
    if (playback.isPlaying || !goal.trim()) return
    setFilter('all')
    setRunId(value => value + 1)
    void playback.start(goal)
  }

  return <LogoMotion decision={view.decision?.timestamp}><main className="app-shell" aria-label="Firmware agent workspace">
    <header className="top-toolbar">
      <div className="project-brand"><Logo size={28} animated={playback.isPlaying} /><span>Firmware<span className="brand-divider">/</span><span className="brand-subtitle">Agent workspace</span></span></div>
      <div className="run-metadata"><Badge12 label={statusLabel} className={`state-${status}`} />
        <span className="attempt-counter"><span>Attempt</span><CountUp from={Math.max(0, view.attempt - 1)} to={view.attempt} duration={0.18} trigger="load" /></span>
      </div>
    </header>
    <div className="workspace-regions">
      <AgentSidebar events={playback.events} activity={playback.activity} filter={filter} onFilter={setFilter} isPlaying={playback.isPlaying} error={playback.error} />
      <RunContext view={view} isPlaying={playback.isPlaying} elapsedMs={playback.elapsedMs} error={playback.error} />
      <div className="main-workspace">
        <div className={`workspace-scroll ${hasRun ? 'has-run' : ''}`} key={runId}>
          {hasRun ? <>
            <div className="run-heading"><h1>LED & button</h1><Badge1 className="caption" label="Sample run / Arduino Uno" /></div>
            <AgentTimeline events={playback.events} filter={filter} activity={playback.activity} error={playback.error} />
            <RunArtifacts view={view} events={playback.events} activity={playback.activity} isPlaying={playback.isPlaying} error={playback.error} />
          </> : <div className="empty-workspace">
            <Badge12 label="Ready when you are" className="state-idle" />
            <div className="empty-logo"><Logo size={56} /></div>
            <Card9 className="empty-introduction" title="What should your Arduino do?" body="Start with a goal. Follow the agents from the first plan to a verified sketch." />
            <div className="suggestion-chips" aria-label="Suggested goals">
              {suggestions.map(suggestion => <Button1 key={suggestion.label} label={suggestion.label} className="suggestion-chip" onClick={() => setGoal(suggestion.goal)} />)}
            </div>
            <Badge1 className="empty-note" label="Try the LED + button sample" />
          </div>}
        </div>
        <RunComposer goal={goal} onGoal={setGoal} isPlaying={playback.isPlaying} onRun={start} />
      </div>
    </div>
  </main></LogoMotion>
}
