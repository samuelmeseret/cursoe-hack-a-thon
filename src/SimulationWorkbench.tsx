import { useEffect, useRef, useState, type FormEvent } from 'react';
import { simulationTerminal, type SimulationRun } from '../shared/simulation-run';
import type { HealthResponse } from '../shared/types';
import { SimulationPreview } from './SimulationPreview';
import { HardwarePanel } from './HardwarePanel';
import './simulation-workbench.css';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const content = await response.json().catch(() => { throw new Error('The local API did not return a usable response.'); });
  if (!response.ok) throw new Error(content.error || `Request failed (${response.status}).`);
  return content;
}
const phaseLabel: Record<string, string> = { QUEUED: 'Starting', PLANNING: 'Defining the model', DESIGNING_TESTS: 'Designing checks', BUILDING: 'Writing the simulation', CHECKING: 'Checking behavior', READY: 'Ready to explore', DRAFT: 'Draft · behavior not verified', FAILED: 'Build needs a revision', CANCELLED: 'Build cancelled', STALE: 'Saved files changed' };
const hasPreview = (status: string) => ['READY', 'DRAFT'].includes(status);
const prepareControllerPrompt = 'Prepare this project for hardware by creating a portable controller and a separate visual environment that runs it. Preserve the existing device behavior, physics, controls and units. Remove any simulated export buttons or flags that claim a controller exists or hardware was exported; hardware export belongs to the application. Declare any missing physical drivers or interfaces explicitly. I will choose the board after the controller is ready.';

