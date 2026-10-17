import type { Assertion, ButtonInput, Candidate, RunSpec, Scenario } from './types.js';

/** Deterministic local rehearsal fixtures. These are never presented as model output. */
const airlockPins = [
  { componentId: 'outerRequest', pin: 2 }, { componentId: 'innerRequest', pin: 3 },
  { componentId: 'outerDoor', pin: 8 }, { componentId: 'innerDoor', pin: 9 },
];
export const airlockSpec: RunSpec = {
  goal: 'Build a spaceship airlock with two request buttons and two door-open LEDs.',
  assumptions: [
    'One Arduino Uno at 16 MHz. Outer/inner buttons connect to ground and use INPUT_PULLUP.',
    'An active-high LED means its door is open; the LED has a 220 ohm resistor to ground.',
    'Inputs must be continuously stable for at least 20 ms before a request is accepted.',
    'A request is a new debounced press edge. Busy requests are discarded, not queued.',
    'Reset creates a fresh Uno machine; no prior state survives reset.',
  ],
  components: [
    { id: 'outerRequest', kind: 'button', label: 'Outer request', meaning: 'Request opening of the outer door' },
    { id: 'innerRequest', kind: 'button', label: 'Inner request', meaning: 'Request opening of the inner door' },
    { id: 'outerDoor', kind: 'led', label: 'Outer door', meaning: 'High means outer door open' },
    { id: 'innerDoor', kind: 'led', label: 'Inner door', meaning: 'High means inner door open' },
  ],
  requirements: [
    { id: 'R1', text: 'Both door LEDs are driven off within 100 ms of startup.' },
    { id: 'R2', text: 'A button stable for 20 ms requests its door. Pulses shorter than 20 ms are ignored. An accepted request opens its door within 100 ms.' },
    { id: 'R3', text: 'Each accepted door opening lasts two seconds, within a 50 ms tolerance, then closes automatically.' },
    { id: 'R4', text: 'Both doors remain closed for at least 250 ms before another opening.' },
    { id: 'R5', text: 'Simultaneous requests are rejected until both buttons are released.' },
    { id: 'R6', text: 'Requests while a door is open or during the closed interval are discarded.' },
    { id: 'R7', text: 'Holding a button cannot repeatedly trigger cycles; a new release and press is required.' },
    { id: 'R8', text: 'The two door-open signals must never overlap.' },
    { id: 'R9', text: 'Reset restores the initial closed, idle state and accepts a new request.' },
  ],
};

const press = (componentId: string, atMs: number, releaseMs?: number): ButtonInput[] => [
  { componentId, atMs, pressed: true }, ...(releaseMs === undefined ? [] : [{ componentId, atMs: releaseMs, pressed: false }]),
];
const level = (id: string, signal: string, value: 0 | 1, fromMs: number, toMs: number, requirementIds: string[]): Assertion =>
  ({ id, type: 'level', signal, value, fromMs, toMs, requirementIds, driven: true });
const edge = (id: string, signal: string, fromMs: number, toMs: number, count: number, requirementIds: string[], direction: 'rising' | 'falling' = 'rising'): Assertion =>
  ({ id, type: 'transition', signal, edge: direction, fromMs, toMs, minCount: count, maxCount: count, requirementIds });
const duration = (id: string, signal: string, fromMs: number, toMs: number, count = 1): Assertion =>
  ({ id, type: 'duration', signal, value: 1, minMs: 1950, maxMs: 2050, minCount: count, fromMs, toMs, requirementIds: ['R3'] });
