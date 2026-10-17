import type { HardwareBinding, HardwareConfiguration } from '../shared/hardware-project.js';
import type { DeviceProfile } from '../shared/hardware-types.js';
import type { SimulationRun } from '../shared/simulation-run.js';
import { emitControllerCpp, validatePortableController, type PortableControllerProgram } from '../shared/portable-controller.js';
import { buildSimulationDocument } from '../shared/simulation-runtime.js';

const json = (value: unknown) => JSON.stringify(value, null, 2);
const quote = (value: string) => JSON.stringify(value);
const number = (value: number | boolean) => typeof value === 'boolean' ? value ? '1' : '0' : String(value);
const float = (value: number) => `${Number.isInteger(value) ? value.toFixed(1) : value}f`;
export const HARDWARE_GENERATOR_VERSION = 'portable-arduino-v1';
export interface HardwareSourceGenerator {
  capabilities: string[];
  generate(run: SimulationRun, configuration: HardwareConfiguration, profile: DeviceProfile): Record<string, string>;
  validate?(program: PortableControllerProgram, configuration: HardwareConfiguration, profile: DeviceProfile): string[];
}
const sourceGenerators = new Map<string, HardwareSourceGenerator>();
export function registerHardwareSourceGenerator(adapter: string, generator: HardwareSourceGenerator) {
  if (sourceGenerators.has(adapter)) throw new Error(`A source generator is already registered for ${adapter}.`);
  sourceGenerators.set(adapter, generator);
}
const arduinoRuntime = (profile: DeviceProfile) => ['Arduino', 'Arduino C++'].includes(profile.framework);

export function configurationIssues(program: PortableControllerProgram, config: HardwareConfiguration, profile: DeviceProfile): string[] {
  validatePortableController(program);
  const issues: string[] = [];
  if (!profile.supported) issues.push(...profile.missingCapabilities);
  const generator = sourceGenerators.get(profile.adapter);
  if (!generator && !arduinoRuntime(profile)) issues.push(`Missing application source generator for ${profile.framework} (${profile.adapter}). Register a source generator; a compiler adapter alone cannot implement this runtime's I/O.`);
  if (generator?.validate) issues.push(...generator.validate(program, config, profile));
  const supported = new Set(generator?.capabilities ?? ['gpio', 'digital-input', 'analog-input', 'digital-output', 'pwm-output', 'serial']);
  for (const required of (program as PortableControllerProgram & { requiredCapabilities?: string[] }).requiredCapabilities ?? []) {
    if (!supported.has(required)) issues.push(`Missing build adapter capability: ${required}. This project needs a driver or transport implementation before it can be exported for hardware.`);
  }
  const seen = new Set<string>();
  const pins = new Map<number, string>();
  for (const direction of ['input', 'output'] as const) {
    for (const signal of direction === 'input' ? program.inputs : program.outputs) {
      const key = `${direction}:${signal.id}`;
      const matches = config.bindings.filter(binding => binding.direction === direction && binding.signalId === signal.id);
      if (matches.length !== 1) { issues.push(`${signal.label}: configure exactly one hardware binding.`); continue; }
      seen.add(key);
      const binding = matches[0];
      if (binding.kind !== 'serial' && profile.logicVoltage && signal.hardware.voltage && signal.hardware.voltage > profile.logicVoltage) issues.push(`${signal.label}: the declared ${signal.hardware.voltage} V signal exceeds this profile's ${profile.logicVoltage} V logic level. Configure compatible hardware and voltage conversion before building.`);
      const allowed = direction === 'input' ? ['serial', signal.type === 'boolean' ? 'digital-input' : 'analog-input'] : ['serial', signal.type === 'boolean' ? 'digital-output' : 'pwm-output'];
      if (!allowed.includes(binding.kind)) issues.push(`${signal.label}: ${binding.kind} cannot carry a ${signal.type} ${direction}. Choose ${allowed.join(' or ')}.`);
      if (!binding.component.trim()) issues.push(`${signal.label}: name the physical component or computer connection.`);
      if (binding.kind === 'serial') continue;
      const pin = profile.pins.find(pin => pin.id === binding.pin);
      if (!pin) { issues.push(`${signal.label}: select a pin from ${profile.name}'s installed variant metadata.`); continue; }
      if (pin.reserved) issues.push(`${signal.label}: pin ${pin.label} is reserved: ${pin.reserved}`);
      if (pins.has(pin.number)) issues.push(`${signal.label}: pin ${pin.label} is already used by ${pins.get(pin.number)}.`);
      pins.set(pin.number, signal.label);
      if (binding.kind.startsWith('digital') && !pin.digital) issues.push(`${signal.label}: ${pin.label} does not support digital GPIO.`);
      if (binding.kind === 'pwm-output' && !pin.pwm) issues.push(`${signal.label}: ${pin.label} does not support PWM in this board profile.`);
      if (binding.kind === 'analog-input') {
        if (!pin.analog) issues.push(`${signal.label}: ${pin.label} is not an analog input.`);
        if (!Number.isFinite(binding.minimum) || !Number.isFinite(binding.maximum) || binding.minimum! >= binding.maximum!) issues.push(`${signal.label}: enter the sensor's minimum and maximum engineering values for ADC scaling.`);
      }
    }
  }
  for (const binding of config.bindings) if (!seen.has(`${binding.direction}:${binding.signalId}`)) issues.push(`Binding ${binding.signalId} no longer exists in this controller revision. Remove it before building.`);
  return [...new Set(issues)];
}

