import { useEffect, useRef, useState } from 'react'
import { mockRun, type AgentEvent, type AgentName } from '@/mock/run'

export type Activity = { agent: AgentName; attempt: number }
type SourceOptions = {
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
  onActivity: (activity: Activity) => void
}
// A backend adapter can feed the same callbacks without changing the views.
export type RunEventSource = (goal: string, options: SourceOptions) => Promise<void>

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

// This adapter replays the recorded fixture, not a newly generated result for the input.
export const mockEventSource: RunEventSource = async (_goal, { signal, onEvent, onActivity }) => {
  const clock = performance.now()
  const firstTimestamp = mockRun[0]?.timestamp ?? 0
  for (const event of mockRun) {
    signal.throwIfAborted()
    onActivity({ agent: event.agent, attempt: event.attempt })
    const delay = event.timestamp - firstTimestamp - (performance.now() - clock)
    if (delay > 0) await wait(delay, signal)
    signal.throwIfAborted()
    onEvent(event)
  }
}

export function useRunPlayback(source: RunEventSource) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [activity, setActivity] = useState<Activity | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const startedAt = useRef(0)

  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    if (!isPlaying) return
    const timer = setInterval(() => setElapsedMs(performance.now() - startedAt.current), 100)
    return () => clearInterval(timer)
  }, [isPlaying])

  async function start(goal: string) {
    if (!goal.trim() || controller.current) return
    const run = new AbortController()
    controller.current = run
    startedAt.current = performance.now()
    setEvents([])
    setError(null)
    setElapsedMs(0)
    setActivity(null)
    setIsPlaying(true)
    const received: AgentEvent[] = []
    try {
      await source(goal.trim(), {
        signal: run.signal,
        onActivity: value => { if (!run.signal.aborted) setActivity(value) },
        onEvent: event => {
          if (run.signal.aborted) return
          received.push(event)
          setEvents([...received])
          setActivity(event.type === 'started' ? { agent: event.agent, attempt: event.attempt } : null)
        },
      })
      if (!received.some(event => event.agent === 'supervisor' && (event.type === 'passed' || event.type === 'failed'))) {
        throw new Error('The event source ended before a final verdict arrived. Run again to retry.')
      }
    } catch (cause) {
      if (!run.signal.aborted) setError(cause instanceof Error ? cause.message : 'Playback stopped. Run again to retry.')
    } finally {
      if (!run.signal.aborted) {
        setIsPlaying(false)
        setActivity(null)
        setElapsedMs(received.length ? received.at(-1)!.timestamp - received[0].timestamp : 0)
        controller.current = null
      }
    }
  }

  return { events, isPlaying, activity, elapsedMs, error, start }
}
