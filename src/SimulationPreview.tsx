import { useEffect, useMemo, useRef, useState } from 'react';
import { buildSimulationDocument, SIMULATION_MESSAGE_CHANNEL, type SimulationHostCommand, type SimulationSnapshot } from '../shared/simulation-runtime';
import type { SimulationRun } from '../shared/simulation-run';
import type { SimulationScalar } from '../shared/simulation-types';

const keyName = (key?: string) => key?.toLowerCase() === 'space' || key === ' ' ? 'Space' : ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' })[key ?? ''] ?? key?.toUpperCase();
const normalizeKey = (key: string) => key.toLowerCase() === 'space' ? ' ' : key.toLowerCase();

export function SimulationPreview({ run }: { run: SimulationRun }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const request = useRef(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<SimulationSnapshot>({ state: {}, timeMs: 0, running: false });
  const spec = run.spec!;
  // Hardware repairs can replace a candidate without creating a new revision.
  // Compare artifact content, while ordinary status polling leaves playback intact.
  const artifactIdentity = JSON.stringify([run.id, spec, run.candidate]);
  const source = useMemo(() => buildSimulationDocument({ spec, candidate: run.candidate! }), [artifactIdentity]);
  const command = (value: SimulationHostCommand) => frame.current?.contentWindow?.postMessage({ channel: SIMULATION_MESSAGE_CHANNEL, type: 'command', requestId: ++request.current, command: value }, '*');
  useEffect(() => { setReady(false); setError(''); setSnapshot({ state: {}, timeMs: 0, running: false }); }, [source]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== SIMULATION_MESSAGE_CHANNEL) return;
      const data = event.data;
      if (data.type === 'error') { setError(String(data.message ?? 'The simulation stopped.').slice(0, 2000)); setReady(false); }
      if (['ready', 'state', 'response'].includes(data.type)) {
        const value = data.result ?? data.snapshot ?? data;
        if (value.state && typeof value.state === 'object' && Number.isFinite(value.timeMs)) {
          setSnapshot({ state: value.state, timeMs: value.timeMs, running: Boolean(value.running), inputs: value.inputs }); setReady(true);
        }
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const held = new Set<string>();
    const keys = spec.controls.filter(control => control.type === 'key');
    const down = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"]'))) return;
      const control = keys.find(control => normalizeKey(control.key!) === normalizeKey(event.key));
      if (control) { event.preventDefault(); held.add(control.id); command({ type: 'input', id: control.id, value: true }); }
    };
    const up = (event: KeyboardEvent) => {
      const control = keys.find(control => normalizeKey(control.key!) === normalizeKey(event.key));
      if (control && held.delete(control.id)) { event.preventDefault(); command({ type: 'input', id: control.id, value: false }); }
    };
    const release = () => { for (const id of held) command({ type: 'input', id, value: false }); held.clear(); };
    const visibility = () => { if (document.hidden) release(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', release); document.addEventListener('visibilitychange', visibility);
    return () => { release(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility); };
  }, [ready, artifactIdentity]);
  const input = (id: string, value: SimulationScalar) => command({ type: 'input', id, value });
  return <>
    <div className="sim-preview-toolbar">
      <div><h2>{spec.title}</h2><span>{ready ? `${(snapshot.timeMs / 1000).toFixed(1)} s` : error ? 'Stopped' : 'Loading model…'}</span></div>
      <div className="sim-playback"><button disabled={!ready} onClick={() => command({ type: snapshot.running ? 'pause' : 'play' })}>{snapshot.running ? 'Pause' : 'Play'}</button><button disabled={!ready} onClick={() => command({ type: 'reset' })}>Reset</button></div>
    </div>
    <iframe ref={frame} className="sim-frame" title={spec.title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={source}/>
    {error && <div role="alert" className="sim-runtime-error">{error} Add a follow-up request to revise this simulation.</div>}
    <div className="sim-live-values" aria-label="Live measurements">{spec.observables.map(observable => {
      const value = snapshot.state[observable.id];
      return <div key={observable.id}><span>{observable.label}</span><strong>{typeof value === 'number' ? Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : typeof value === 'boolean' ? value ? 'Yes' : 'No' : value ?? '—'}{observable.unit && <small> {observable.unit}</small>}</strong></div>;
    })}</div>
    {spec.controls.length > 0 && <div className="sim-controls-panel"><h3>Explore the model</h3><div className="sim-control-grid">{spec.controls.map(control => {
      const value = snapshot.inputs?.[control.id] ?? control.initial;
      return <div className={`sim-control control-${control.type}`} key={control.id}>
        {control.type === 'range' ? <><label htmlFor={`control-${control.id}`}>{control.label}<output>{String(value)}</output></label><input id={`control-${control.id}`} type="range" min={control.min} max={control.max} step={control.step ?? 'any'} disabled={!ready} value={Number(value)} onChange={event => input(control.id, Number(event.target.value))}/></>
        : control.type === 'toggle' ? <label><input type="checkbox" disabled={!ready} checked={Boolean(value)} onChange={event => input(control.id, event.target.checked)}/>{control.label}</label>
        : control.type === 'select' ? <><label htmlFor={`control-${control.id}`}>{control.label}</label><select id={`control-${control.id}`} disabled={!ready} value={String(value)} onChange={event => input(control.id, event.target.value)}>{control.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></>
        : control.type === 'button' ? <button disabled={!ready} onClick={() => input(control.id, true)}>{control.label}</button>
        : <button disabled={!ready} aria-pressed={Boolean(value)}
            onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); input(control.id, true); }}
            onPointerUp={() => input(control.id, false)} onPointerCancel={() => input(control.id, false)} onLostPointerCapture={() => input(control.id, false)}
            onKeyDown={event => { if (!event.repeat && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); const target = spec.controls.find(item => item.type === 'key' && normalizeKey(item.key!) === normalizeKey(event.key)) ?? control; input(target.id, true); } }}
            onKeyUp={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); const target = spec.controls.find(item => item.type === 'key' && normalizeKey(item.key!) === normalizeKey(event.key)) ?? control; input(target.id, false); } }} onBlur={() => { for (const keyControl of spec.controls.filter(item => item.type === 'key')) input(keyControl.id, false); }}><kbd>{keyName(control.key)}</kbd>{control.label}</button>}
      </div>;
    })}</div></div>}
  </>;
}
