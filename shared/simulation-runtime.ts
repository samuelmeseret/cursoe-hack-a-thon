import { composeControllerSimulation } from './portable-controller';
/**
 * Shared browser execution boundary. Generated JavaScript only runs in a disposable
 * Worker inside an opaque sandboxed iframe. The verifier loads this exact document.
 */
import type { SimulationArtifact, SimulationControl, SimulationObservable, SimulationScalar, SimulationSpec } from './simulation-types';

export const SIMULATION_RUNTIME_VERSION = 'portable-controller-canvas-worker-v4';
export const SIMULATION_MESSAGE_CHANNEL = 'generated-simulation';
export type SimulationValue = SimulationScalar;
export interface SimulationSnapshot { state: Record<string, SimulationValue>; timeMs: number; running: boolean; inputs?: Record<string, SimulationValue> }
export type SimulationHostCommand =
  | { type: 'reset' | 'snapshot' | 'play' | 'pause' }
  | { type: 'input'; id: string; value: SimulationValue }
  | { type: 'advance'; durationMs: number }
  | { type: 'resize'; width: number; height: number };

interface SimulationModel {
  reset(): void;
  step(dtSeconds: number): void;
  input(id: string, value: SimulationValue): void;
  snapshot(): Record<string, SimulationValue>;
  draw(context: OffscreenCanvasRenderingContext2D, width: number, height: number): void;
}