export function firmwareSource(program: PortableControllerProgram, config: HardwareConfiguration, profile: DeviceProfile): string {
  const pinNumber = (binding: HardwareBinding) => profile.pins.find(pin => pin.id === binding.pin)!.number;
  const serialInputs = config.bindings.filter(binding => binding.direction === 'input' && binding.kind === 'serial');
  const outputs = config.bindings.filter(binding => binding.direction === 'output');
  const physicalInputs = config.bindings.filter(binding => binding.direction === 'input' && binding.kind !== 'serial');
  const writes = outputs.map(binding => {
    const value = `controller.get(${quote(binding.signalId)})`;
    if (binding.kind === 'serial') return '';
    if (binding.kind === 'pwm-output') {
      const output = program.outputs.find(output => output.id === binding.signalId)!;
      const minimum = output.hardware.min ?? 0, maximum = output.hardware.max ?? 255;
      const scaled = `((${value} - ${float(minimum)}) * 255.0f / ${float(maximum - minimum)})`;
      return `  analogWrite(${pinNumber(binding)}, (int)constrain(${binding.activeLow ? `255.0f - ${scaled}` : scaled}, 0.0f, 255.0f));`;
    }
    return `  digitalWrite(${pinNumber(binding)}, (${value} != 0) ? ${binding.activeLow ? 'LOW' : 'HIGH'} : ${binding.activeLow ? 'HIGH' : 'LOW'});`;
  }).join('\n');
  const resetSerial = serialInputs.map(binding => { const initial = number(program.inputs.find(input => input.id === binding.signalId)!.initial); return `if (controller.get(${quote(binding.signalId)}) != ${initial}) controller.input(${quote(binding.signalId)}, ${initial});`; }).join(' ');
  const readInputs = physicalInputs.map(binding => {
    const raw = binding.kind === 'digital-input' ? `(digitalRead(${pinNumber(binding)}) == ${binding.activeLow ? 'LOW' : 'HIGH'})` : `(${float(binding.minimum!)} + (analogRead(${pinNumber(binding)}) / 1023.0f) * ${float(binding.maximum! - binding.minimum!)} )`;
    return `  { float value = ${raw}; if (controller.get(${quote(binding.signalId)}) != value) controller.input(${quote(binding.signalId)}, value); }`;
  }).join('\n');
  return `// Generated from controller.json; visual simulation code never enters the firmware.
#include <Arduino.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "controller.h"
PortableController controller;
unsigned long previousTick = 0, lastHost = 0, lastTelemetry = 0;
bool hostActive = false;
char serialLine[96]; unsigned int serialLength = 0; bool serialOverflow = false;
void applyOutputs() {
${writes}
}
void acceptLine() {
  char *separator = strchr(serialLine, '=');
  if (!separator) return;
  *separator = '\\0';
  char *end = NULL; float value = (float)strtod(separator + 1, &end);
  if (end == separator + 1 || *end != '\\0' || !isfinite(value)) return;
${serialInputs.length ? '  if (strcmp(serialLine, "@heartbeat") == 0) { lastHost = millis(); hostActive = true; return; }' : ''}
${serialInputs.map(binding => {
    const input = program.inputs.find(input => input.id === binding.signalId)!;
    return `  if (strcmp(serialLine, ${quote(binding.signalId)}) == 0) { controller.input(serialLine, ${input.type === 'boolean' ? 'value != 0' : `value`}); lastHost = millis(); hostActive = true; applyOutputs(); return; }`;
  }).join('\n')}
}
void setup() {
  Serial.begin(${config.baudRate});
${config.bindings.filter(binding => binding.kind !== 'serial').map(binding => `  pinMode(${pinNumber(binding)}, ${binding.direction === 'output' ? 'OUTPUT' : binding.activeLow && binding.kind === 'digital-input' ? 'INPUT_PULLUP' : 'INPUT'});`).join('\n')}
  controller.reset(); applyOutputs(); previousTick = millis();
}
void loop() {
  // Bound serial work so a busy host cannot starve control updates.
  for (int n = 0; n < 128 && Serial.available(); n++) {
    char c = (char)Serial.read();
    if (c == '\\n') { if (!serialOverflow) { serialLine[serialLength] = '\\0'; acceptLine(); } serialLength = 0; serialOverflow = false; }
    else if (c != '\\r') { if (serialLength + 1 < sizeof(serialLine)) serialLine[serialLength++] = c; else serialOverflow = true; }
  }
  unsigned long now = millis();
  if (hostActive && (unsigned long)(now - lastHost) >= ${config.serialTimeoutMs}UL) { ${resetSerial} hostActive = false; applyOutputs(); }
  unsigned long elapsed = now - previousTick;
  if (elapsed >= 10UL) {
    previousTick = now;
${readInputs}
    // Same controller, elapsed seconds; 10 ms nominal hardware scheduler.
    controller.step(elapsed / 1000.0f); applyOutputs();
  }
  if ((unsigned long)(now - lastTelemetry) >= 100UL) {
    lastTelemetry = now;
${outputs.filter(binding => binding.kind === 'serial').map(binding => `    Serial.print(${quote(binding.signalId + '=')}); Serial.println(controller.get(${quote(binding.signalId)}), 6);`).join('\n')}
  }
}
`;
}

