import type { Circuit, CircuitComponent, Connection, PinAssignment, RunSpec } from './types';
import { validateSpec } from './validation';

function templateConnections(component: CircuitComponent): Connection[] {
  const pin = `uno:D${component.pin}`;
  if (component.kind === 'button') return [
    { from: pin, to: `${component.id}:1` }, { from: `${component.id}:2`, to: 'uno:GND' },
  ];
  if (component.kind === 'motor') return [
    { from: pin, to: `${component.id}-driver:IN1` },
    { from: `uno:D${component.reversePin}`, to: `${component.id}-driver:IN2` },
    { from: 'uno:5V', to: `${component.id}-driver:VCC` },
    { from: 'uno:5V', to: `${component.id}-driver:EN` },
    { from: 'uno:GND', to: `${component.id}-driver:GND` },
    { from: `${component.id}-supply:positive`, to: `${component.id}-driver:VM` },
    { from: `${component.id}-supply:negative`, to: `${component.id}-driver:GND` },
    { from: `${component.id}-driver:OUT1`, to: `${component.id}:positive` },
    { from: `${component.id}-driver:OUT2`, to: `${component.id}:negative` },
  ];
  return [
    { from: pin, to: `${component.id}-resistor:1` },
    { from: `${component.id}-resistor:2`, to: `${component.id}:anode` },
    { from: `${component.id}:cathode`, to: 'uno:GND' },
  ];
}

/** Agents assign logical components to distinct Uno pins; only application code makes wires. */
export function generateCircuit(spec: RunSpec, pins: PinAssignment[]): Circuit {
  validateSpec(spec);
  if (!Array.isArray(pins) || pins.length !== spec.components.length) throw new Error('Exactly one pin assignment is required per component');
  const assigned = new Set<string>();
  const usedPins = new Set<number>();
  for (const p of pins) {
    const component = p && spec.components.find((c) => c.id === p.componentId);
    if (!component) throw new Error('Pin assignment references an unknown component');
    if (assigned.has(p.componentId)) throw new Error(`Duplicate component assignment: ${p.componentId}`);
    if (component.kind !== 'motor' && p.reversePin !== undefined) throw new Error('Only motors may have a reverse pin');
    const componentPins = component.kind === 'motor' ? [p.pin, p.reversePin] : [p.pin];
    for (const pin of componentPins) {
      if (typeof pin !== 'number' || !Number.isInteger(pin) || pin < 2 || pin > 13) throw new Error('Pins must be distinct D2–D13 pins; motors require a reverse pin');
      if (usedPins.has(pin)) throw new Error(`Duplicate pin: D${pin}`);
      usedPins.add(pin);
    }
    assigned.add(p.componentId);
  }
  const components: CircuitComponent[] = spec.components.map((component) => {
    const assignment = pins.find((p) => p.componentId === component.id)!;
    return {
      ...component, pin: assignment.pin,
      template: component.kind === 'button' ? 'button-to-ground-pullup' : component.kind === 'motor' ? 'h-bridge-motor' : 'led-series-resistor',
      ...(component.kind === 'led' ? { resistanceOhms: 220 } : {}),
      ...(component.kind === 'motor' ? { reversePin: assignment.reversePin } : {}),
    };
  });
  const circuit: Circuit = { board: 'arduino:avr:uno', frequencyHz: 16000000, components, connections: components.flatMap(templateConnections),
    ...(spec.serial ? { serial: structuredClone(spec.serial) } : {}), ...(spec.presentation ? { presentation: spec.presentation } : {}) };
  validateCircuit(circuit, spec);
  return circuit;
}

/** Validate exact approved net topology, not merely names or a rendered diagram. */
export function validateCircuit(circuit: Circuit, spec?: RunSpec): void {
  if (!circuit || circuit.board !== 'arduino:avr:uno' || circuit.frequencyHz !== 16000000) throw new Error('Only a 16 MHz Arduino Uno is supported');
  if (!Array.isArray(circuit.components) || !Array.isArray(circuit.connections)) throw new Error('Circuit must include components and connections');
  validateSpec({ goal: spec?.goal ?? 'Circuit validation', assumptions: [], components: circuit.components.map(({ id, kind, label, meaning }) => ({ id, kind, label, meaning })), requirements: [{ id: 'R1', text: 'Circuit validation' }], ...(circuit.serial !== undefined ? { serial: circuit.serial } : {}), ...(circuit.presentation !== undefined ? { presentation: circuit.presentation } : {}) });
  const pins = new Set<number>();
  for (const c of circuit.components) {
    if (c.kind !== 'motor' && c.reversePin !== undefined) throw new Error('Only motors may have a reverse pin');
    for (const pin of c.kind === 'motor' ? [c.pin, c.reversePin] : [c.pin]) {
      if (typeof pin !== 'number' || !Number.isInteger(pin) || pin < 2 || pin > 13 || pins.has(pin)) throw new Error('Circuit pins must be distinct D2–D13 pins; motors require a reverse pin');
      pins.add(pin);
    }
    if (c.kind === 'button' && (c.template !== 'button-to-ground-pullup' || c.resistanceOhms !== undefined)) throw new Error('Buttons must use the button-to-ground template with internal pull-up');
    if (c.kind === 'led' && (c.template !== 'led-series-resistor' || c.resistanceOhms !== 220)) throw new Error('LEDs must use the approved 220-ohm series-resistor template');
    if (c.kind === 'motor' && (c.template !== 'h-bridge-motor' || c.resistanceOhms !== undefined)) throw new Error('Motors must use the approved H-bridge template');
  }
  const actual = circuit.connections.map((connection) => {
    if (!connection || typeof connection.from !== 'string' || typeof connection.to !== 'string' || Object.keys(connection).some((k) => k !== 'from' && k !== 'to')) throw new Error('Invalid wire connection');
    return [connection.from, connection.to].sort().join('|');
  }).sort();
  const expected = circuit.components.flatMap(templateConnections).map((c) => [c.from, c.to].sort().join('|')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Circuit wiring does not match the approved component templates');
  if (spec) {
    const serialContract = (serial: Circuit['serial']) => serial && { baudRate: serial.baudRate, controls: serial.controls.map(({ key, label, data, releaseData }) => ({ key, label, data, releaseData })) };
    if (circuit.presentation !== spec.presentation || JSON.stringify(serialContract(circuit.serial)) !== JSON.stringify(serialContract(spec.serial))) throw new Error('Circuit changes frozen serial controls or presentation');
    if (circuit.components.length !== spec.components.length) throw new Error('Circuit changes the frozen components');
    for (const component of spec.components) {
      const actual = circuit.components.find((c) => c.id === component.id);
      if (!actual || actual.kind !== component.kind || actual.meaning !== component.meaning || actual.label !== component.label) throw new Error(`Circuit changes frozen component ${component.id}`);
    }
  }
}