// First press at 100 ms: opening is permitted at 120–220 ms; closure at 2070–2270 ms.
// The mandatory 250 ms closed interval therefore finishes no earlier than 2320 ms,
// or at 2520 ms for the latest permitted closure. Follow-up requests avoid both edges.
const FIRST_LATEST_CLOSE_MS = 100 + 20 + 100 + 2050;
function airlockScenario(id: string, name: string, durationMs: number, inputs: ButtonInput[], checks: Assertion[]): Scenario {
  return { id, name, durationMs, inputs: inputs.sort((a, b) => a.atMs - b.atMs), assertions: [
    level(`${id}-startup-outer`, 'outerDoor', 0, 100, 119.999, ['R1']),
    level(`${id}-startup-inner`, 'innerDoor', 0, 100, 119.999, ['R1']),
    { id: `${id}-exclusive`, type: 'mutual-exclusion', signals: ['outerDoor', 'innerDoor'], fromMs: 0, toMs: durationMs, requirementIds: ['R8'] },
    ...checks,
  ] };
}
export const airlockScenarios: Scenario[] = [
  airlockScenario('startup', 'Startup: both doors are actively closed', 300, [], [
    level('startup-remains-outer', 'outerDoor', 0, 100, 300, ['R1']),
    level('startup-remains-inner', 'innerDoor', 0, 100, 300, ['R1']),
  ]),
  airlockScenario('outer', 'Outer request, debounce, and automatic closure', 2400, press('outerRequest', 100, 200), [
    level('outer-not-premature', 'outerDoor', 0, 100, 119.999, ['R2']),
    edge('outer-accepted', 'outerDoor', 120, 220, 1, ['R2']),
    level('outer-opens', 'outerDoor', 1, 225, 2000, ['R2']),
    duration('outer-two-seconds', 'outerDoor', 0, 2400),
    level('outer-auto-closes', 'outerDoor', 0, FIRST_LATEST_CLOSE_MS, 2400, ['R3']),
    level('outer-keeps-inner-closed', 'innerDoor', 0, 100, 2400, ['R8']),
  ]),
  airlockScenario('inner', 'Inner request and automatic closure', 2400, press('innerRequest', 100, 200), [
    edge('inner-accepted', 'innerDoor', 120, 220, 1, ['R2']),
    level('inner-opens', 'innerDoor', 1, 225, 2000, ['R2']),
    duration('inner-two-seconds', 'innerDoor', 0, 2400),
    level('inner-auto-closes', 'innerDoor', 0, FIRST_LATEST_CLOSE_MS, 2400, ['R3']),
  ]),
  airlockScenario('simultaneous', 'Simultaneous requests lock until both are released', 3000, [
    ...press('outerRequest', 100, 200), ...press('innerRequest', 100, 500),
    ...press('outerRequest', 300, 400), ...press('outerRequest', 700, 800),
  ], [
    level('simultaneous-outer-rejected', 'outerDoor', 0, 100, 700, ['R5']),
    level('simultaneous-inner-rejected', 'innerDoor', 0, 100, 3000, ['R5']),
    edge('simultaneous-rearmed', 'outerDoor', 720, 820, 1, ['R5', 'R2']),
    duration('simultaneous-rearmed-duration', 'outerDoor', 0, 3000),
  ]),
  ...[100.016, 100.041].map((atMs, index) => airlockScenario(
    `simultaneous-phase-${index + 1}`, `Simultaneous requests at ${atMs.toFixed(3)} ms`, 500,
    [...press('outerRequest', atMs), ...press('innerRequest', atMs)],
    [
      level(`simultaneous-phase-${index + 1}-outer-closed`, 'outerDoor', 0, 100, 500, ['R5']),
      level(`simultaneous-phase-${index + 1}-inner-closed`, 'innerDoor', 0, 100, 500, ['R5']),
    ],
  )),
  airlockScenario('held', 'A held button opens once and cannot repeat', 4900, press('outerRequest', 100), [
    edge('held-opens-once', 'outerDoor', 0, 4900, 1, ['R7']),
    duration('held-auto-closes', 'outerDoor', 0, 4900),
    level('held-stays-closed', 'outerDoor', 0, FIRST_LATEST_CLOSE_MS, 4900, ['R7']),
  ]),
  airlockScenario('bounce', 'Scripted switch bounce requires 20 ms stability', 2700, [
    ...press('outerRequest', 100, 110), ...press('outerRequest', 120, 130),
    ...press('outerRequest', 140, 150), ...press('outerRequest', 190, 200),
    ...press('outerRequest', 250, 600),
  ], [
    level('bounce-no-premature-opening', 'outerDoor', 0, 100, 269.999, ['R2']),
    edge('bounce-accepted-stable-request', 'outerDoor', 270, 370, 1, ['R2']),
    edge('bounce-one-opening', 'outerDoor', 0, 2700, 1, ['R2', 'R7']),
    duration('bounce-full-duration', 'outerDoor', 0, 2700),
  ]),
  airlockScenario('alternating', 'Alternate doors after the closed interval', 4900, [
    ...press('outerRequest', 100, 200), ...press('innerRequest', 2700, 2800),
  ], [
    edge('alternating-outer', 'outerDoor', 120, 220, 1, ['R2']),
    edge('alternating-inner', 'innerDoor', 2720, 2820, 1, ['R2']),
    duration('alternating-outer-duration', 'outerDoor', 0, 4900),
    duration('alternating-inner-duration', 'innerDoor', 0, 4900),
    { id: 'alternating-measured-deadtime', type: 'deadtime', signals: ['outerDoor', 'innerDoor'], minMs: 250, minCount: 1, fromMs: 0, toMs: 4900, requirementIds: ['R4'] },
    level('alternating-outer-closed-interval', 'outerDoor', 0, FIRST_LATEST_CLOSE_MS, 2700, ['R4']),
    level('alternating-inner-closed-interval', 'innerDoor', 0, FIRST_LATEST_CLOSE_MS, 2700, ['R4']),
  ]),
  airlockScenario('busy', 'Busy requests are discarded, including a held request', 4900, [
    ...press('outerRequest', 100, 200), ...press('innerRequest', 500, 3000),
    ...press('outerRequest', 900, 1000),
  ], [
    edge('busy-first-accepted', 'outerDoor', 120, 220, 1, ['R2']),
    edge('busy-no-repeat', 'outerDoor', 0, 4900, 1, ['R6', 'R7']),
    level('busy-inner-discarded', 'innerDoor', 0, 100, 4900, ['R6']),
    level('busy-not-queued', 'outerDoor', 0, FIRST_LATEST_CLOSE_MS, 4900, ['R6']),
    duration('busy-automatic-closure', 'outerDoor', 0, 4900),
  ]),
  airlockScenario('closed-interval', 'Cooldown requests are discarded before another opening', 4900, [
    ...press('outerRequest', 100, 200), ...press('innerRequest', 2190, 2230),
    ...press('innerRequest', 2280, 2310), ...press('innerRequest', 2700, 2800),
  ], [
    edge('closed-first-request', 'outerDoor', 120, 220, 1, ['R2']),
    level('closed-outer-low', 'outerDoor', 0, FIRST_LATEST_CLOSE_MS, 2700, ['R4']),
    level('closed-inner-low', 'innerDoor', 0, FIRST_LATEST_CLOSE_MS, 2700, ['R4', 'R6']),
    edge('closed-new-request-accepted', 'innerDoor', 2720, 2820, 1, ['R2', 'R4']),
    edge('closed-only-one-inner-opening', 'innerDoor', 0, 4900, 1, ['R4', 'R6']),
    duration('closed-inner-full-duration', 'innerDoor', 0, 4900),
    { id: 'closed-measured-deadtime', type: 'deadtime', signals: ['outerDoor', 'innerDoor'], minMs: 250, minCount: 1, fromMs: 0, toMs: 4900, requirementIds: ['R4'] },
  ]),
  airlockScenario('reset', 'A fresh reset is closed and accepts another request', 2400, press('innerRequest', 100, 200), [
    level('reset-outer-closed', 'outerDoor', 0, 100, 2400, ['R9']),
    edge('reset-inner-accepted', 'innerDoor', 120, 220, 1, ['R9', 'R2']),
    duration('reset-full-cycle', 'innerDoor', 0, 2400),
    level('reset-inner-closed', 'innerDoor', 0, FIRST_LATEST_CLOSE_MS, 2400, ['R9']),
  ]),
];