/** This function is serialized into the Worker; keep it self-contained. */
function workerRuntime(createModel: () => SimulationModel) {
  const reply = self.postMessage.bind(self);
  let model: SimulationModel;
  let canvas: OffscreenCanvas;
  let context: OffscreenCanvasRenderingContext2D;
  let readPixels: OffscreenCanvasRenderingContext2D['getImageData'];
  let timeMs = 0;
  let timeSeconds = 0;
  let controls: SimulationControl[] = [];
  let observables: SimulationObservable[] = [];
  let width = 960;
  let height = 540;
  // The iframe CSP also blocks outbound requests. Nested workers and code loading
  // are unnecessary for the generated model and are disabled explicitly.
  for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'importScripts', 'setTimeout', 'setInterval']) {
    Object.defineProperty(self, key, { value: () => { throw new Error('Network access and external code are unavailable in simulations'); }, writable: false, configurable: false });
  }
  Object.defineProperty(Math, 'random', { value: () => { throw new Error('Math.random is nondeterministic; use a fixed-seed generator and restore its seed in reset()'); }, writable: false, configurable: false });
  const wallClock = () => { throw new Error('Wall-clock time is unavailable; keep model time locally and advance it with step(dt)'); };
  Object.defineProperty(self, 'Date', { value: Object.assign(function () { wallClock(); }, { now: wallClock, parse: wallClock, UTC: wallClock }), writable: false, configurable: false });
  Object.defineProperty(self, 'performance', { value: Object.freeze({ now: wallClock }), writable: false, configurable: false });
  const snapshot = () => {
    const state = model.snapshot();
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('snapshot() must return a JSON object');
    for (const observable of observables) {
      if (!Object.prototype.hasOwnProperty.call(state, observable.id)) throw new Error(`Missing observable: ${observable.id}`);
      if (typeof state[observable.id] !== observable.type) throw new Error(`Observable ${observable.id} must be ${observable.type}`);
    }
    for (const [id, value] of Object.entries(state)) {
      if (!['number', 'boolean', 'string'].includes(typeof value)) throw new Error(`Observable ${id} must be a number, boolean, or string`);
    }
    let count = 0;
    const validate = (value: unknown, depth: number): void => {
      if (++count > 20000 || depth > 20) throw new Error('Simulation snapshot exceeds the state size limit');
      if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
      if (typeof value === 'number' && Number.isFinite(value)) return;
      if (Array.isArray(value)) { for (const item of value) validate(item, depth + 1); return; }
      if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
        for (const item of Object.values(value)) validate(item, depth + 1);
        return;
      }
      throw new Error('Simulation state must contain only finite JSON values');
    };
    validate(state, 0);
    const json = JSON.stringify(state);
    if (json.length > 256000) throw new Error('Simulation snapshot exceeds 256 KB');
    return { state: JSON.parse(json), timeMs };
  };
  const draw = (requireVisibleOutput: boolean) => {
    context.save();
    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      model.draw(context, width, height);
    } finally { context.restore(); }
    if (requireVisibleOutput) {
      const pixels = readPixels(0, 0, width, height).data;
      let visible = false;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] !== 0) { visible = true; break; }
      }
      if (!visible) throw new Error('draw() produced an empty canvas; render the simulated project');
    }
  };
  self.onmessage = (event: MessageEvent) => {
    const { requestId, command } = event.data;
    try {
      if (command.type === 'init') {
        canvas = command.canvas;
        context = canvas.getContext('2d')!;
        if (!context) throw new Error('A 2D canvas context is unavailable');
        readPixels = context.getImageData.bind(context);
        width = canvas.width;
        height = canvas.height;
        controls = command.controls;
        observables = command.observables;
        model = createModel();
        for (const name of ['reset', 'step', 'input', 'snapshot', 'draw'] as const) {
          if (!model || typeof model[name] !== 'function') throw new Error(`createSimulation() must return ${name}()`);
        }
        model.reset();
        for (const control of controls) model.input(control.id, control.initial);
      } else if (!model) throw new Error('Simulation has not initialized');
      else if (command.type === 'reset') { timeMs = 0; timeSeconds = 0; model.reset(); for (const control of controls) model.input(control.id, control.initial); }
      else if (command.type === 'input') model.input(command.id, command.value);
      else if (command.type === 'advance') {
        if (!Number.isFinite(command.durationMs) || command.durationMs < 0 || command.durationMs > 120000) throw new Error('Advance must be between 0 and 120000 milliseconds');
        const targetMs = timeMs + command.durationMs;
        const targetSeconds = targetMs / 1000;
        // Derive deltas from one absolute clock. Summing separately converted
        // millisecond chunks can leave model time just short of an event boundary
        // (e.g. 6.999999999999977 instead of 7). The final delta lands exactly on
        // the requested endpoint, including when advancement is split by inputs.
        while (timeSeconds < targetSeconds) {
          const nextSeconds = Math.min(timeSeconds + 1 / 60, targetSeconds);
          model.step(nextSeconds - timeSeconds);
          timeSeconds = nextSeconds;
        }
        timeMs = targetMs;
      } else if (command.type === 'resize') {
        width = Math.max(1, Math.min(2048, Math.round(command.width)));
        height = Math.max(1, Math.min(2048, Math.round(command.height)));
        canvas.width = width;
        canvas.height = height;
      } else if (command.type !== 'snapshot') throw new Error('Unknown simulation command');
      draw(command.type !== 'advance' || command.durationMs >= 100);
      reply({ requestId, result: snapshot() });
    } catch (error) {
      reply({ requestId, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** This function is serialized into the trusted iframe shell; keep it self-contained. */
function documentRuntime(workerSource: string, spec: SimulationSpec, standalone: boolean) {
  const channel = 'generated-simulation';
  const { controls, observables } = spec;
  const canvas = document.getElementById('simulation-canvas') as HTMLCanvasElement;
  const errorElement = document.getElementById('simulation-error')!;
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);
  URL.revokeObjectURL(workerUrl);
  let requestSequence = 0;
  let failed: Error | undefined;
  let running = false;
  let lastFrame = 0;
  let animationFrame = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let current: SimulationSnapshot = { state: {}, timeMs: 0, running: false };
  let inputs: Record<string, SimulationValue> = Object.fromEntries(controls.map(control => [control.id, control.initial]));
  let updateUI = () => {};
  const pending = new Map<number, { resolve: (value: SimulationSnapshot) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const publish = (type: string, details: object = {}) => {
    updateUI();
    if (window.parent !== window) window.parent.postMessage({ channel, type, ...details }, '*');
  };
  const stop = () => { running = false; cancelAnimationFrame(animationFrame); };
  const fail = (message: string) => {
    if (failed) return;
    failed = new Error(message);
    stop();
    if (heartbeat) clearInterval(heartbeat);
    worker.terminate();
    errorElement.textContent = message;
    errorElement.hidden = false;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failed); }
    pending.clear();
    publish('error', { message });
  };
  worker.onerror = (event) => { event.preventDefault(); fail(event.message || 'Generated simulation could not start'); };
  worker.onmessage = (event) => {
    const request = pending.get(event.data?.requestId);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(event.data.requestId);
    if (event.data.error) { request.reject(new Error(event.data.error)); fail(event.data.error); return; }
    if (!event.data.result || typeof event.data.result.state !== 'object' || typeof event.data.result.timeMs !== 'number') {
      request.reject(new Error('Invalid simulation response')); fail('Invalid simulation response'); return;
    }
    current = { ...event.data.result, running, inputs: { ...inputs } };
    request.resolve(current);
  };
  const send = (command: object, transfer: Transferable[] = []): Promise<SimulationSnapshot> => {
    if (failed) return Promise.reject(failed);
    return new Promise((resolve, reject) => {
      const requestId = ++requestSequence;
      const timer = setTimeout(() => fail('Simulation stopped: a command exceeded the 3 second execution limit'), 3000);
      pending.set(requestId, { resolve, reject, timer });
      try { worker.postMessage({ requestId, command }, transfer); }
      catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });
  };
  const advanceFrame = async (timestamp: number) => {
    if (!running || failed) return;
    const durationMs = lastFrame ? Math.min(50, Math.max(0, timestamp - lastFrame)) : 1000 / 60;
    lastFrame = timestamp;
    try {
      await send({ type: 'advance', durationMs });
      publish('state', current);
      if (running) animationFrame = requestAnimationFrame(advanceFrame);
    } catch { /* fail() publishes the error and terminates the Worker. */ }
  };
  const offscreen = canvas.transferControlToOffscreen();
  const ready = send({ type: 'init', canvas: offscreen, controls, observables }, [offscreen]).then((result) => {
    heartbeat = setInterval(() => {
      if (!running && !pending.size && !failed) void send({ type: 'snapshot' }).catch(() => {});
    }, 1000);
    publish('ready', result);
    return result;
  });
  // Consumers can await ready; attach a handler so a bad generated program never
  // creates an unhandled rejection in the containing application.
  void ready.catch(() => {});
  let queue = Promise.resolve();
  const command = (command: SimulationHostCommand): Promise<SimulationSnapshot> => {
    const operation = queue.then(async () => {
      await ready;
      if (failed) throw failed;
      if (command.type === 'input') {
        const control = controls.find(control => control.id === command.id);
        if (!control) throw new Error(`Unknown control: ${command.id}`);
        if (typeof command.value !== typeof control.initial) throw new Error(`Invalid value type for control: ${command.id}`);
        if (typeof command.value === 'number' && (!Number.isFinite(command.value) || (control.type === 'range' && (command.value < control.min! || command.value > control.max!)))) throw new Error(`Control value is outside its range: ${command.id}`);
        if (control.type === 'select' && !control.options?.some(option => option.value === command.value)) throw new Error(`Invalid option for control: ${command.id}`);
        inputs[command.id] = command.value;
      }
      if (command.type === 'reset') inputs = Object.fromEntries(controls.map(control => [control.id, control.initial]));
      if (command.type === 'play') {
        if (!running) { running = true; lastFrame = 0; animationFrame = requestAnimationFrame(advanceFrame); }
        current = { ...current, running };
      } else if (command.type === 'pause') {
        stop();
        held.clear();
        for (const control of controls) {
          if ((control.type === 'key' || control.type === 'button') && inputs[control.id] === true) {
            inputs[control.id] = false;
            await send({ type: 'input', id: control.id, value: false });
          }
        }
        current = { ...await send({ type: 'snapshot' }), running: false };
      } else {
        if (command.type === 'reset') held.clear();
        if (command.type === 'reset' || command.type === 'advance') stop();
        current = await send(command);
      }
      publish('state', current);
      return current;
    });
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  };
  Object.defineProperty(window, 'simulationHost', { value: { ready, command }, writable: false, configurable: false });
  const safeCommand = (requested: SimulationHostCommand) => { void command(requested).catch(() => {}); };
  const held = new Set<string>();
  const normalizeKey = (key: string) => key.toLowerCase() === 'space' ? ' ' : key.toLowerCase();
  const releaseKeys = () => {
    for (const id of held) safeCommand({ type: 'input', id, value: false });
    held.clear();
  };
  window.addEventListener('keydown', event => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.matches('input,select,textarea,[contenteditable="true"]')) return;
    const control = controls.find(control => control.type === 'key' && normalizeKey(control.key ?? '') === normalizeKey(event.key));
    if (!control || held.has(control.id)) return;
    event.preventDefault();
    held.add(control.id);
    safeCommand({ type: 'input', id: control.id, value: true });
  });
  window.addEventListener('keyup', event => {
    const control = controls.find(control => control.type === 'key' && normalizeKey(control.key ?? '') === normalizeKey(event.key));
    if (!control || !held.delete(control.id)) return;
    event.preventDefault();
    safeCommand({ type: 'input', id: control.id, value: false });
  });
  window.addEventListener('blur', releaseKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseKeys(); });
  if (standalone) {
    document.body.classList.add('standalone');
    const toolbar = document.createElement('section');
    toolbar.className = 'simulation-toolbar';
    const title = document.createElement('strong');
    title.textContent = spec.title;
    toolbar.append(title);
    const playback = document.createElement('button');
    playback.textContent = 'Play';
    playback.onclick = () => safeCommand({ type: running ? 'pause' : 'play' });
    toolbar.append(playback);
    const reset = document.createElement('button');
    reset.textContent = 'Reset';
    reset.onclick = () => { releaseKeys(); safeCommand({ type: 'reset' }); };
    toolbar.append(reset);
    const controlUI: (() => void)[] = [];
    for (const control of controls) {
      // A button inside an implicit label can acquire a circular label relation
      // and lose its accessible name. Only inputs/selects need a label wrapper.
      const label = document.createElement(control.type === 'button' || control.type === 'key' ? 'span' : 'label');
      const text = document.createElement('span');
      text.textContent = control.label;
      label.append(text);
      if (control.type === 'range') {
        const input = document.createElement('input');
        input.type = 'range'; input.min = String(control.min); input.max = String(control.max); input.step = String(control.step ?? 'any');
        input.value = String(control.initial);
        input.oninput = () => safeCommand({ type: 'input', id: control.id, value: Number(input.value) });
        const output = document.createElement('output');
        label.append(input, output);
        controlUI.push(() => { input.value = String(inputs[control.id]); output.value = String(inputs[control.id]); });
      } else if (control.type === 'toggle') {
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(control.initial);
        input.onchange = () => safeCommand({ type: 'input', id: control.id, value: input.checked });
        label.append(input);
        controlUI.push(() => { input.checked = Boolean(inputs[control.id]); });
      } else if (control.type === 'select') {
        const select = document.createElement('select');
        for (const option of control.options ?? []) { const element = document.createElement('option'); element.value = option.value; element.textContent = option.label; select.append(element); }
        select.value = String(control.initial);
        select.onchange = () => safeCommand({ type: 'input', id: control.id, value: select.value });
        label.append(select);
        controlUI.push(() => { select.value = String(inputs[control.id]); });
      } else {
        const button = document.createElement('button');
        button.textContent = control.type === 'key' ? `${control.label} (${control.key === ' ' ? 'Space' : control.key})` : control.label;
        const keyboardTargets = new Map<string, string>();
        button.onpointerdown = event => { button.setPointerCapture(event.pointerId); held.add(control.id); safeCommand({ type: 'input', id: control.id, value: true }); };
        const release = () => { held.delete(control.id); safeCommand({ type: 'input', id: control.id, value: false }); };
        button.onpointerup = release; button.onpointercancel = release; button.onlostpointercapture = release;
        button.onkeydown = event => {
          if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
            event.preventDefault(); event.stopPropagation();
            const target = controls.find(item => item.type === 'key' && normalizeKey(item.key ?? '') === normalizeKey(event.key)) ?? control;
            keyboardTargets.set(event.key, target.id); held.add(target.id);
            safeCommand({ type: 'input', id: target.id, value: true });
          }
        };
        button.onkeyup = event => {
          const id = keyboardTargets.get(event.key);
          if (id) {
            event.preventDefault(); event.stopPropagation(); keyboardTargets.delete(event.key); held.delete(id);
            safeCommand({ type: 'input', id, value: false });
          }
        };
        button.onblur = () => {
          for (const id of keyboardTargets.values()) { held.delete(id); safeCommand({ type: 'input', id, value: false }); }
          keyboardTargets.clear();
          if (held.has(control.id)) release();
        };
        label.replaceChildren(button);
        controlUI.push(() => { button.setAttribute('aria-pressed', String(Boolean(inputs[control.id]))); });
      }
      toolbar.append(label);
    }
    const metrics = document.createElement('div'); metrics.className = 'simulation-metrics';
    updateUI = () => {
      playback.textContent = running ? 'Pause' : 'Play';
      playback.disabled = Boolean(failed);
      for (const update of controlUI) update();
      metrics.textContent = observables.map(observable => `${observable.label}: ${current.state[observable.id] ?? '—'}${observable.unit ? ` ${observable.unit}` : ''}`).join(' · ');
    };
    document.body.prepend(toolbar);
    document.body.append(metrics);
    updateUI();
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.channel !== channel || event.data.type !== 'command') return;
    const { requestId, command: requested } = event.data;
    void command(requested).then(
      (result) => publish('response', { requestId, result }),
      (error) => publish('response', { requestId, error: error instanceof Error ? error.message : String(error) }),
    );
  });
  window.addEventListener('pagehide', () => { stop(); if (heartbeat) clearInterval(heartbeat); worker.terminate(); });
}