export function SimulationWorkbench() {
  const [prompt, setPrompt] = useState('');
  const [run, setRun] = useState<SimulationRun>();
  const [preview, setPreview] = useState<SimulationRun>();
  const [health, setHealth] = useState<HealthResponse>();
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [inspector, setInspector] = useState<'model' | 'checks' | 'source'>('model');
  const conversation = useRef<HTMLDivElement>(null);
  const currentRun = useRef<SimulationRun | undefined>(undefined);
  const currentPreview = useRef<SimulationRun | undefined>(undefined);
  const acceptPreview = (next?: SimulationRun) => { currentPreview.current = next; setPreview(next); };
  const acceptRun = (next: SimulationRun, replace = false) => {
    const current = currentRun.current;
    if (!replace && (!current || current.id !== next.id || next.events.length < current.events.length)) return;
    currentRun.current = next; setRun(next);
    // Refresh source and verification labels after an in-place hardware repair.
    // SimulationPreview keeps playback intact when the artifact content is unchanged.
    if (hasPreview(next.status)) acceptPreview(next);
    if (next.status === 'STALE' && currentPreview.current?.id === next.id) acceptPreview();
  };
  const active = starting || Boolean(run && !simulationTerminal(run.status));
  useEffect(() => {
    let alive = true;
    api<HealthResponse>('/api/health').then(value => { if (alive) setHealth(value); }).catch(reason => { if (alive) setError(reason.message); });
    const id = new URLSearchParams(location.search).get('simulation');
    if (id) api<SimulationRun>(`/api/simulations/${encodeURIComponent(id)}`).then(value => { if (alive && !currentRun.current) acceptRun(value, true); }).catch(reason => { if (alive) setError(reason.message); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!run?.id) return;
    const id = run.id;
    let alive = true;
    const refresh = () => api<SimulationRun>(`/api/simulations/${id}`).then(next => {
      if (!alive) return;
      acceptRun(next);
    }).catch(reason => { if (alive) setError(reason.message); });
    const events = new EventSource(`/api/simulations/${id}/events`);
    events.addEventListener('simulation-event', refresh);
    const poll = window.setInterval(refresh, 4000);
    return () => { alive = false; events.close(); clearInterval(poll); };
  }, [run?.id]);
  useEffect(() => {
    if (!run?.parentId || hasPreview(run.status) || preview) return;
    const id = run.id;
    let alive = true;
    const restore = async () => {
      let parentId: string | undefined = run.parentId;
      const visited = new Set([id]);
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const ancestor = await api<SimulationRun>(`/api/simulations/${encodeURIComponent(parentId)}`);
        if (!alive || currentRun.current?.id !== id || hasPreview(currentRun.current.status) || currentPreview.current) return;
        if (hasPreview(ancestor.status) && ancestor.spec && ancestor.candidate) { acceptPreview(ancestor); return; }
        parentId = ancestor.parentId;
      }
    };
    void restore().catch(reason => { if (alive && currentRun.current?.id === id) setError(`The previous simulation could not be restored: ${reason.message}`); });
    return () => { alive = false; };
  }, [run?.id, run?.status, preview?.id]);
  useEffect(() => {
    if (!preview || preview.id === run?.id) return;
    const id = preview.id;
    let alive = true;
    const refresh = () => api<SimulationRun>(`/api/simulations/${encodeURIComponent(id)}`).then(next => {
      const current = currentPreview.current;
      if (!alive || current?.id !== id || next.events.length < current.events.length) return;
      // An ancestor is retained only while the API still considers its saved
      // artifacts intact; delayed responses cannot recreate a removed preview.
      if (!hasPreview(next.status)) acceptPreview();
      else acceptPreview(next);
    }).catch(reason => { if (alive) setError(reason.message); });
    const events = new EventSource(`/api/simulations/${id}/events`);
    events.addEventListener('simulation-event', refresh);
    const poll = window.setInterval(refresh, 4000);
    return () => { alive = false; events.close(); clearInterval(poll); };
  }, [preview?.id, run?.id]);
  useEffect(() => { conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: 'instant' }); }, [run?.messages.length, run?.events.length]);
  const startRevision = async (request: string, clearPrompt = false) => {
    if (active || request.trim().length < 5) return;
    setStarting(true); setError('');
    try {
      const next = await api<SimulationRun>('/api/simulations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: request.trim(), ...(run ? { previousId: run.id } : {}) }) });
      acceptRun(next, true); if (clearPrompt) setPrompt(''); history.replaceState(null, '', `?simulation=${next.id}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setStarting(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void startRevision(prompt, true);
  };
  const newSimulation = () => { currentRun.current = undefined; setRun(undefined); acceptPreview(); setPrompt(''); setError(''); history.replaceState(null, '', location.pathname); document.getElementById('simulation-prompt')?.focus(); };
  const inspected = run ?? preview;
  const verification = inspected?.evidence ?? inspected?.attempts.at(-1)?.verification;
  const checks = preview?.evidence?.results.flatMap(result => result.checks) ?? [];
  return <main className="simulation-workbench">
    <header className="sim-header"><div><h1>Simulation Lab<span className="accent">.</span></h1><p className="sim-project-subtitle">Describe it. Simulate it. Build it for your hardware.</p></div><div className="sim-header-actions">{run?.projectId && <span className="sim-project-revision">Project {run.projectId.slice(0, 8)} · revision {run.revision ?? 1}</span>}<span className="sim-connection"><i className={health?.keyConfigured ? 'connected' : ''}/>{health ? health.keyConfigured ? 'Live Crusoe agents' : 'API key needed' : 'Connecting…'}</span></div></header>
    <div className="sim-layout">
      <section className="sim-conversation" aria-label="Simulation conversation">
        <div className="sim-conversation-heading"><h2>Your brief</h2><button disabled={active || !run} onClick={newSimulation}>New simulation</button></div>
        <div className="sim-messages" ref={conversation}>
          {!run ? <div className="sim-introduction"><span className="sim-index">01</span><h2>What do you want<br/>to explore?</h2><p>Describe a system, experiment, game, or process. The agents create its model, scene, and controls from your request.</p><p className="muted">For hardware projects, choose your board after simulating. Follow-up changes stay in the same project.</p></div>
          : <>{run.messages.map((message, index) => <article className={`sim-message from-${message.role}`} key={index}><span>{message.role === 'user' ? 'YOU' : 'SIMULATION AGENTS'}</span><p>{message.content}</p></article>)}
            <div className="sim-build-status" role="status"><span className={active ? 'sim-working' : ''}/><strong>{phaseLabel[run.status]}</strong></div>
            <ol className="sim-build-events">{run.events.map(event => <li key={event.sequence}><span>{String(event.sequence).padStart(2, '0')}</span><p>{event.message}</p></li>)}</ol>
            {run.error && <p className="sim-build-error">{run.error}</p>}
            {run.warning && <p className="sim-build-warning">{run.warning}</p>}
          </>}
        </div>
        <form className="sim-composer" onSubmit={submit}>
          <label htmlFor="simulation-prompt">{run ? 'Continue the conversation' : 'Describe your simulation'}</label>
          <textarea id="simulation-prompt" value={prompt} maxLength={5000} onChange={event => setPrompt(event.target.value)} rows={4} placeholder={run ? 'Change the behavior, add an interaction, or refine the model…' : 'What should happen? What should you be able to control?'} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/>
          <div><small>⌘ / Ctrl + Enter to send</small>{active ? <button type="button" disabled={!run || starting} onClick={() => run && api<SimulationRun>(`/api/simulations/${run.id}/cancel`, { method: 'POST' }).then(next => acceptRun(next)).catch(reason => setError(reason.message))}>{starting ? 'Starting…' : 'Cancel build'}</button> : <button className="primary" disabled={prompt.trim().length < 5} type="submit">{run ? 'Update simulation' : 'Build simulation'} <span>↗</span></button>}</div>
        </form>
        {error && <div role="alert" className="sim-build-error">{error}</div>}
      </section>
      <section className="sim-experiment" aria-label="Interactive simulation">
        {preview?.candidate && preview.spec ? <><SimulationPreview key={preview.id} run={preview}/><div className="sim-preview-caption"><span>{run?.id !== preview.id ? `Previous ${preview.status === 'READY' ? 'version' : 'draft'} · latest build: ${phaseLabel[run?.status ?? 'QUEUED'].toLowerCase()}` : preview.status === 'READY' ? `${checks.length} behavior checks passed · generated model` : 'Generated draft · runs in the browser · behavior not verified'}</span><a href={`/api/simulations/${preview.id}/artifacts`}>Download {run?.id !== preview.id ? 'previous version' : 'simulation files'} ↓</a></div></>
        : <div className={`sim-empty-scene ${active ? 'is-building' : ''}`}><div className="sim-crosshair" aria-hidden="true"><i/><b/></div><span className="sim-index">02 / SIMULATION</span><h2>{run ? phaseLabel[run.status] : starting ? 'Starting' : 'Room for your idea.'}</h2><p>{run?.error ?? (active ? 'The agents are generating and testing this model. Its interactive scene will appear here.' : 'Your prompt determines what gets built. Models, visuals, and interactions are generated for each project.')}</p></div>}
        {inspected?.spec && <div className="sim-inspector"><nav aria-label="Simulation details">{(['model', 'checks', 'source'] as const).map(tab => <button key={tab} aria-pressed={inspector === tab} onClick={() => setInspector(tab)}>{tab === 'model' ? 'Model & assumptions' : tab === 'checks' ? 'Behavior checks' : 'Generated source'}</button>)}</nav>
          <div>{inspected.status !== 'READY' && <p className="muted">Current build · {phaseLabel[inspected.status]}</p>}{inspector === 'model' ? <><p>{inspected.spec.summary}</p>{inspected.spec.assumptions.length > 0 && <ul>{inspected.spec.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul>}<details><summary>Expected behavior</summary>{inspected.spec.requirements.map(requirement => <p key={requirement.id}><code>{requirement.id}</code>{requirement.text}</p>)}</details></>
          : inspector === 'checks' ? <>{verification?.error && <p className="fail">{verification.error}</p>}{verification?.results.map(result => <details key={result.scenarioId}><summary>{result.name} · {result.checks.filter(check => check.passed).length}/{result.checks.length}</summary>{result.error && <p className="fail">{result.error}</p>}{result.checks.map(check => <p className={check.passed ? 'pass' : 'fail'} key={check.id}>{check.passed ? 'PASS' : 'FAIL'} · {check.message}</p>)}</details>)}{!verification && <p>{inspected.status === 'DRAFT' ? `Behavior checks could not be completed. ${inspected.warning ?? ''}` : 'Checks have not run for this build yet.'}</p>}<small>These checks exercise the generated model; they do not establish real-world accuracy.</small></>
          : inspected.candidate?.controller ? <><details open><summary>Shared controller · simulation and firmware</summary><pre>{JSON.stringify(inspected.candidate.controller, null, 2)}</pre></details><details><summary>Visual environment</summary><pre>{inspected.candidate.environmentSource}</pre></details></> : <pre>{inspected.candidate?.source}</pre>}</div>
        </div>}
        {run && <HardwarePanel key={run.id} run={run} busy={active} onPrepareController={() => void startRevision(prepareControllerPrompt)}/>}
      </section>
    </div>
    <footer>Describe → simulate → choose hardware → configure → build/check → export<span>Physical testing is reported separately</span></footer>
  </main>;
}