function hostController(run: SimulationRun, config: HardwareConfiguration): string {
  const program = run.candidate!.controller!;
  const serialInputs = program.inputs.filter(input => config.bindings.some(binding => binding.signalId === input.id && binding.direction === 'input' && binding.kind === 'serial'));
  const mapping = serialInputs.map(input => ({ id: input.id, initial: input.initial, key: run.spec!.controls.find(control => control.id === input.id)?.key ?? input.key, type: input.type }));
  return `#!/usr/bin/env python3
"""Keyboard + numeric control bridge. Explicit --port required; never uploads firmware."""
import argparse, json, threading, time, queue
import serial
from pynput import keyboard
SIGNALS = json.loads(${JSON.stringify(JSON.stringify(mapping))})
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', required=True, help='Explicit serial device, e.g. /dev/cu.usbmodem… or COM3')
parser.add_argument('--baud', type=int, default=${config.baudRate})
args = parser.parse_args()
values = {s['id']: float(s['initial']) for s in SIGNALS}
key_ids = {('space' if s['key'] == ' ' else s['key'].lower()): s['id'] for s in SIGNALS if s.get('key')}
lock = threading.Lock()
events = queue.Queue()
def key_name(key):
    if getattr(key, 'char', None): return key.char.lower()
    return {keyboard.Key.up:'arrowup', keyboard.Key.down:'arrowdown', keyboard.Key.left:'arrowleft', keyboard.Key.right:'arrowright', keyboard.Key.space:'space'}.get(key, '')
def set_key(key, value):
    name = key_name(key)
    if name in key_ids:
        with lock: values[key_ids[name]] = value
    if key == keyboard.Key.esc: return False
def commands():
    while True:
        try:
            line = input('signal=value > ')
            name, raw = line.split('=', 1)
            value = float(raw)
            if name not in values or not __import__('math').isfinite(value): raise ValueError('Unknown signal or nonfinite value')
            with lock:
                values[name] = value
                events.put((name, value))
        except EOFError: return
        except ValueError as error: print(error)
with serial.Serial(args.port, args.baud, timeout=0.05) as device:
    time.sleep(2) # Some boards reset when the serial port opens.
    listener = keyboard.Listener(on_press=lambda key:set_key(key,1), on_release=lambda key:set_key(key,0))
    listener.start()
    threading.Thread(target=commands, daemon=True).start()
    print('Keys:', key_ids, '\\nKeyboard shortcuts are global while this bridge runs. Escape or Ctrl-C stops. OS input permission may be needed.')
    try:
        previous = {}
        while listener.is_alive():
            with lock:
                current = dict(values)
                batch = ''
                while not events.empty():
                    name, value = events.get_nowait()
                    batch += f'{name}={value}\\n'
                    previous[name] = value
                batch += ''.join(f'{name}={value}\\n' for name,value in current.items() if previous.get(name) != value)
                previous = current
            batch += '@heartbeat=1\\n'
            device.write(batch.encode('ascii'))
            if device.in_waiting: print(device.read(device.in_waiting).decode('ascii', errors='replace'), end='')
            time.sleep(0.05)
    except KeyboardInterrupt: pass
    finally:
        for signal in SIGNALS: device.write(f"{signal['id']}={float(signal['initial'])}\\n".encode('ascii'))
        device.flush()
        listener.stop()
`;
}