const safeJSON = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Always embed as iframe srcDoc with sandbox="allow-scripts" (no same-origin). */
export function buildSimulationDocument(artifact: SimulationArtifact, { standalone = false }: { standalone?: boolean } = {}): string {
  // __name is inserted by tsx/esbuild when preserving function names. Supplying
  // the tiny helper keeps serialized functions portable in dev and production.
  const helper = 'const __name = (value) => value;';
  const source = artifact.candidate.controller && artifact.candidate.environmentSource
    ? composeControllerSimulation(artifact.candidate.controller, artifact.candidate.environmentSource) : artifact.candidate.source;
  const factory = `function () {\n"use strict";\n${source}\n; if (typeof createSimulation !== "function") throw new Error("Source must declare createSimulation()"); return createSimulation();\n}`;
  const workerSource = `${helper}\n(${workerRuntime.toString()})(${factory});`;
  const script = `${helper}\n(${documentRuntime.toString()})(${safeJSON(workerSource)}, ${safeJSON(artifact.spec)}, ${safeJSON(standalone)});`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-simulation-runtime' blob:; worker-src blob:; style-src 'unsafe-inline'; connect-src 'none'; img-src data: blob:; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f6f5f1}canvas{display:block;width:100%;height:100%;object-fit:contain}#simulation-error{position:absolute;inset:16px;align-content:center;padding:20px;background:#fff4ee;color:#8f321d;font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap;border:1px solid #e8baa8;border-radius:8px}#simulation-error[hidden]{display:none}.standalone{display:flex;flex-direction:column;font:14px/1.4 system-ui,sans-serif}.standalone canvas{flex:1;min-height:0}.simulation-toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:16px;background:white;border-bottom:1px solid #deded9}.simulation-toolbar strong{margin-right:auto}.simulation-toolbar label{display:flex;gap:8px;align-items:center}.simulation-toolbar button,.simulation-toolbar select{padding:6px 12px;border:1px solid #bdbdb6;border-radius:5px;background:white;color:#252521;font:inherit}.simulation-toolbar button[aria-pressed=true]{background:#e3eee3}.simulation-metrics{padding:12px 16px;background:white;border-top:1px solid #deded9}</style></head><body><canvas id="simulation-canvas" width="960" height="540" aria-label="Generated project simulation"></canvas><div id="simulation-error" role="alert" hidden></div><script nonce="simulation-runtime">${script}</script></body></html>`;
}
