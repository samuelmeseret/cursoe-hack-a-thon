export type AgentName =
  | 'planner'
  | 'coder'
  | 'verifier'
  | 'compile'
  | 'sim'
  | 'supervisor'

export type AgentEventType = 'started' | 'output' | 'passed' | 'failed' | 'decision'
export type CriterionId = 'led-timing' | 'button-serial' | 'nonblocking-response'

export interface AcceptanceCriterion {
  id: CriterionId
  description: string
}

export interface PlannerSpec {
  goal: string
  board: string
  ledPin: number
  buttonPin: number
  buttonMode: 'INPUT_PULLUP'
  blinkIntervalMs: number
  debounceMs: number
  serialBaud: number
  assumptions: string[]
  acceptanceCriteria: AcceptanceCriterion[]
}

export interface SketchReference {
  version: number
  revision: number
}

export interface SketchOutput extends SketchReference {
  filename: string
  language: 'cpp'
  code: string
  summary: string
}

/** Times in pin traces and serial output are milliseconds since simulated boot. */
export interface PinSample {
  atMs: number
  pin: number
  level: 'HIGH' | 'LOW'
}

export interface SerialLine {
  atMs: number
  text: string
}

export interface VerificationScenario {
  name: string
  durationMs: number
  criteria: CriterionId[]
  buttonTransitions: PinSample[]
  expectedSerialOutput: SerialLine[]
  description: string
}

export interface CompileDiagnostic {
  severity: 'error'
  filename: string
  line: number
  column: number
  message: string
  /** Stable across source-line changes, so repeated failures can be detected. */
  fingerprint: string
}

export interface CompileFailure {
  sketch: SketchReference
  command: string
  exitCode: 1
  diagnostics: CompileDiagnostic[]
}

export interface CompileSuccess {
  sketch: SketchReference
  command: string
  exitCode: 0
  artifact: string
  summary: string
}

export interface SupervisorDecision {
  decision: 'replan' | 'retry' | 'abort'
  reason: string
  diagnosticFingerprint: string
  failedAttempts: number[]
  nextAttempt: number
  instructions: string[]
}

export interface CriterionResult {
  criterionId: CriterionId
  status: 'passed' | 'failed'
  evidence: string
}

export interface SimulationResult {
  sketch: SketchReference
  scenario: string
  durationMs: number
  criteria: CriterionResult[]
  ledTrace: PinSample[]
  serialOutput: SerialLine[]
}

export interface FinalVerdict {
  sketch: SketchReference
  summary: string
  criteria: CriterionId[]
  evidence: 'mock-simulation'
  limitations: string[]
}

type EventEnvelope<
  Agent extends AgentName,
  Type extends AgentEventType,
  Content extends object,
> = Agent extends AgentName ? {
  agent: Agent
  type: Type
  /** One-based build attempt; a repair increments it even within sketch v1. */
  attempt: number
  content: Content
  /** Unix epoch milliseconds, independent of the simulated board clock. */
  timestamp: number
} : never

/** Narrow by agent and type to get the corresponding content, without casts. */
export type AgentEvent =
  | EventEnvelope<AgentName, 'started', { summary: string }>
  | EventEnvelope<'planner', 'output', PlannerSpec>
  | EventEnvelope<'coder', 'output', SketchOutput>
  | EventEnvelope<'verifier', 'output', VerificationScenario>
  | EventEnvelope<'compile', 'failed', CompileFailure>
  | EventEnvelope<'compile', 'passed', CompileSuccess>
  | EventEnvelope<'supervisor', 'decision', SupervisorDecision>
  | EventEnvelope<'sim', 'passed', SimulationResult>
  | EventEnvelope<'sim', 'failed', SimulationResult>
  | EventEnvelope<'supervisor', 'passed', FinalVerdict>
  | EventEnvelope<'supervisor', 'failed', FinalVerdict>

export const mockGoal =
  "Blink an LED on pin 13 every 500ms and print 'pressed' to serial when a button on pin 2 is pushed"

const sketchV1 = `#include <Arduino.h>

constexpr uint8_t LED_PIN = 13;
constexpr unsigned long BLINK_INTERVAL_MS = 500;
constexpr unsigned long DEBOUNCE_MS = 30;

unsigned long lastBlinkAt = 0;
unsigned long lastButtonEdgeAt = 0;
bool ledOn = false;
int lastRawButton = HIGH;
int stableButton = HIGH;

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(2, INPUT_PULLUP);
  Serial.begin(9600);
}

void loop() {
  const unsigned long now = millis();
  if (now - lastBlinkAt >= BLINK_INTERVAL_MS) {
    lastBlinkAt = now;
    ledOn = !ledOn;
    digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
  }

  const int rawButton = digitalRead(BUTTON_PIN);
  if (rawButton != lastRawButton) {
    lastRawButton = rawButton;
    lastButtonEdgeAt = now;
  }

  if (rawButton != stableButton && now - lastButtonEdgeAt >= DEBOUNCE_MS) {
    stableButton = rawButton;
    if (stableButton == LOW) {
      Serial.println("pressed");
    }
  }
}
`

