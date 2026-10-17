import { useState } from 'react'
import Badge1 from '@/components/watermelon/badge-1'
import Button1 from '@/components/watermelon/button-1'
import Card9 from '@/components/watermelon/card-9'
import Card10 from '@/components/watermelon/card-10'
import Textarea3 from '@/components/watermelon/textarea-3'
import type { AgentEvent } from '@/mock/run'
import { formatTime, scenarioReadout, type RunView } from './run-view'
import { CodeReadout } from './CodeReadout'
import type { Activity } from './useRunPlayback'

export function RunArtifacts({ view, events, activity, isPlaying, error }: {
  view: RunView; events: AgentEvent[]; activity: Activity | null; isPlaying: boolean; error: string | null
}) {
  const [attempt, setAttempt] = useState<number | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const selected = view.sketches.find(event => event.attempt === attempt) ?? view.sketches.at(-1)
  const previous = selected ? view.sketches[view.sketches.indexOf(selected) - 1] : undefined
  const compile = events.filter(event => event.agent === 'compile').findLast(event => event.attempt === selected?.attempt)
  const compileStatus = compile?.type === 'passed' ? 'PASS · Compiled' : compile?.type === 'failed' ? 'FAIL · Compile error'
    : activity?.agent === 'compile' ? 'RUNNING · Compiling' : 'PENDING · Compilation'
  const simulation = view.simulation
  const result = simulation && simulation.type !== 'started' ? simulation.content : undefined
  const serial = result?.serialOutput ?? []
  const serialStatus = error ? 'FAIL' : simulation?.type === 'passed' ? 'PASS' : simulation?.type === 'failed' ? 'FAIL'
    : activity?.agent === 'sim' ? 'RUNNING' : 'PENDING'
  return <>
    <section className="artifacts-section" aria-label="Run artifacts">
      <div className="section-heading"><h2>Run artifacts</h2><Badge1 label="Read only" className="caption" /></div>
      <Card10 tabs={[
        { value: 'sketch', label: 'Sketch', content: selected ? <>
          <div className="artifact-controls">
            <div className="attempt-switcher" aria-label="Sketch attempts">
              {view.sketches.map(event => <Button1 key={event.attempt} label={`Attempt ${event.attempt}`}
                aria-pressed={selected.attempt === event.attempt}
                className={`attempt-button ${selected.attempt === event.attempt ? 'is-selected' : ''}`}
                onClick={() => setAttempt(event.attempt)} />)}
            </div>
            <Button1 label="Show diff" className={`diff-button ${showDiff ? 'is-selected' : ''}`}
              aria-pressed={showDiff} disabled={!previous} onClick={() => setShowDiff(value => !value)} />
          </div>
          <div className="artifact-meta"><span className="mono">{selected.content.filename} / v{selected.content.version}</span>
            <span className={`state-${compile?.type ?? 'pending'}`}>{compileStatus}</span></div>
          {showDiff && previous && <p className="diff-caption">Changes from attempt {previous.attempt} to attempt {selected.attempt}</p>}
          <CodeReadout code={selected.content.code} previous={previous?.content.code} showDiff={showDiff && !!previous} />
          {compile?.type === 'failed' && <div className="compile-diagnostic state-failed">{compile.content.diagnostics.map(item => `${item.filename}:${item.line}:${item.column} ${item.message}`).join('\n')}</div>}
        </> : <Card9 className="artifact-placeholder" title={error ? 'FAIL' : 'PENDING'} body={error ?? (isPlaying ? 'The coder is preparing the first sketch.' : 'No sketch yet.')} /> },
        { value: 'test', label: 'Test', content: <>
          <div className="artifact-meta"><Badge1 label="never saw coder's code" className="independence-label" />
            <span className={`state-${simulation?.type ?? 'pending'}`}>{view.scenario ? `${serialStatus} · Simulation` : 'PENDING'}</span></div>
          <pre className="test-readout">{error && !view.scenario ? `FAIL: ${error}` : scenarioReadout(view)}{result && `\n\nSIMULATION EVIDENCE\n${result.criteria.map(item => `${item.status === 'passed' ? 'PASS' : 'FAIL'} ${item.criterionId}\n${item.evidence}`).join('\n\n')}`}</pre>
        </> },
      ]} />
    </section>
    <section className="serial-section" aria-label="Serial monitor">
      <div className="section-heading"><h2>Serial monitor</h2><Badge1 label={serialStatus} className={`text-state state-${serialStatus.toLowerCase()}`} /></div>
      <Textarea3 className="serial-readout" label={`${view.plan?.serialBaud ?? 9600} baud / simulated output`}
        readOnly value={serial.length ? serial.map(line => `${formatTime(line.atMs, 3)}   ${line.text}`).join('\n')
          : error ? `FAIL: ${error}` : activity?.agent === 'sim' ? 'RUNNING · Waiting for serial output…'
            : result ? 'No serial output was produced.' : 'PENDING · Output appears after simulation.'}
        helper={result ? `${serial.length} lines captured over ${result.durationMs / 1000}s` : 'No hardware connected'} />
    </section>
  </>
}
