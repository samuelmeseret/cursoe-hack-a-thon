import { useEffect, useRef, useState } from 'react';
import type { HealthResponse, RunState, SimulatorCommand, SimulatorMessage, TracePoint } from '../shared/types';
import { circuitSvg } from '../server/diagram';

const AIRLOCK_GOAL = 'Build a spaceship airlock with two request buttons and two door LEDs. Debounce for 20 ms, open for 2 seconds, keep both doors closed for 250 ms between openings, reject simultaneous requests, discard busy requests, and never open both doors together.';
const terminal = (status?: string) => ['VERIFIED', 'FAILED', 'CANCELLED', 'STALE'].includes(status || '');
const api = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init); const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
};
export function App() {
  const [health, setHealth] = useState<HealthResponse>();
  const [goal, setGoal] = useState(AIRLOCK_GOAL);
  const [mode, setMode] = useState<'airlock-repair' | 'generate'>('airlock-repair');
  const [inference, setInference] = useState<'crusoe' | 'fixture'>('crusoe');
  const [run, setRun] = useState<RunState>();
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [tab, setTab] = useState('Requirements');
  const [running, setRunning] = useState(false);
  const [atMs, setAtMs] = useState(0);
  const [live, setLive] = useState<Record<string, TracePoint>>({});
  const [view, setView] = useState<'live' | 'failure'>('live');
  const [playback, setPlayback] = useState(0);
  const machineKey = run?.hex && run.circuit ? `${run.candidate?.id}:${run.hex}:${JSON.stringify(run.circuit)}` : '';
  const worker = useRef<Worker | null>(null);
  const activity = useRef<HTMLDivElement>(null);
  const send = (message: SimulatorCommand) => worker.current?.postMessage(message);
  useEffect(() => { api<HealthResponse>('/api/health').then(setHealth).catch(e => setError(e.message)); }, []);
  useEffect(() => { const id = new URLSearchParams(location.search).get('run'); if (id) api<RunState>(`/api/runs/${encodeURIComponent(id)}`).then(setRun).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    const w = new Worker(new URL('./simulator.worker.ts', import.meta.url), { type: 'module' }); worker.current = w;
    w.onmessage = ({ data }: MessageEvent<SimulatorMessage>) => {
      if (data.type === 'error') setError(data.message);
      if (data.type === 'state') { setRunning(data.running); setAtMs(data.atMs); }
      if (data.type === 'trace') { setAtMs(data.atMs); setLive(previous => { const next = { ...previous }; data.trace.forEach(point => { next[point.signal] = point; }); return next; }); }
    };
    return () => { w.terminate(); worker.current = null; };
  }, []);
  useEffect(() => {
    if (run?.hex && run.circuit) { setLive({}); setAtMs(0); setRunning(false); send({ type: 'load', hex: run.hex, circuit: run.circuit }); }
    else { send({ type: 'pause' }); setLive({}); setAtMs(0); setRunning(false); }
  }, [machineKey]);
  useEffect(() => {
    if (!run?.id) return;
    const id = run.id;
    let disposed = false;
    const refresh = () => api<RunState>(`/api/runs/${id}`).then(next => {
      if (disposed) return;
      // A slower earlier request must not restore an old candidate or verification badge.
      setRun(current => current?.id === id && next.events.length >= current.events.length ? next : current);
    }).catch(e => { if (!disposed) setError(e.message); });
    const events = new EventSource(`/api/runs/${id}/events`);
    events.addEventListener('run-event', refresh);
    const polling = window.setInterval(refresh, 5000); // also detects on-disk artifact changes after completion
    return () => { disposed = true; events.close(); clearInterval(polling); };
  }, [run?.id]);
  useEffect(() => { activity.current?.scrollTo({ top: activity.current.scrollHeight }); }, [run?.events.length]);
  const start = async () => {
    setError(''); setStarting(true); send({ type: 'pause' }); setView('live');
    try { const next = await api<RunState>('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal, mode, inference }) }); setRun(next); history.replaceState(null, '', `?run=${next.id}`); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setStarting(false); }
  };
  const failure = run?.failureEvidence?.results.find(r => r.checks.some(c => !c.passed)) ?? run?.failureEvidence?.results[0];
  const recorded: Record<string, TracePoint> = {};
  failure?.trace.filter(p => p.atMs <= playback).forEach(p => { recorded[p.signal] = p; });
  const conflictAt = (() => {
    const high = new Set<string>();
    const outputs = new Set(run?.spec?.components.filter(c => c.kind === 'led').map(c => c.id));
    for (const point of failure?.trace ?? []) {
      if (!outputs.has(point.signal)) continue;
      if (point.value === 1 && point.mode === 'output') high.add(point.signal); else high.delete(point.signal);
      if (high.size > 1) return point.atMs;
    }
    return 0;
  })();
  const signals = view === 'live' ? live : recorded;
  const displayedCircuit = view === 'failure' ? run?.attempts.find(a => a.candidate.id === run.failureEvidence?.candidateId)?.circuit : run?.circuit;
  const active = starting || Boolean(run && !terminal(run.status));
  const checks = run?.evidence?.results.flatMap(r => r.checks) ?? [];
  return <main>
    <header><div><span className="eyebrow">Arduino agents / engineering harness</span><h1>Airlock Lab<span className="accent">.</span></h1></div><div className="health"><span className={health?.compilerAvailable ? 'dot good' : 'dot'}/>{health?.compilerAvailable ? 'Uno compiler ready' : 'Compiler unavailable'}<br/><small>{health?.model || 'Connecting to local API…'}</small></div></header>
    <section className="goal"><label htmlFor="goal">01 / DEFINE THE JOB</label><textarea id="goal" value={goal} onChange={e => setGoal(e.target.value)} rows={3}/><div className="toolbar"><select aria-label="Run mode" value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="airlock-repair">Airlock repair challenge</option><option value="generate">Generate a supported circuit</option></select><select aria-label="Inference mode" value={inference} onChange={e => setInference(e.target.value as typeof inference)}><option value="crusoe">Live Crusoe agents</option><option value="fixture">Offline fixture rehearsal · no AI</option></select><button className="primary" disabled={active} onClick={start}>{starting ? 'Starting…' : 'Start run ↗'}</button>{active && run && <button onClick={() => api<RunState>(`/api/runs/${run.id}/cancel`, { method: 'POST' }).then(setRun).catch(e => setError(e.message))}>Cancel</button>}</div><small>One Uno · buttons on ground with pull-ups · LEDs with 220Ω resistors · D2–D13</small></section>
    {error && <div role="alert" className="error">{error}</div>}
    <div className="workspace"><section className="machine"><div className="section-heading"><h2>02 / CIRCUIT & SIGNALS</h2><span className="muted">16 MHz / 32 KB flash / 2 KB SRAM</span></div>{displayedCircuit ? <div className="circuit" dangerouslySetInnerHTML={{ __html: circuitSvg(displayedCircuit) }}/> : <div className="empty"><span className="chip">UNO</span><p>The validated circuit appears after a candidate is built.</p><small>The browser will execute the compiled firmware in AVR8js.</small></div>}
      <div className="toolbar sim-controls"><button disabled={!run?.hex} onClick={() => { setView('live'); send({ type: running ? 'pause' : 'play' }); }}>{running ? 'Pause' : 'Run simulator'}</button><button disabled={!run?.hex} onClick={() => { setView('live'); setLive({}); setAtMs(0); send({ type: 'reset' }); }}>Reset machine</button><span className="mono">{((view === 'failure' ? playback : atMs) / 1000).toFixed(2)}s</span><span className="mode-tag">{view === 'live' ? 'LIVE INTERACTION' : 'RECORDED FAILURE'}</span></div>
      <div className="signals">{displayedCircuit?.components.map(c => c.kind === 'led' ? <div className={`door ${signals[c.id]?.value === 1 && signals[c.id]?.mode === 'output' ? 'open' : ''}`} key={c.id}><span className="lamp"/><strong>{c.label}</strong><small>{signals[c.id]?.mode === 'output' ? (signals[c.id]?.value === 1 ? 'ON / OPEN' : 'OFF / CLOSED') : 'NOT DRIVEN'}</small></div> : <button key={c.id} className="request" disabled={!running || view !== 'live'} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); send({ type: 'button', componentId: c.id, pressed: true }); }} onPointerUp={() => send({ type: 'button', componentId: c.id, pressed: false })} onPointerCancel={() => send({ type: 'button', componentId: c.id, pressed: false })} onKeyDown={e => { if ([' ', 'Enter'].includes(e.key) && !e.repeat) { e.preventDefault(); send({ type: 'button', componentId: c.id, pressed: true }); } }} onKeyUp={e => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); send({ type: 'button', componentId: c.id, pressed: false }); } }} onBlur={() => send({ type: 'button', componentId: c.id, pressed: false })}>{c.label}<small>Hold to press · D{c.pin}</small></button>)}</div>
      {failure && <div className="playback"><button onClick={() => { send({ type: 'pause' }); setView(view === 'failure' ? 'live' : 'failure'); if (view === 'live') setPlayback(conflictAt); }}> {view === 'failure' ? 'Return to live signals' : 'Inspect recorded failure'}</button>{view === 'failure' && <><label htmlFor="playback">{failure.scenarioId} · {playback.toFixed(0)} ms</label><input id="playback" type="range" min={0} max={failure.durationMs} step={1} value={playback} onChange={e => setPlayback(Number(e.target.value))}/></>}</div>}
    </section><aside><div className="section-heading"><h2>03 / RUN CONTROLLER</h2></div><div className={`result ${run?.status === 'VERIFIED' ? 'verified' : ''}`} role="status"><strong>{run?.status === 'VERIFIED' ? 'Verified in simulation' : run?.status.replaceAll('_', ' ') || 'Ready for a goal'}</strong><p>{run?.status === 'VERIFIED' ? `${checks.length} listed simulator checks passed.` : run?.error || 'Only executed checks can authorize completion.'}</p><small>{run ? `Candidate ${run.attempts.length}/4 · Replans ${run.replanCount}/1 · ${run.inference === 'fixture' ? 'OFFLINE FIXTURES' : 'CRUSOE INFERENCE'}` : 'Four candidates · one replan · three minutes'}</small></div><div className="activity" ref={activity}>{run?.events.map(e => <div className={`event ${e.kind}`} key={e.sequence}><span className="mono">{String(e.sequence).padStart(2, '0')}</span><div><small>{e.agent.toUpperCase()}</small><p>{e.message}</p></div></div>) ?? <p className="muted">Actual agent and controller events will appear here.</p>}</div>{run && terminal(run.status) && <a className="download" href={`/api/runs/${run.id}/artifacts`}>Download run artifacts ↓</a>}</aside></div>
    <section className="inspector"><nav aria-label="Artifact views">{['Requirements', 'Code', 'Tests', 'Traces', 'Evidence'].map(name => <button aria-pressed={name === tab} key={name} onClick={() => setTab(name)}>{name}</button>)}</nav><div className="tab-content">{tab === 'Requirements' ? run?.spec ? <><h3>Frozen contract</h3>{run.spec.assumptions.map((a, i) => <p className="muted" key={i}>{a}</p>)}{run.spec.requirements.map(r => <p key={r.id}><code>{r.id}</code> {r.text}</p>)}</> : <p className="muted">Requirements and component meanings freeze before the first build.</p> : tab === 'Code' ? <pre>{run?.candidate?.source || 'No candidate source yet.'}</pre> : tab === 'Tests' ? <>{run?.scenarios?.map(s => <details key={s.id}><summary>{s.name} · {s.assertions.length} checks · {s.durationMs} ms</summary><pre>{JSON.stringify(s, null, 2)}</pre></details>) ?? <p className="muted">The Verifier writes structured scenarios without Builder code.</p>}</> : tab === 'Traces' ? <>{run?.evidence?.results.map(r => <details key={r.scenarioId}><summary>{r.scenarioId} · {r.trace.length} GPIO changes · {r.checks.filter(c => c.passed).length}/{r.checks.length} passed</summary>{r.checks.map(c => <p key={c.id} className={c.passed ? 'pass' : 'fail'}>{c.passed ? 'PASS' : 'FAIL'} · {c.id} — {c.message}</p>)}<pre>{r.trace.map(p => `${p.atMs.toFixed(4).padStart(11)} ms  ${p.signal.padEnd(18)} ${p.value}  ${p.mode}`).join('\n')}</pre></details>) ?? <p className="muted">No authoritative trace has been recorded.</p>}</> : <><p>Evidence binds source, circuit, compiled HEX, requirements, and tests with SHA-256. Live interaction does not change the recorded result.</p><pre>{run?.evidence ? JSON.stringify({ status: run.status, hashes: run.evidence.hashes, simulator: run.evidence.simulatorVersion, checkedAt: run.evidence.createdAt, checks: run.evidence.expectedCheckIds.length }, null, 2) : 'No verification evidence yet.'}</pre></>}</div></section>
    <footer>Integration harness · local artifacts · no physical hardware claim<span>AVR8js + Arduino CLI</span></footer>
  </main>;
}