// The attempted repair declares BUTTON_PIN locally; loop() still cannot see it.
const sketchV1Repair = sketchV1.replace(
  '  pinMode(2, INPUT_PULLUP);',
  '  constexpr uint8_t BUTTON_PIN = 2;\n  pinMode(BUTTON_PIN, INPUT_PULLUP);',
)

const sketchV2 = sketchV1
  .replace(
    'constexpr uint8_t LED_PIN = 13;',
    'constexpr uint8_t LED_PIN = 13;\nconstexpr uint8_t BUTTON_PIN = 2;',
  )
  .replace('  pinMode(2, INPUT_PULLUP);', '  pinMode(BUTTON_PIN, INPUT_PULLUP);')

const startedAt = Date.parse('2026-10-17T12:00:00-07:00')
const compileCommand = 'arduino-cli compile --fqbn arduino:avr:uno --output-dir build sketch'
const missingPinMessage = "'BUTTON_PIN' was not declared in this scope"
const missingPinFingerprint = 'avr-g++:undeclared-identifier:BUTTON_PIN'

/** Synthetic fixture only: no compiler, simulator, or hardware is invoked here. */
export const mockRun: AgentEvent[] = [
  {
    agent: 'planner',
    type: 'started',
    attempt: 1,
    timestamp: startedAt,
    content: { summary: 'Planning the LED timing, button wiring, and acceptance checks.' },
  },
  {
    agent: 'planner',
    type: 'output',
    attempt: 1,
    timestamp: startedAt + 1_200,
    content: {
      goal: mockGoal,
      board: 'arduino:avr:uno',
      ledPin: 13,
      buttonPin: 2,
      buttonMode: 'INPUT_PULLUP',
      blinkIntervalMs: 500,
      debounceMs: 30,
      serialBaud: 9600,
      assumptions: [
        'Use the Arduino Uno onboard LED on pin 13; start with the LED off.',
        'Every 500ms means toggle every 500ms: 500ms on, 500ms off.',
        'Wire the button between pin 2 and GND: released is HIGH, pressed is LOW.',
        'Print once per debounced press, without repeating while the button is held.',
      ],
      acceptanceCriteria: [
        { id: 'led-timing', description: 'Pin 13 toggles every 500ms, within a 5ms tolerance.' },
        {
          id: 'button-serial',
          description: 'At 9600 baud, print exactly "pressed" once per press; ignore bounce, holds, and releases.',
        },
        {
          id: 'nonblocking-response',
          description: 'Report each stable press within 50ms while preserving the LED cadence; do not use delay().',
        },
      ],
    },
  },
  {
    agent: 'coder',
    type: 'output',
    attempt: 1,
    timestamp: startedAt + 4_800,
    content: {
      version: 1,
      revision: 1,
      filename: 'sketch.ino',
      language: 'cpp',
      code: sketchV1,
      summary: 'Initial sketch: millis() LED timing, INPUT_PULLUP button, and 30ms edge debounce.',
    },
  },
  {
    agent: 'verifier',
    type: 'output',
    attempt: 1,
    timestamp: startedAt + 6_100,
    content: {
      name: 'blink-with-bouncing-button',
      durationMs: 3_000,
      criteria: ['led-timing', 'button-serial', 'nonblocking-response'],
      description: 'Run loop() every 1ms. Inject two bouncing presses, a long hold, and releases across LED transitions.',
      buttonTransitions: [
        { atMs: 0, pin: 2, level: 'HIGH' },
        { atMs: 750, pin: 2, level: 'LOW' },
        { atMs: 754, pin: 2, level: 'HIGH' },
        { atMs: 758, pin: 2, level: 'LOW' },
        { atMs: 1_350, pin: 2, level: 'HIGH' },
        { atMs: 1_354, pin: 2, level: 'LOW' },
        { atMs: 1_358, pin: 2, level: 'HIGH' },
        { atMs: 2_250, pin: 2, level: 'LOW' },
        { atMs: 2_254, pin: 2, level: 'HIGH' },
        { atMs: 2_258, pin: 2, level: 'LOW' },
        { atMs: 2_600, pin: 2, level: 'HIGH' },
      ],
      expectedSerialOutput: [
        { atMs: 788, text: 'pressed' },
        { atMs: 2_288, text: 'pressed' },
      ],
    },
  },
  {
    agent: 'compile',
    type: 'failed',
    attempt: 1,
    timestamp: startedAt + 7_900,
    content: {
      sketch: { version: 1, revision: 1 },
      command: compileCommand,
      exitCode: 1,
      diagnostics: [{
        severity: 'error', filename: 'sketch.ino', line: 28, column: 37,
        message: missingPinMessage, fingerprint: missingPinFingerprint,
      }],
    },
  },
  {
    agent: 'coder',
    type: 'output',
    attempt: 2,
    timestamp: startedAt + 10_600,
    content: {
      version: 1,
      revision: 2,
      filename: 'sketch.ino',
      language: 'cpp',
      code: sketchV1Repair,
      summary: 'Attempted fix: declare BUTTON_PIN inside setup() and use it for pinMode().',
    },
  },
  {
    agent: 'compile',
    type: 'failed',
    attempt: 2,
    timestamp: startedAt + 12_300,
    content: {
      sketch: { version: 1, revision: 2 },
      command: compileCommand,
      exitCode: 1,
      diagnostics: [{
        severity: 'error', filename: 'sketch.ino', line: 29, column: 37,
        message: missingPinMessage, fingerprint: missingPinFingerprint,
      }],
    },
  },
  {
    agent: 'supervisor',
    type: 'decision',
    attempt: 2,
    timestamp: startedAt + 13_200,
    content: {
      decision: 'replan',
      reason: 'same compile error twice',
      diagnosticFingerprint: missingPinFingerprint,
      failedAttempts: [1, 2],
      nextAttempt: 3,
      instructions: [
        'Move BUTTON_PIN = 2 to file scope so setup() and loop() share the declaration.',
        'Keep the nonblocking LED timing and debounce logic; rerun the existing verifier scenario.',
      ],
    },
  },
  {
    agent: 'coder',
    type: 'output',
    attempt: 3,
    timestamp: startedAt + 17_500,
    content: {
      version: 2,
      revision: 1,
      filename: 'sketch.ino',
      language: 'cpp',
      code: sketchV2,
      summary: 'Replanned sketch: define BUTTON_PIN once at file scope; preserve all three acceptance criteria.',
    },
  },
  {
    agent: 'compile',
    type: 'passed',
    attempt: 3,
    timestamp: startedAt + 19_700,
    content: {
      sketch: { version: 2, revision: 1 },
      command: compileCommand,
      exitCode: 0,
      artifact: 'build/sketch.ino.hex',
      summary: 'Sketch compiled for Arduino Uno with no errors.',
    },
  },
  {
    agent: 'sim',
    type: 'passed',
    attempt: 3,
    timestamp: startedAt + 23_100,
    content: {
      sketch: { version: 2, revision: 1 },
      scenario: 'blink-with-bouncing-button',
      durationMs: 3_000,
      criteria: [
        {
          criterionId: 'led-timing', status: 'passed',
          evidence: 'LED transitions at 500, 1000, 1500, 2000, 2500, and 3000ms; every interval is 500ms.',
        },
        {
          criterionId: 'button-serial', status: 'passed',
          evidence: 'Two presses produce two "pressed" lines at 788ms and 2288ms; bounce, holds, and releases produce none.',
        },
        {
          criterionId: 'nonblocking-response', status: 'passed',
          evidence: 'Both stable presses are reported after 30ms; LED timing continues through the held button without delay().',
        },
      ],
      ledTrace: [
        { atMs: 0, pin: 13, level: 'LOW' },
        { atMs: 500, pin: 13, level: 'HIGH' },
        { atMs: 1_000, pin: 13, level: 'LOW' },
        { atMs: 1_500, pin: 13, level: 'HIGH' },
        { atMs: 2_000, pin: 13, level: 'LOW' },
        { atMs: 2_500, pin: 13, level: 'HIGH' },
        { atMs: 3_000, pin: 13, level: 'LOW' },
      ],
      serialOutput: [
        { atMs: 788, text: 'pressed' },
        { atMs: 2_288, text: 'pressed' },
      ],
    },
  },
  {
    agent: 'supervisor',
    type: 'passed',
    attempt: 3,
    timestamp: startedAt + 23_600,
    content: {
      sketch: { version: 2, revision: 1 },
      summary: 'PASS: sketch v2 compiles and satisfies all 3 acceptance criteria after replanning.',
      criteria: ['led-timing', 'button-serial', 'nonblocking-response'],
      evidence: 'mock-simulation',
      limitations: ['Synthetic run for frontend development; not a hardware verification result.'],
    },
  },
]
