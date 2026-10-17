import {
  CPU, AVRIOPort, AVRTimer, AVRUSART, avrInstruction, PinState,
  portBConfig, portCConfig, portDConfig, timer0Config, timer1Config, timer2Config, usart0Config,
} from 'avr8js';
import { validateCircuit } from './circuit';
import { evaluateScenario } from './assertions';
import type { Circuit, CircuitComponent, PinMode, Scenario, ScenarioResult, SignalValue, TracePoint } from './types';

export const SIMULATOR_VERSION = 'airlock-uno-v1/avr8js-0.21.1';
export const FREQUENCY_HZ = 16000000;
export const FLASH_BYTES = 32768;
export const SRAM_BYTES = 2048;
export const MAX_TRACE_POINTS = 100000;
const MAX_SCENARIO_MS = 15000;
const SETUP_GRACE_MS = 100;

/** Intel HEX parser with checksum, addressing, overlap, EOF and Uno flash bounds checks. */
export function parseHex(hex: string): Uint16Array {
  if (typeof hex !== 'string' || !hex.trim() || hex.length > 150000) throw new Error('Missing or oversized Intel HEX firmware');
  const bytes = new Uint8Array(FLASH_BYTES);
  bytes.fill(0xff);
  const written = new Set<number>();
  let base = 0;
  let eof = false;
  for (const [index, raw] of hex.trim().split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (eof) throw new Error('HEX contains records after EOF');
    if (!/^:[0-9A-Fa-f]+$/.test(line) || line.length < 11 || (line.length - 1) % 2) throw new Error(`Malformed HEX record ${index + 1}`);
    const record = Array.from({ length: (line.length - 1) / 2 }, (_, i) => parseInt(line.slice(1 + i * 2, 3 + i * 2), 16));
    const count = record[0];
    if (record.length !== count + 5 || (record.reduce((sum, value) => sum + value, 0) & 0xff) !== 0) throw new Error(`Invalid HEX length or checksum at record ${index + 1}`);
    const address = (record[1] << 8) | record[2];
    const type = record[3];
    if (type === 0) {
      for (let i = 0; i < count; i++) {
        const at = base + address + i;
        if (at >= FLASH_BYTES) throw new Error('Firmware exceeds Uno 32 KB flash');
        if (written.has(at)) throw new Error('Overlapping HEX data records');
        written.add(at); bytes[at] = record[4 + i];
      }
    } else if (type === 1) {
      if (count !== 0 || address !== 0) throw new Error('Invalid HEX EOF');
      eof = true;
    } else if (type === 2 || type === 4) {
      if (count !== 2 || address !== 0) throw new Error('Invalid HEX extended address');
      base = ((record[4] << 8) | record[5]) * (type === 2 ? 16 : 65536);
    } else if (type === 3 || type === 5) {
      if (count !== 4 || address !== 0) throw new Error('Invalid HEX start address');
      if (record.slice(4, 8).some((value) => value !== 0)) throw new Error('Uno firmware must start at the reset vector');
    } else throw new Error(`Unsupported HEX record type ${type}`);
  }
  if (!eof || !written.has(0) || !written.has(1)) throw new Error('HEX must include firmware at the reset vector and EOF');
  const words = new Uint16Array(FLASH_BYTES / 2);
  for (let i = 0; i < words.length; i++) words[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  return words;
}

type AttachedPin = { component: CircuitComponent; port: AVRIOPort; bit: number };

/**
 * The shared deterministic Node/browser engine. A new instance is a real reset.
 * step() runs one AVR instruction and pending peripheral ticks. runUntil(ms) uses
 * absolute simulation time, stopping at the first instruction boundary >= ms.
 * setButton() changes a physical active-low input at that boundary. trace records
 * all connected value/mode changes, including atomic port writes and timer PWM.
 */
export class UnoMachine {
  readonly cpu: CPU;
  readonly trace: TracePoint[] = [];
  readonly circuit: Circuit;
  private readonly pins: AttachedPin[];
  private readonly pressed = new Map<string, boolean>();
  private readonly states = new Map<string, TracePoint>();
  private setupChecked = false;
  private updatingInputs = false;

  constructor(hex: string, circuit: Circuit) {
    validateCircuit(circuit);
    this.circuit = structuredClone(circuit);
    this.cpu = new CPU(parseHex(hex), SRAM_BYTES);
    const portB = new AVRIOPort(this.cpu, portBConfig);
    const portC = new AVRIOPort(this.cpu, portCConfig);
    const portD = new AVRIOPort(this.cpu, portDConfig);
    new AVRTimer(this.cpu, timer0Config);
    new AVRTimer(this.cpu, timer1Config);
    new AVRTimer(this.cpu, timer2Config);
    new AVRUSART(this.cpu, usart0Config, FREQUENCY_HZ);
    this.pins = this.circuit.components.map((component) => ({ component, port: component.pin < 8 ? portD : portB, bit: component.pin < 8 ? component.pin : component.pin - 8 }));
    for (const { component } of this.pins) if (component.kind === 'button') this.pressed.set(component.id, false);
    for (const port of [portB, portC, portD]) port.addListener(() => this.capture(port));
    // AVR8js pinState reports PORT/DDR pull-ups, but does not apply MCUCR.PUD.
    // Model that global switch explicitly so raw register writes cannot fake pull-ups.
    this.cpu.writeHooks[0x55] = (value) => {
      this.cpu.data[0x55] = value;
      this.capture();
      return true;
    };
    // This workbench promises a fixed 16 MHz Uno, so other clock modes are rejected.
    this.cpu.writeHooks[0x61] = (value) => {
      if (value & 0x0f) throw new Error('Clock prescaling is outside the supported fixed 16 MHz Uno configuration');
      this.cpu.data[0x61] = value;
      return true;
    };
    this.capture();
  }

  get atMs(): number { return this.cpu.cycles / (FREQUENCY_HZ / 1000); }

  private capture(port?: AVRIOPort): void {
    if (this.updatingInputs) return;
    this.updatingInputs = true;
    try {
      for (const pin of this.pins) {
        if (port && pin.port !== port) continue;
        const { component } = pin;
        let state = pin.port.pinState(pin.bit);
        if (state === PinState.InputPullUp && (this.cpu.data[0x55] & 0x10)) state = PinState.Input;
        const mode: PinMode = state === PinState.Input ? 'input' : state === PinState.InputPullUp ? 'input-pullup' : 'output';
        let value: SignalValue = state === PinState.High ? 1 : state === PinState.Low ? 0 : state === PinState.InputPullUp ? 1 : 'floating';
        if (component.kind === 'button') {
          const pressed = this.pressed.get(component.id) ?? false;
          if (mode !== 'output') {
            value = pressed ? 0 : mode === 'input-pullup' ? 1 : 'floating';
            // Released buttons only read high when the firmware really enables a pull-up.
            pin.port.setPin(pin.bit, value === 1);
          } else if (pressed && value === 1) throw new Error(`GPIO contention: ${component.id} drives HIGH into a grounded button`);
        }
        const previous = this.states.get(component.id);
        if (!previous || previous.value !== value || previous.mode !== mode) {
          if (this.trace.length >= MAX_TRACE_POINTS) throw new Error(`Signal trace exceeded ${MAX_TRACE_POINTS} transitions`);
          const point: TracePoint = { cycle: this.cpu.cycles, atMs: this.atMs, signal: component.id, value, mode };
          this.states.set(component.id, point);
          this.trace.push(point);
        }
      }
      if (this.atMs >= SETUP_GRACE_MS) this.validateModes();
    } finally { this.updatingInputs = false; }
  }

  /** Called at scenario completion as well, so sub-100ms tests cannot bypass wiring readiness. */
  validateModes(): void {
    for (const { component } of this.pins) {
      const state = this.states.get(component.id)!;
      const required = component.kind === 'button' ? 'input-pullup' : 'output';
      if (state.mode !== required) throw new Error(`${component.id} on D${component.pin} requires ${required}; observed ${state.mode} at ${this.atMs.toFixed(3)} ms`);
    }
    this.setupChecked = true;
  }

  setButton(componentId: string, pressed: boolean): void {
    if (!this.pressed.has(componentId) || typeof pressed !== 'boolean') throw new Error(`Unknown button: ${componentId}`);
    this.pressed.set(componentId, pressed);
    this.capture();
  }

  step(): void {
    if (!Number.isInteger(this.cpu.pc) || this.cpu.pc < 0 || this.cpu.pc >= this.cpu.progMem.length || this.cpu.progMem[this.cpu.pc] === 0xffff) throw new Error(`Execution left programmed firmware at word ${this.cpu.pc}`);
    avrInstruction(this.cpu);
    this.cpu.tick();
    if (this.cpu.SP < 0x100 || this.cpu.SP >= SRAM_BYTES + 0x100) throw new Error('Firmware stack exceeded Uno 2 KB SRAM');
    if (!this.setupChecked && this.atMs >= SETUP_GRACE_MS) this.validateModes();
  }

  runUntil(atMs: number): void {
    if (!Number.isFinite(atMs) || atMs < 0 || atMs > 3600000) throw new Error('Invalid target simulation time');
    const target = Math.ceil(atMs * FREQUENCY_HZ / 1000);
    while (this.cpu.cycles < target) this.step();
  }
}

export function runScenario(hex: string, circuit: Circuit, scenario: Scenario): ScenarioResult {
  let machine: UnoMachine | undefined;
  try {
    if (!Number.isFinite(scenario.durationMs) || scenario.durationMs <= 0 || scenario.durationMs > MAX_SCENARIO_MS) throw new Error('Scenario duration must be 1–15000 ms');
    machine = new UnoMachine(hex, circuit);
    let lastAt = -1;
    for (const input of scenario.inputs) {
      if (!Number.isFinite(input.atMs) || input.atMs < lastAt || input.atMs < 0 || input.atMs > scenario.durationMs) throw new Error('Invalid or unordered scenario inputs');
      machine.runUntil(input.atMs);
      machine.setButton(input.componentId, input.pressed);
      lastAt = input.atMs;
    }
    machine.runUntil(scenario.durationMs);
    machine.validateModes();
    return { scenarioId: scenario.id, completed: true, durationMs: scenario.durationMs, trace: machine.trace, checks: evaluateScenario(scenario, machine.trace) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const trace = machine?.trace ?? [];
    return { scenarioId: scenario.id, completed: false, durationMs: machine?.atMs ?? 0, trace, checks: evaluateScenario(scenario, trace, message), error: message };
  }
}