export const goodAirlockCandidate: Candidate = {
  id: 'rehearsal-airlock-repaired', pins: airlockPins,
  rationale: 'Local rehearsal repair: independent debounce, one-shot edges, concurrent-input settling, simultaneous lockout, timed opening, and discarded busy requests.',
  source: `// Local rehearsal fixture: repaired airlock controller.
const byte REQUEST[2] = {2, 3};
const byte DOOR[2] = {8, 9};
const unsigned long DEBOUNCE_US = 20008UL; // Two micros() ticks guard the strict 20 ms minimum.
const unsigned long OPEN_US = 2000000UL;
const unsigned long CLOSED_US = 250000UL;
bool rawPressed[2] = {false, false};
bool stablePressed[2] = {false, false};
unsigned long rawChangedAtUs[2] = {0, 0};
enum Phase { IDLE, OPEN, COOLDOWN, LOCKED };
Phase phase = IDLE;
byte activeDoor = 0;
unsigned long phaseAtUs = 0;
byte pendingDoor = 255;
unsigned long pendingAtUs = 0;
void setup() {
  for (byte i = 0; i < 2; ++i) {
    digitalWrite(DOOR[i], LOW);
    pinMode(DOOR[i], OUTPUT);
    pinMode(REQUEST[i], INPUT_PULLUP);
  }
}
void loop() {
  bool pressEdge[2] = {false, false};
  for (byte i = 0; i < 2; ++i) {
    const bool reading = digitalRead(REQUEST[i]) == LOW;
    const unsigned long sampledAtUs = micros();
    if (reading != rawPressed[i]) { rawPressed[i] = reading; rawChangedAtUs[i] = sampledAtUs; }
    if (reading != stablePressed[i] && sampledAtUs - rawChangedAtUs[i] >= DEBOUNCE_US) {
      stablePressed[i] = reading;
      pressEdge[i] = reading;
    }
  }
  if (phase == OPEN) {
    if (micros() - phaseAtUs >= OPEN_US) {
      digitalWrite(DOOR[activeDoor], LOW);
      phase = COOLDOWN;
      phaseAtUs = micros();
    }
    return;
  }
  if (phase == COOLDOWN) {
    // micros() has 4 us resolution; add one tick to preserve the strict lower bound.
    if (micros() - phaseAtUs >= CLOSED_US + 4UL) phase = IDLE;
    else return;
  }
  if (phase == LOCKED) {
    if (!stablePressed[0] && !stablePressed[1] && !rawPressed[0] && !rawPressed[1]) phase = IDLE;
    return;
  }
  if (phase != IDLE) return; // Edges while busy are consumed, never queued.
  if (stablePressed[0] && stablePressed[1]) { pendingDoor = 255; phase = LOCKED; return; }
  if (pendingDoor == 255 && (pressEdge[0] || pressEdge[1])) {
    pendingDoor = pressEdge[0] ? 0 : 1;
    pendingAtUs = micros();
  }
  if (pendingDoor != 255) {
    const byte otherDoor = 1 - pendingDoor;
    // Simultaneous physical presses can be sampled on opposite sides of a loop.
    // Let an already-low peer settle before accepting either debounced request.
    if (stablePressed[otherDoor]) { pendingDoor = 255; phase = LOCKED; return; }
    if (rawPressed[otherDoor] && micros() - pendingAtUs < DEBOUNCE_US) return;
    activeDoor = pendingDoor;
    pendingDoor = 255;
    digitalWrite(DOOR[activeDoor], HIGH);
    phase = OPEN;
    phaseAtUs = micros();
  }
}
`,
};

