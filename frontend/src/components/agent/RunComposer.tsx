import type { FormEvent } from 'react'
import Button1 from '@/components/watermelon/button-1'
import Textarea3 from '@/components/watermelon/textarea-3'

export function RunComposer({ goal, onGoal, isPlaying, onRun }: {
  goal: string; onGoal: (goal: string) => void; isPlaying: boolean; onRun: () => void
}) {
  function submit(event: FormEvent) { event.preventDefault(); if (!isPlaying && goal.trim()) onRun() }
  return <form className="composer" onSubmit={submit} aria-label="Run a goal">
    <div className="composer-surface">
      <Textarea3 className="goal-input" label="Arduino goal" helper=""
        placeholder="Describe what your Arduino should do…" value={goal} disabled={isPlaying}
        onChange={event => onGoal(event.target.value)} rows={2}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event)
        }} />
      <Button1 type="submit" label={isPlaying ? 'Running' : 'Run'} disabled={isPlaying || !goal.trim()}
        className="run-button" />
    </div>
    <div className="composer-caption"><span>Sample playback: recorded LED + button run</span><span>Enter to run</span></div>
  </form>
}
