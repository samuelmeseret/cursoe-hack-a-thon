import { useEffect, useRef, useState } from 'react';
import type { Circuit, SimulatorCommand, TracePoint } from '../shared/types';
import { motorState } from '../shared/motion';
import './project-simulation.css';

type Control = NonNullable<Circuit['serial']>['controls'][number];
const keyLabel = (key: string) => ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': 'Space' })[key] ?? key.toUpperCase();

export function SerialControls({ config, enabled, send }: { config: Circuit['serial']; enabled: boolean; send: (message: SimulatorCommand) => void }) {
  const [held, setHeld] = useState<string[]>([]);
  const active = useRef(new Map<string, Control>());
  const sendRef = useRef(send);
  sendRef.current = send;
  const configKey = JSON.stringify(config);
  const press = (control: Control) => {
    if (!enabled || active.current.has(control.key)) return;
    active.current.set(control.key, control);
    setHeld([...active.current.keys()]);
    sendRef.current({ type: 'serial', data: control.data });
  };
  const release = (control: Control) => {
    if (!active.current.delete(control.key)) return;
    // A shared stop command releases the whole group, including its visual state.
    if (control.releaseData) for (const [key, heldControl] of active.current) {
      if (heldControl.releaseData === control.releaseData) active.current.delete(key);
    }
    setHeld([...active.current.keys()]);
    if (control.releaseData) sendRef.current({ type: 'serial', data: control.releaseData });
  };
  useEffect(() => {
    const releaseAll = () => {
      const commands = new Set([...active.current.values()].flatMap(control => control.releaseData ? [control.releaseData] : []));
      active.current.clear();
      setHeld([]);
      commands.forEach(data => sendRef.current({ type: 'serial', data }));
    };
    if (!config || !enabled) { releaseAll(); return; }
    const keydown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      const control = config.controls.find(entry => entry.key.toLowerCase() === event.key.toLowerCase());
      if (control) { event.preventDefault(); press(control); }
    };
    const keyup = (event: KeyboardEvent) => {
      const control = config.controls.find(entry => entry.key.toLowerCase() === event.key.toLowerCase());
      if (control && active.current.has(control.key)) { event.preventDefault(); release(control); }
    };
    const visibility = () => { if (document.hidden) releaseAll(); };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', visibility);
      releaseAll();
    };
  }, [configKey, enabled]);
  if (!config) return null;
  return <div className="keyboard-controls">
    <p>{enabled ? 'Use your keyboard or the controls below.' : 'Start the simulator to use the keyboard controls.'}</p>
    <div className="toolbar">{config.controls.map(control => <button key={control.key} disabled={!enabled} aria-pressed={held.includes(control.key)}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); press(control); }}
      onPointerUp={() => release(control)} onPointerCancel={() => release(control)} onLostPointerCapture={() => release(control)}
      onKeyDown={event => { if (['Enter', ' '].includes(event.key) && !event.repeat) { event.preventDefault(); event.stopPropagation(); press(config.controls.find(entry => entry.key.toLowerCase() === event.key.toLowerCase()) ?? control); } }}
      onKeyUp={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); release(config.controls.find(entry => entry.key.toLowerCase() === event.key.toLowerCase()) ?? control); } }} onBlur={() => release(control)}>
      <kbd>{keyLabel(control.key)}</kbd><span>{control.label}</span>{control.releaseData && <small>Hold</small>}
    </button>)}</div>
  </div>;
}

export function MotorSignals({ circuit, signals }: { circuit: Circuit; signals: Record<string, TracePoint> }) {
  return <>{circuit.components.filter(component => component.kind === 'motor').map(component => <div className={`door motor ${motorState(signals, component.id)}`} key={component.id}>
    <strong>{component.label}</strong><span>{motorState(signals, component.id)}</span><small>H-bridge · D{component.pin} / D{component.reversePin}</small>
  </div>)}</>;
}

export function VehicleView({ driveMs, direction, running }: { driveMs: number; direction: number; running: boolean }) {
  const worldPosition = driveMs / 12;
  const carPosition = Math.max(-140, Math.min(140, worldPosition));
  return <div className="vehicle-view" aria-label="Vehicle simulation">
    <div className="vehicle-heading"><strong>{!running ? 'Simulator paused' : direction > 0 ? 'Forward →' : direction < 0 ? '← Reverse' : 'Stopped'}</strong><span>Motor-driven simulation</span></div>
    <div className="vehicle-scene" data-drive-ms={driveMs.toFixed(3)} data-direction={direction}>
      <div className="vehicle-road" style={{ backgroundPositionX: carPosition - worldPosition }}/>
      <div className="mini-car" style={{ transform: `translateX(${carPosition}px)` }} aria-hidden="true">
        <div className="car-cabin"><i/></div><div className="car-body"><i/><b/></div>
        <div className="car-wheel back" style={{ transform: `rotate(${driveMs / 8}deg)` }}/><div className="car-wheel front" style={{ transform: `rotate(${driveMs / 8}deg)` }}/>
      </div>
    </div>
    <p>Movement follows the compiled firmware’s motor signals. Travel is illustrative.</p>
  </div>;
}