export const badAirlockCandidate: Candidate = {
  id: 'challenge-known-bad-both-doors', pins: airlockPins,
  rationale: 'Explicitly labeled repair challenge seed. This known-bad sketch opens both doors for either button.',
  source: `// KNOWN-BAD REPAIR CHALLENGE: unsafe coupled outputs.
void setup() {
  pinMode(2, INPUT_PULLUP); pinMode(3, INPUT_PULLUP);
  pinMode(8, OUTPUT); pinMode(9, OUTPUT);
  digitalWrite(8, LOW); digitalWrite(9, LOW);
}
void loop() {
  if (digitalRead(2) == LOW || digitalRead(3) == LOW) {
    digitalWrite(8, HIGH); digitalWrite(9, HIGH);
    delay(2000);
    digitalWrite(8, LOW); digitalWrite(9, LOW);
    delay(250);
  }
}
`,
};
export const neverOpensCandidate: Candidate = {
  id: 'negative-never-opens', pins: airlockPins, rationale: 'Negative control: no useful output.',
  source: 'void setup() { pinMode(2, INPUT_PULLUP); pinMode(3, INPUT_PULLUP); pinMode(8, OUTPUT); pinMode(9, OUTPUT); }\nvoid loop() {}\n',
};
export const serialPassCandidate: Candidate = {
  ...neverOpensCandidate, id: 'negative-serial-pass', rationale: 'Negative control: serial text has no verification authority.',
  source: 'void setup() { pinMode(2, INPUT_PULLUP); pinMode(3, INPUT_PULLUP); pinMode(8, OUTPUT); pinMode(9, OUTPUT); Serial.begin(9600); }\nvoid loop() { Serial.println("PASS"); delay(100); }\n',
};
export const missingPullupsCandidate: Candidate = {
  ...goodAirlockCandidate, id: 'negative-missing-pullups', rationale: 'Negative control: unpressed button nets float without required pull-ups.',
  source: goodAirlockCandidate.source.replace('pinMode(REQUEST[i], INPUT_PULLUP)', 'pinMode(REQUEST[i], INPUT)'),
};
export const malformedCandidate: Candidate = { ...neverOpensCandidate, id: 'negative-malformed', source: 'void setup( { not valid c++' };
export const blinkSpec: RunSpec = {
  goal: 'Blink one LED every 500 ms.', assumptions: ['Active-high LED with 220 ohm resistor.'],
  components: [{ id: 'blinkLed', kind: 'led', label: 'Blink LED', meaning: 'Illuminates when high' }],
  requirements: [{ id: 'BL1', text: 'Blink with 500 ms high and low intervals.' }],
};
export const blinkCandidate: Candidate = {
  id: 'milestone-blink', pins: [{ componentId: 'blinkLed', pin: 13 }], rationale: 'Compiler and simulator baseline.',
  source: 'void setup() { pinMode(13, OUTPUT); digitalWrite(13, LOW); }\nvoid loop() { delay(500); digitalWrite(13, HIGH); delay(500); digitalWrite(13, LOW); }\n',
};
export const blinkScenarios: Scenario[] = [{
  id: 'blink', name: 'Known Blink baseline', durationMs: 2200, inputs: [], assertions: [
    edge('blink-rises', 'blinkLed', 0, 2200, 2, ['BL1']),
    { id: 'blink-duration', type: 'duration', signal: 'blinkLed', value: 1, fromMs: 0, toMs: 2200, minMs: 495, maxMs: 505, minCount: 2, requirementIds: ['BL1'] },
  ],
}];
export const buttonSpec: RunSpec = {
  goal: 'Illuminate an LED while a button is held.', assumptions: ['Button to ground with internal pull-up; active-high LED.'],
  components: [{ id: 'button', kind: 'button', label: 'Button', meaning: 'Press to illuminate LED' }, { id: 'buttonLed', kind: 'led', label: 'LED', meaning: 'Illuminates while button is pressed' }],
  requirements: [{ id: 'BU1', text: 'LED follows the button.' }],
};
export const buttonCandidate: Candidate = {
  id: 'milestone-button', pins: [{ componentId: 'button', pin: 2 }, { componentId: 'buttonLed', pin: 8 }], rationale: 'Pull-up and button input baseline.',
  source: 'void setup() { pinMode(2, INPUT_PULLUP); pinMode(8, OUTPUT); }\nvoid loop() { digitalWrite(8, digitalRead(2) == LOW ? HIGH : LOW); }\n',
};
export const buttonScenarios: Scenario[] = [{ id: 'button', name: 'Known button baseline', durationMs: 500, inputs: press('button', 100, 300), assertions: [
  level('button-off', 'buttonLed', 0, 20, 99, ['BU1']), level('button-on', 'buttonLed', 1, 110, 299, ['BU1']),
  level('button-released', 'buttonLed', 0, 310, 500, ['BU1']), edge('button-one-rise', 'buttonLed', 0, 500, 1, ['BU1']),
] }];

