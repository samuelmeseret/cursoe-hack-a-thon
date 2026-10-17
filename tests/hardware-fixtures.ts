import type { SimulationAgentService } from '../server/simulation-controller';
import type { HardwareConfiguration } from '../shared/hardware-project';
import { composeControllerSimulation, type PortableControllerProgram, type PortableExpression, type PortableOperation } from '../shared/portable-controller';
import type { SimulationCandidate, SimulationScenario, SimulationSpec } from '../shared/simulation-types';

const ref = (id: string): PortableExpression => ({ ref: id });
const op = (op: PortableOperation, ...args: PortableExpression[]): PortableExpression => ({ op, args });
export interface HardwareFixture { name: string; spec: SimulationSpec; program: PortableControllerProgram; environment: string; scenarios: SimulationScenario[]; configuration: HardwareConfiguration }
const configuration = (fqbn: string, bindings: HardwareConfiguration['bindings']): HardwareConfiguration => ({ fqbn, bindings, libraries: [], baudRate: 115200, serialTimeoutMs: 500 });

export const keyboardCar: HardwareFixture = {
  name: 'keyboard-car',
  spec: {
    goal: 'Build a keyboard-controlled physical car with forward, reverse, left, right, and stop on release.', title: 'Keyboard controlled car', summary: 'Four computer keys drive two independently controlled wheels through a USB serial bridge.',
    assumptions: ['A dual motor driver with direction and PWM inputs is required.', 'The computer remains connected over USB serial.', 'The environment is an idealized differential-drive model.'],
    controls: [
      { id: 'forward', label: 'Forward', type: 'key', key: 'ArrowUp', initial: false }, { id: 'reverse', label: 'Reverse', type: 'key', key: 'ArrowDown', initial: false },
      { id: 'left', label: 'Turn left', type: 'key', key: 'ArrowLeft', initial: false }, { id: 'right', label: 'Turn right', type: 'key', key: 'ArrowRight', initial: false },
    ],
    observables: [{ id: 'x', label: 'Position', type: 'number' }, { id: 'heading', label: 'Heading', type: 'number' }, { id: 'leftPower', label: 'Left power', type: 'number' }, { id: 'rightPower', label: 'Right power', type: 'number' }, { id: 'leftForward', label: 'Left direction', type: 'boolean' }],
    requirements: [{ id: 'R1', text: 'Forward drives both wheels and moves the model forward.' }, { id: 'R2', text: 'Reverse changes direction and moves the model backward.' }, { id: 'R3', text: 'Left and right produce opposite turns.' }, { id: 'R4', text: 'Releasing all keys stops both motor outputs.' }],
  },
  program: {
    version: 1, name: 'Differential drive controller', inputs: ['forward', 'reverse', 'left', 'right'].map((id, index) => ({ id, label: id, type: 'boolean', initial: false, key: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'][index], hardware: { kind: 'serial', component: 'Computer keyboard over USB serial' } })),
    state: [{ id: 'throttle', type: 'number', initial: 0 }, { id: 'turn', type: 'number', initial: 0 }, { id: 'leftSigned', type: 'number', initial: 0 }, { id: 'rightSigned', type: 'number', initial: 0 }],
    outputs: [
      { id: 'leftForward', label: 'Left direction', type: 'boolean', initial: true, hardware: { kind: 'digital-output', component: 'Left motor driver DIR' } },
      { id: 'rightForward', label: 'Right direction', type: 'boolean', initial: true, hardware: { kind: 'digital-output', component: 'Right motor driver DIR' } },
      { id: 'leftPower', label: 'Left power', type: 'number', initial: 0, hardware: { kind: 'pwm-output', component: 'Left motor driver PWM', min: 0, max: 255 } },
      { id: 'rightPower', label: 'Right power', type: 'number', initial: 0, hardware: { kind: 'pwm-output', component: 'Right motor driver PWM', min: 0, max: 255 } },
    ], step: [], update: [
      { set: 'throttle', value: op('sub', op('select', ref('forward'), 160, 0), op('select', ref('reverse'), 160, 0)) },
      { set: 'turn', value: op('sub', op('select', ref('left'), 80, 0), op('select', ref('right'), 80, 0)) },
      { set: 'leftSigned', value: op('sub', ref('throttle'), ref('turn')) }, { set: 'rightSigned', value: op('add', ref('throttle'), ref('turn')) },
      { set: 'leftForward', value: op('gte', ref('leftSigned'), 0) }, { set: 'rightForward', value: op('gte', ref('rightSigned'), 0) },
      { set: 'leftPower', value: op('abs', ref('leftSigned')) }, { set: 'rightPower', value: op('abs', ref('rightSigned')) },
    ],
  },
  environment: `function createEnvironment(controller) {
    let x = 0, y = 0, heading = 0;
    return { reset(){x=0;y=0;heading=0;}, input(){}, step(dt){
      const left = controller.get('leftPower') * (controller.get('leftForward') ? 1 : -1);
      const right = controller.get('rightPower') * (controller.get('rightForward') ? 1 : -1);
      heading += (right-left)/255*dt; x += (left+right)/2/255*100*Math.cos(heading)*dt; y += (left+right)/2/255*100*Math.sin(heading)*dt;
    },snapshot(){return {x,y,heading};},draw(ctx,w,h){ctx.fillStyle='#eff2f0';ctx.fillRect(0,0,w,h);ctx.save();ctx.translate(w/2+x,h/2+y);ctx.rotate(heading);ctx.fillStyle='#237568';ctx.fillRect(-18,-10,36,20);ctx.restore();} };
  }`,
  scenarios: [
    { id: 'motion', name: 'Forward reverse and release', steps: [
      { type: 'input', controlId: 'forward', value: true }, { type: 'advance', durationMs: 1000 },
      { type: 'assert', id: 'forward-motion', observable: 'x', operator: 'gt', value: 50, requirementIds: ['R1'] },
      { type: 'input', controlId: 'forward', value: false }, { type: 'input', controlId: 'reverse', value: true }, { type: 'advance', durationMs: 2000 },
      { type: 'assert', id: 'reverse-motion', observable: 'x', operator: 'lt', value: -50, requirementIds: ['R2'] },
      { type: 'assert', id: 'reverse-direction', observable: 'leftForward', operator: 'eq', value: false, requirementIds: ['R2'] },
      { type: 'input', controlId: 'reverse', value: false }, { type: 'assert', id: 'left-stop', observable: 'leftPower', operator: 'eq', value: 0, requirementIds: ['R4'] },
      { type: 'assert', id: 'right-stop', observable: 'rightPower', operator: 'eq', value: 0, requirementIds: ['R4'] },
    ] },
    { id: 'steering', name: 'Opposite steering commands', steps: [
      { type: 'input', controlId: 'left', value: true }, { type: 'advance', durationMs: 1000 }, { type: 'assert', id: 'left-turn', observable: 'heading', operator: 'gt', value: 0.5, requirementIds: ['R3'] },
      { type: 'input', controlId: 'left', value: false }, { type: 'input', controlId: 'right', value: true }, { type: 'advance', durationMs: 2000 }, { type: 'assert', id: 'right-turn', observable: 'heading', operator: 'lt', value: -0.5, requirementIds: ['R3'] },
    ] },
  ],
  configuration: configuration('arduino:avr:uno', [
    ...['forward', 'reverse', 'left', 'right'].map(signalId => ({ signalId, direction: 'input' as const, kind: 'serial' as const, component: 'Computer keyboard via USB serial' })),
    { signalId: 'leftForward', direction: 'output', kind: 'digital-output', pin: '4', component: 'Left motor driver DIR', notes: 'Dual DIR/PWM motor driver; common signal ground; separately powered motor supply.' },
    { signalId: 'rightForward', direction: 'output', kind: 'digital-output', pin: '7', component: 'Right motor driver DIR' },
    { signalId: 'leftPower', direction: 'output', kind: 'pwm-output', pin: '5', component: 'Left motor driver PWM' },
    { signalId: 'rightPower', direction: 'output', kind: 'pwm-output', pin: '6', component: 'Right motor driver PWM' },
  ]),
};

export const thermostat: HardwareFixture = {
  name: 'thermostat',
  spec: { goal: 'Build a thermostat with analog temperature sensing, enable switch, and hysteresis cooling control.', title: 'Hysteresis thermostat', summary: 'Cooling starts at 30 °C and stops at 26 °C; disabling always stops cooling.', assumptions: ['The analog sensor maps 0..1023 to 0..100 °C after calibration.', 'A suitable relay or transistor drives the cooling load.'], controls: [{ id: 'temperature', label: 'Temperature', type: 'range', min: 0, max: 100, initial: 22 }, { id: 'enabled', label: 'Enabled', type: 'toggle', initial: true }], observables: [{ id: 'cooling', label: 'Cooling output', type: 'boolean' }], requirements: [{ id: 'R1', text: 'Start cooling at or above 30 °C.' }, { id: 'R2', text: 'Preserve cooling in the hysteresis band and stop at 26 °C.' }, { id: 'R3', text: 'Disabling forces cooling off.' }] },
  program: { version: 1, name: 'Temperature controller', inputs: [{ id: 'temperature', label: 'Temperature', type: 'number', initial: 22, hardware: { kind: 'analog-input', component: 'Calibrated analog temperature sensor', min: 0, max: 100, unit: 'C' } }, { id: 'enabled', label: 'Enabled', type: 'boolean', initial: true, hardware: { kind: 'digital-input', component: 'Enable switch' } }], state: [], outputs: [{ id: 'cooling', label: 'Cooling', type: 'boolean', initial: false, hardware: { kind: 'digital-output', component: 'Cooling relay driver' } }], step: [], update: [{ if: op('not', ref('enabled')), then: [{ set: 'cooling', value: false }], else: [{ if: op('gte', ref('temperature'), 30), then: [{ set: 'cooling', value: true }], else: [{ if: op('lte', ref('temperature'), 26), then: [{ set: 'cooling', value: false }] }] }] }] },
  environment: `function createEnvironment(controller){return {reset(){},input(){},step(){},snapshot(){return {};},draw(ctx,w,h){ctx.fillStyle=controller.get('cooling')?'#72b8cd':'#d9b38b';ctx.fillRect(0,0,w,h);ctx.fillStyle='#222';ctx.font='24px sans-serif';ctx.fillText(controller.get('temperature')+' C',30,60);}};}`,
  scenarios: [{ id: 'hysteresis', name: 'Thresholds and disable', steps: [
    { type: 'input', controlId: 'temperature', value: 31 }, { type: 'advance', durationMs: 100 }, { type: 'assert', id: 'cooling-starts', observable: 'cooling', operator: 'eq', value: true, requirementIds: ['R1'] },
    { type: 'input', controlId: 'temperature', value: 28 }, { type: 'assert', id: 'band-retains', observable: 'cooling', operator: 'eq', value: true, requirementIds: ['R2'] },
    { type: 'input', controlId: 'temperature', value: 26 }, { type: 'assert', id: 'low-stops', observable: 'cooling', operator: 'eq', value: false, requirementIds: ['R2'] },
    { type: 'input', controlId: 'temperature', value: 35 }, { type: 'input', controlId: 'enabled', value: false }, { type: 'assert', id: 'disable-stops', observable: 'cooling', operator: 'eq', value: false, requirementIds: ['R3'] },
  ] }],
  configuration: configuration('arduino:samd:mkrzero', [
    { signalId: 'temperature', direction: 'input', kind: 'analog-input', pin: 'A0', component: 'Calibrated analog temperature sensor', minimum: 0, maximum: 100, notes: 'Use a sensor whose output stays within 0..3.3 V; map and calibrate its voltage-to-temperature range.' },
    { signalId: 'enabled', direction: 'input', kind: 'digital-input', pin: '2', component: 'Enable switch to ground', activeLow: true },
    { signalId: 'cooling', direction: 'output', kind: 'digital-output', pin: '7', component: '3.3 V compatible cooling relay driver' },
  ]),
};

export const timedLight: HardwareFixture = {
  name: 'timed-light',
  spec: { goal: 'Build a pushbutton lamp that stays on for two seconds after a press and then switches off.', title: 'Timed task light', summary: 'A press starts a two-second light pulse; releasing the button does not cancel it.', assumptions: ['The button connects to ground with an internal pull-up.', 'The LED has a current-limiting resistor.'], controls: [{ id: 'start', label: 'Start timer', type: 'button', initial: false }], observables: [{ id: 'lamp', label: 'Lamp output', type: 'boolean' }, { id: 'remaining', label: 'Seconds remaining', type: 'number' }], requirements: [{ id: 'R1', text: 'A button press turns on the lamp for two seconds.' }, { id: 'R2', text: 'Releasing the button does not cancel the light.' }, { id: 'R3', text: 'The lamp turns off after the timer expires.' }, { id: 'R4', text: 'Reset leaves the lamp off.' }] },
  program: { version: 1, name: 'Timed lamp controller', inputs: [{ id: 'start', label: 'Start timer', type: 'boolean', initial: false, hardware: { kind: 'digital-input', component: 'Momentary pushbutton' } }], state: [{ id: 'remaining', type: 'number', initial: 0 }], outputs: [{ id: 'lamp', label: 'Lamp', type: 'boolean', initial: false, hardware: { kind: 'digital-output', component: 'LED and current-limiting resistor' } }], onInput: { start: [{ if: ref('start'), then: [{ set: 'remaining', value: 2 }] }] }, step: [{ set: 'remaining', value: op('max', 0, op('sub', ref('remaining'), { dt: true })) }], update: [{ set: 'lamp', value: op('gt', ref('remaining'), 0) }] },
  environment: `function createEnvironment(controller){return {reset(){},input(){},step(){},snapshot(){return {};},draw(ctx,w,h){ctx.fillStyle='#243344';ctx.fillRect(0,0,w,h);ctx.beginPath();ctx.arc(w/2,h/2,55,0,Math.PI*2);ctx.fillStyle=controller.get('lamp')?'#ffd660':'#59616d';ctx.fill();}};}`,
  scenarios: [{ id: 'pulse', name: 'Timed pulse release and reset', steps: [
    { type: 'input', controlId: 'start', value: true }, { type: 'advance', durationMs: 500 }, { type: 'assert', id: 'lamp-on', observable: 'lamp', operator: 'eq', value: true, requirementIds: ['R1'] },
    { type: 'input', controlId: 'start', value: false }, { type: 'advance', durationMs: 500 }, { type: 'assert', id: 'release-holds', observable: 'lamp', operator: 'eq', value: true, requirementIds: ['R2'] },
    { type: 'advance', durationMs: 1200 }, { type: 'assert', id: 'expires', observable: 'lamp', operator: 'eq', value: false, requirementIds: ['R3'] },
    { type: 'input', controlId: 'start', value: true }, { type: 'reset' }, { type: 'advance', durationMs: 100 }, { type: 'assert', id: 'reset-off', observable: 'lamp', operator: 'eq', value: false, requirementIds: ['R4'] },
  ] }],
  configuration: configuration('arduino:avr:uno', [{ signalId: 'start', direction: 'input', kind: 'digital-input', pin: '2', component: 'Pushbutton to ground', activeLow: true }, { signalId: 'lamp', direction: 'output', kind: 'digital-output', pin: '8', component: 'LED with 330 ohm series resistor' }]),
};

export const hardwareFixtures = [keyboardCar, thermostat, timedLight];
export function fixtureCandidate(fixture: HardwareFixture): SimulationCandidate { return { id: fixture.name, rationale: 'Controller behavior is shared with hardware; the visual model only draws or models the environment.', source: composeControllerSimulation(fixture.program, fixture.environment), controller: structuredClone(fixture.program), environmentSource: fixture.environment }; }
/** Deterministic generation only; browser checks and compilers remain real in the integration suite. */
export class HardwareFixtureAgents implements SimulationAgentService {
  readonly model = 'deterministic-hardware-fixture';
  constructor(public fixture: HardwareFixture) {}
  async validateModel() {}
  async specify(goal: string) { return { ...structuredClone(this.fixture.spec), goal }; }
  async verify() { return structuredClone(this.fixture.scenarios); }
  async build() { return fixtureCandidate(this.fixture); }
}
