import type { Circuit, CircuitComponent, Connection, PinAssignment, RunSpec } from './types';
import { validateSpec } from './validation';

function templateConnections(component: CircuitComponent): Connection[] {
  const pin = `uno:D${component.pin}`;
  if (component.kind === 'button') return [
    { from: pin, to: `${component.id}:1` }, { from: `${component.id}:2`, to: 'uno:GND' },
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
    if (!p || !spec.components.some((c) => c.id === p.componentId)) throw new Error('Pin assignment references an unknown component');
    if (assigned.has(p.componentId)) throw new Error(`Duplicate component assignment: ${p.componentId}`);
    if (!Number.isInteger(p.pin) || p.pin < 2 || p.pin > 13) throw new Error('Pins must be distinct D2–D13 pins');
    if (usedPins.has(p.pin)) throw new Error(`Duplicate pin: D${p.pin}`);
    assigned.add(p.componentId); usedPins.add(p.pin);
  }
  const components: CircuitComponent[] = spec.components.map((component) => ({
    ...component, pin: pins.find((p) => p.componentId === component.id)!.pin,
    template: component.kind === 'button' ? 'button-to-ground-pullup' : 'led-series-resistor',
    ...(component.kind === 'led' ? { resistanceOhms: 220 } : {}),
  }));
  const circuit: Circuit = { board: 'arduino:avr:uno', frequencyHz: 16000000, components, connections: components.flatMap(templateConnections) };
  validateCircuit(circuit, spec);
  return circuit;
}

/** Validate exact approved net topology, not merely names or a rendered diagram. */
export function validateCircuit(circuit: Circuit, spec?: RunSpec): void {
  if (!circuit || circuit.board !== 'arduino:avr:uno' || circuit.frequencyHz !== 16000000) throw new Error('Only a 16 MHz Arduino Uno is supported');
  if (!Array.isArray(circuit.components) || !Array.isArray(circuit.connections)) throw new Error('Circuit must include components and connections');
  validateSpec({ goal: spec?.goal ?? 'Circuit validation', assumptions: [], components: circuit.components.map(({ id, kind, label, meaning }) => ({ id, kind, label, meaning })), requirements: [{ id: 'R1', text: 'Circuit validation' }] });
  const pins = new Set<number>();
  for (const c of circuit.components) {
    if (!Number.isInteger(c.pin) || c.pin < 2 || c.pin > 13 || pins.has(c.pin)) throw new Error('Circuit pins must be distinct D2–D13 pins');
    pins.add(c.pin);
    if (c.kind === 'button' && (c.template !== 'button-to-ground-pullup' || c.resistanceOhms !== undefined)) throw new Error('Buttons must use the button-to-ground template with internal pull-up');
    if (c.kind === 'led' && (c.template !== 'led-series-resistor' || c.resistanceOhms !== 220)) throw new Error('LEDs must use the approved 220-ohm series-resistor template');
  }
  const actual = circuit.connections.map((connection) => {
    if (!connection || typeof connection.from !== 'string' || typeof connection.to !== 'string' || Object.keys(connection).some((k) => k !== 'from' && k !== 'to')) throw new Error('Invalid wire connection');
    return [connection.from, connection.to].sort().join('|');
  }).sort();
  const expected = circuit.components.flatMap(templateConnections).map((c) => [c.from, c.to].sort().join('|')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Circuit wiring does not match the approved component templates');
  if (spec) {
    if (circuit.components.length !== spec.components.length) throw new Error('Circuit changes the frozen components');
    for (const component of spec.components) {
      const actual = circuit.components.find((c) => c.id === component.id);
      if (!actual || actual.kind !== component.kind || actual.meaning !== component.meaning || actual.label !== component.label) throw new Error(`Circuit changes frozen component ${component.id}`);
    }
  }
}
