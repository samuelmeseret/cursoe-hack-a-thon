import { UnoMachine, runScenario } from '../shared/simulator';
import type { Circuit, SimulatorCommand, SimulatorMessage } from '../shared/types';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let machine: UnoMachine | undefined;
let loaded: { hex: string; circuit: Circuit } | undefined;
let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let sentTrace = 0;
const send = (message: SimulatorMessage) => scope.postMessage(message);

function report() {
  if (!machine) return;
  if (sentTrace < machine.trace.length) {
    send({ type: 'trace', trace: machine.trace.slice(sentTrace), atMs: machine.atMs });
    sentTrace = machine.trace.length;
  }
  send({ type: 'state', running, atMs: machine.atMs });
}
function pause() {
  running = false;
  clearTimeout(timer);
  timer = undefined;
}
function tick() {
  if (!running || !machine) return;
  const started = performance.now();
  try {
    machine.runUntil(machine.atMs + 16);
    report();
    timer = setTimeout(tick, Math.max(0, 16 - (performance.now() - started)));
  } catch (error) {
    pause();
    report();
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

scope.onmessage = (event: MessageEvent<SimulatorCommand>) => {
  const command = event.data;
  try {
    switch (command.type) {
      case 'load':
        pause();
        loaded = { hex: command.hex, circuit: command.circuit };
        machine = new UnoMachine(loaded.hex, loaded.circuit);
        sentTrace = 0;
        report();
        break;
      case 'play':
        if (!machine) throw new Error('Load compiled firmware before starting the simulator');
        if (!running) { running = true; tick(); }
        break;
      case 'pause':
        pause(); report();
        break;
      case 'reset':
        if (!loaded) throw new Error('No firmware loaded to reset');
        pause();
        machine = new UnoMachine(loaded.hex, loaded.circuit);
        sentTrace = 0;
        report();
        break;
      case 'button':
        if (!machine) throw new Error('No firmware loaded');
        machine.setButton(command.componentId, command.pressed);
        report();
        break;
      case 'scenario':
        pause();
        send({ type: 'result', result: runScenario(command.hex, command.circuit, command.scenario) });
        break;
      default:
        throw new Error('Unsupported simulator command');
    }
  } catch (error) {
    pause();
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