export const buzzerSpec: RunSpec = {
  goal: 'Build a two-player quiz buzzer: first press wins; reset starts a new round.',
  assumptions: ['Three active-low buttons use internal pull-ups. Two active-high LEDs identify the winner.', 'All buttons debounce for 20 ms. Simultaneous presses award player one as an explicit tie-break.', 'Reset clears the winner, and a held player button cannot win a new round until released and pressed again.'],
  components: [
    { id: 'playerOne', kind: 'button', label: 'Player one', meaning: 'Player one buzz request' },
    { id: 'playerTwo', kind: 'button', label: 'Player two', meaning: 'Player two buzz request' },
    { id: 'resetRound', kind: 'button', label: 'Reset round', meaning: 'Clear winner for a new round' },
    { id: 'winnerOne', kind: 'led', label: 'Player one wins', meaning: 'High means player one won' },
    { id: 'winnerTwo', kind: 'led', label: 'Player two wins', meaning: 'High means player two won' },
  ],
  requirements: [
    { id: 'B1', text: 'Both winner LEDs are driven off within 100 ms of startup.' },
    { id: 'B2', text: 'The first stable 20 ms player press illuminates only that player within 100 ms.' },
    { id: 'B3', text: 'The winner remains latched and other buzz requests are ignored until reset.' },
    { id: 'B4', text: 'A stable reset clears both LEDs and enables a new round; held buttons do not win again.' },
    { id: 'B5', text: 'Simultaneous player requests award player one; winner signals never overlap.' },
  ],
};
export const goodBuzzerCandidate: Candidate = {
  id: 'rehearsal-two-player-buzzer', rationale: 'Local rehearsal fixture: a separately specified first-press-wins game.',
  pins: [{ componentId: 'playerOne', pin: 2 }, { componentId: 'playerTwo', pin: 3 }, { componentId: 'resetRound', pin: 4 }, { componentId: 'winnerOne', pin: 8 }, { componentId: 'winnerTwo', pin: 9 }],
  source: `// Local rehearsal fixture: two-player quiz buzzer.
const byte BUTTONS[3] = {2, 3, 4};
bool rawState[3] = {false, false, false};
bool stableState[3] = {false, false, false};
unsigned long changedAtUs[3] = {0, 0, 0};
byte winner = 0;
void setup() {
  for (byte i = 0; i < 3; ++i) pinMode(BUTTONS[i], INPUT_PULLUP);
  digitalWrite(8, LOW); digitalWrite(9, LOW); pinMode(8, OUTPUT); pinMode(9, OUTPUT);
}
void loop() {
  bool pressed[3] = {false, false, false};
  for (byte i = 0; i < 3; ++i) {
    bool value = digitalRead(BUTTONS[i]) == LOW;
    const unsigned long sampledAtUs = micros();
    if (value != rawState[i]) { rawState[i] = value; changedAtUs[i] = sampledAtUs; }
    if (value != stableState[i] && sampledAtUs - changedAtUs[i] >= 20008UL) { stableState[i] = value; pressed[i] = value; }
  }
  if (pressed[2]) { winner = 0; digitalWrite(8, LOW); digitalWrite(9, LOW); return; }
  if (winner == 0) {
    if (pressed[0]) winner = 1;
    else if (pressed[1]) winner = 2;
    if (winner == 1) digitalWrite(8, HIGH);
    if (winner == 2) digitalWrite(9, HIGH);
  }
}
`,
};
function buzzerScenario(id: string, name: string, durationMs: number, inputs: ButtonInput[], assertions: Assertion[]): Scenario {
  return { id, name, durationMs, inputs: inputs.sort((a, b) => a.atMs - b.atMs), assertions: [
    level(`${id}-startup-one`, 'winnerOne', 0, 100, 119.999, ['B1']), level(`${id}-startup-two`, 'winnerTwo', 0, 100, 119.999, ['B1']),
    { id: `${id}-exclusive`, type: 'mutual-exclusion', signals: ['winnerOne', 'winnerTwo'], fromMs: 0, toMs: durationMs, requirementIds: ['B5'] }, ...assertions,
  ] };
}
export const buzzerScenarios: Scenario[] = [
  buzzerScenario('buzzer-first', 'Player one wins and stays latched', 1000, [...press('playerOne', 100, 200), ...press('playerTwo', 400, 500)], [
    edge('buzzer-one-accepted', 'winnerOne', 120, 220, 1, ['B2']), level('buzzer-one-latched', 'winnerOne', 1, 225, 1000, ['B3']),
    level('buzzer-two-ignored', 'winnerTwo', 0, 100, 1000, ['B3']),
  ]),
  buzzerScenario('buzzer-second', 'Player two can win first', 1000, [...press('playerTwo', 100, 200), ...press('playerOne', 400, 500)], [
    edge('buzzer-two-accepted', 'winnerTwo', 120, 220, 1, ['B2']), level('buzzer-two-latched', 'winnerTwo', 1, 225, 1000, ['B3']),
    level('buzzer-one-ignored', 'winnerOne', 0, 100, 1000, ['B3']),
  ]),
  buzzerScenario('buzzer-reset', 'Reset clears winner; held buttons need a new press', 1500, [
    ...press('playerOne', 100, 700), ...press('resetRound', 400, 500), ...press('playerTwo', 900, 1000),
  ], [
    edge('buzzer-reset-first-win', 'winnerOne', 120, 220, 1, ['B2']), level('buzzer-reset-clears', 'winnerOne', 0, 525, 1500, ['B4']),
    level('buzzer-reset-no-held-win', 'winnerTwo', 0, 525, 900, ['B4']), edge('buzzer-reset-new-round', 'winnerTwo', 920, 1020, 1, ['B4']),
  ]),
  buzzerScenario('buzzer-tie', 'Simultaneous requests use the stated tie-break', 700, [...press('playerOne', 100, 200), ...press('playerTwo', 100, 200)], [
    level('buzzer-tie-one-wins', 'winnerOne', 1, 225, 700, ['B5']), level('buzzer-tie-two-off', 'winnerTwo', 0, 100, 700, ['B5']),
    edge('buzzer-tie-useful-output', 'winnerOne', 120, 220, 1, ['B2']),
  ]),
];