export function generateProjectFiles(run: SimulationRun, config: HardwareConfiguration, profile: DeviceProfile): Record<string, string> {
  const custom = sourceGenerators.get(profile.adapter);
  if (custom) return custom.generate(run, config, profile);
  if (!arduinoRuntime(profile)) throw new Error(`Missing application source generator for ${profile.framework} (${profile.adapter}).`);
  if (!run.candidate?.controller || !run.spec) throw new Error('This revision has no portable controller. Ask the agent to rebuild it with a shared hardware controller.');
  const program = validatePortableController(run.candidate.controller);
  const hasSerialInputs = config.bindings.some(binding => binding.kind === 'serial' && binding.direction === 'input');
  const wiring = config.bindings.map(binding => {
    const signal = (binding.direction === 'input' ? program.inputs : program.outputs).find(signal => signal.id === binding.signalId)!;
    return `| ${signal.label.replace(/\|/g, '/')} (${binding.signalId}) | ${binding.direction} | ${binding.kind} | ${binding.pin ?? 'USB serial to computer'} | ${binding.component.replace(/\|/g, '/')} | ${(binding.notes ?? signal.hardware.description ?? '').replace(/[\n|]/g, ' ')} |`;
  }).join('\n');
  const files: Record<string, string> = {
    'device/controller.h': emitControllerCpp(program),
    'device/device.ino': firmwareSource(program, config, profile),
    'controller.json': json(program),
    'hardware.json': json(config),
    'device-profile.json': json(profile),
    'requirements.json': json(run.spec),
    'scenarios.json': json(run.scenarios ?? []),
    'simulation.html': buildSimulationDocument({ spec: run.spec, candidate: run.candidate }, { standalone: true }),
    'simulation.js': run.candidate.source,
    'environment.js': run.candidate.environmentSource!,
    'WIRING.md': `# Wiring and component list\n\nBoard: ${profile.name} (${config.fqbn}); ${profile.architecture}.\n\n| Signal | Direction | Interface | Board pin | Component | Connection notes |\n|---|---|---|---|---|---|\n${wiring}\n\nConnect signal grounds together. Check the board and component datasheets for operating voltage and current. Use a suitable driver and external supply for motors, relays, or high-current loads; GPIO signals are control signals. Use current-limiting resistors for LEDs. Analog inputs map ADC 0..1023 to the configured engineering range in hardware.json. Verify the actual sensor transfer function and board ADC reference; this is configuration, not a measured calibration. PWM output ranges declared in controller.json map to duty values 0..255 (the default range is 0..255). Active-low inputs use the internal pull-up; other digital inputs require an external pull-down/up as appropriate.\n\n## Components\n${[...new Set(config.bindings.map(binding => binding.component))].map(component => `- ${component}`).join('\n')}\n- ${profile.name}\n${hasSerialInputs ? '- USB data cable and a computer running the serial companion\n' : ''}\n## Profile constraints\n${profile.constraints.map(item => `- ${item}`).join('\n')}\n`,
    'README.md': `# ${run.spec.title}\n\n${run.spec.summary}\n\nProject ${run.projectId ?? run.id}; revision ${run.id}.\n\n## One controller\n\ncontroller.json is the authoritative controller program. The app compiles it to the JavaScript controller in simulation.js and to device/controller.h. environment.js contains visual/physical modeling only. The browser never sends keyboard events directly to a device.\n\n## Build outside Simulation Lab\n\nInstall Arduino CLI, then run from this extracted directory:\n\n\`\`\`sh\narduino-cli core update-index\narduino-cli core install ${profile.core}@${profile.version}\n${config.libraries.map(library => `arduino-cli lib install '${library.name}${library.version ? `@${library.version}` : ''}'`).join('\n')}${config.libraries.length ? '\n' : ''}arduino-cli compile --fqbn '${config.fqbn}' --output-dir firmware device\n\`\`\`\n\nThe compiled result is also included in firmware/. Core and library versions are recorded in dependency-lock.json. Arduino core supplies the controller application APIs. Additional configured libraries are installed and pinned above; a package dependency alone does not implement a device driver. Unsupported driver capabilities block export.\n\n## Upload only when ready\n\nWire and power components according to WIRING.md and their datasheets. Discover ports with \`arduino-cli board list\`, explicitly choose your board's port, then run:\n\n\`\`\`sh\narduino-cli upload --fqbn '${config.fqbn}' --port YOUR_DEVICE_PORT --input-dir firmware device\n\`\`\`\n\n${hasSerialInputs ? `## Computer controls\n\nInstall Python 3 and run:\n\n\`\`\`sh\npython3 -m venv .venv\n. .venv/bin/activate\npython -m pip install -r host/requirements.txt\npython host/controller.py --port YOUR_DEVICE_PORT\n\`\`\`\n\nThe bridge sends ASCII \`signalId=value\\n\` messages on changes, with a heartbeat every 50 ms at ${config.baudRate} baud. Keyboard shortcuts are global while the companion runs; press/release maps to 1/0; terminal \`signal=value\` commands support numeric controls. Escape/Ctrl-C returns inputs to defaults. The firmware returns serial inputs to their declared initial values after ${config.serialTimeoutMs} ms without valid input. Keep the computer connected while using remote controls. The keyboard listener may require Accessibility/Input Monitoring permission on macOS or a desktop session on Linux.\n\n` : ''}## Verification\n\nSee verification-report.json. Generated, compiled, simulation checked, and controller parity are separate results. Physical behavior has NOT been tested. Compilation cannot verify wiring, motor polarity, sensor calibration, current limits, or real-world dynamics. Upload success is not a physical behavior test. Open simulation.html for the same interactive simulation offline.\n`,
    'project.json': json({ projectId: run.projectId ?? run.id, revisionId: run.id, generatorVersion: HARDWARE_GENERATOR_VERSION, title: run.spec.title, goal: run.goal }),
  };
  if (hasSerialInputs) { files['host/controller.py'] = hostController(run, config); files['host/requirements.txt'] = 'pyserial==3.5\npynput==1.8.1\n'; }
  return files;
}
