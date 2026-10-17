/** Trusted application adapters. Adding a module also requires an executable simulator adapter. */
export interface CapabilityModule {
  id: string;
  version: number;
  title: string;
  description: string;
  keywords: string[];
  dependencies: string[];
  documentation: string;
  sources: { title: string; url: string }[];
}

export interface ResolvedCapabilities {
  moduleIds: string[];
  summary: string;
  documentation: string;
}

const modules: readonly CapabilityModule[] = [
  {
    id: 'uno', version: 1, title: 'Arduino Uno firmware and GPIO',
    description: 'Compile real Arduino firmware and execute it on an AVR8js Uno with deterministic GPIO evidence.',
    keywords: ['arduino', 'uno', 'firmware', 'gpio', 'board', 'microcontroller'], dependencies: [],
    documentation: `Board is arduino:avr:uno, ATmega328P, 16 MHz, 32 KB flash, 2 KB SRAM. Use Arduino core APIs with no third-party libraries or dynamic memory. Every component pin is a distinct integer D2-D13; D0/D1 are reserved for hardware USART. Total assigned component pins cannot exceed 12. Compile source to HEX and execute it in AVR8js; comments, source claims and visuals cannot establish success. Supported observable checks are level, transition, duration, mutual-exclusion and deadtime over connected GPIO signals. A spec may set presentation to "circuit" or "vehicle"; presentation only visualizes the executed signals and cannot establish physical position, speed, distance or safety. The supplied adapters model functional behavior; no physical hardware result is claimed.`,
    sources: [{ title: 'AVR8js architecture and external hardware adapters', url: 'https://github.com/wokwi/avr8js' }],
  },
  {
    id: 'button', version: 1, title: 'Push-button inputs',
    description: 'Up to four active-low buttons, timed press/release inputs, and browser button interaction.',
    keywords: ['button', 'buttons', 'press', 'switch', 'debounce', 'request'], dependencies: ['uno'],
    documentation: `Component shape is {"id":"request","kind":"button","label":"Request","meaning":"Requests an action"}. At most four buttons. Builder pin assignment is {"componentId":"request","pin":2}. Each button connects its GPIO pin to ground; firmware must use INPUT_PULLUP, with LOW meaning pressed. Scenario event is {"atMs":200,"componentId":"request","pressed":true}, followed by pressed:false when released. Every scenario starts with all buttons released. Button events can be mixed with serial events in one array sorted by atMs. Debounce only when the specification requires it. Browser keyboard activation of a focused button is merely button accessibility, not a serial command interface.`,
    sources: [{ title: 'Arduino digital output reference', url: 'https://docs.arduino.cc/language-reference/en/functions/digital-io/digitalwrite/' }],
  },
  {
    id: 'led', version: 1, title: 'LED outputs',
    description: 'Up to six connected active-high LEDs, with actual GPIO state and timing assertions.',
    keywords: ['led', 'leds', 'light', 'lights', 'indicator', 'blink', 'airlock', 'buzzer'], dependencies: ['uno'],
    documentation: `Component shape is {"id":"status","kind":"led","label":"Status","meaning":"Indicates active output"}. At most six LEDs. Builder pin assignment is {"componentId":"status","pin":3}. The application creates a 220-ohm series resistor to the LED and ground. Initialize OUTPUT mode and LOW. HIGH means lit. The assertion signal name is the component ID itself. Use LEDs for requested indicators; never substitute LEDs for requested motor movement. Every output must have meaningful positive acceptance coverage.`,
    sources: [{ title: 'Arduino digital output reference', url: 'https://docs.arduino.cc/language-reference/en/functions/digital-io/digitalwrite/' }],
  },
  {
    id: 'serial', version: 1, title: 'Keyboard commands through Uno USART',
    description: 'Map chosen keyboard keys to serial bytes delivered to the executing firmware through the emulated UART.',
    keywords: ['keyboard', 'key', 'keys', 'command', 'commands', 'serial', 'uart', 'usart', 'computer', 'remote'], dependencies: ['uno'],
    documentation: `Serial is a spec-level field, NOT a component: "serial":{"baudRate":9600,"controls":[{"key":"w","label":"Forward","data":"F","releaseData":"X"},{"key":"s","label":"Reverse","data":"B","releaseData":"X"},{"key":" ","label":"Stop","data":"X"}]}. baudRate must be 9600 or 115200. Choose key mappings and ASCII command strings appropriate to the user's goal; these are examples, not required mappings. A key is one printable character or ArrowUp/ArrowDown/ArrowLeft/ArrowRight. Data and optional releaseData are nonempty ASCII strings of at most 64 characters. Keydown sends data; keyup sends releaseData when supplied. Omitting releaseData means a latched command until another command stops/changes it. Explicitly define that interaction policy in requirements. The browser and tests deliver bytes through AVR USART, not direct GPIO manipulation. Firmware must call Serial.begin(spec.serial.baudRate), then poll Serial.available() and consume Serial.read() without blocking. Use single-character commands when adequate. Scenario event is {"atMs":200,"serial":"F"}; do not add componentId, pressed, key, data or type to serial events. Never create a keyboard component or assign serial pins. Serial output is not assertion evidence. Allow UART frame time in response deadlines: each byte requires about 10/baudRate seconds; a 100 ms command response bound is generally enough for short commands. Avoid events before setup finishes; use at least 200 ms after reset for first commands.`,
    sources: [{ title: 'Arduino Serial communication', url: 'https://docs.arduino.cc/language-reference/en/functions/communication/serial/' }],
  },
  {
    id: 'motor', version: 1, title: 'Bidirectional DC motor and H-bridge',
    description: 'Drive up to two motors forward, reverse, or stopped through two real GPIO driver inputs, including vehicle visualization.',
    keywords: ['motor', 'motors', 'car', 'vehicle', 'robot', 'wheels', 'forward', 'forwards', 'backward', 'backwards', 'reverse', 'movement', 'move', 'moves', 'drive'], dependencies: ['uno'],
    documentation: `Component shape is {"id":"drive","kind":"motor","label":"Drive motor","meaning":"Moves the vehicle forward or reverse"}. At most two motors; use one drive motor unless separate wheels are needed. Builder assignment is {"componentId":"drive","pin":5,"reversePin":6}; each motor consumes two distinct D2-D13 pins. The application constructs an H-bridge adapter with a separate motor supply and common ground, not a motor wired directly to a GPIO. Both pins must be OUTPUT. Actual assertion signals are "drive_forward" for pin and "drive_reverse" for reversePin, using the real component ID plus suffix. Forward is (1,0), reverse is (0,1), and stop is (0,0). (1,1) is forbidden. Clear the currently active pin before setting the opposite pin so reversal never briefly drives both HIGH. Initialize both pins LOW. Use ordinary digitalWrite for direction; analogWrite/PWM, motor speed, sensors and measured position are not supported by this adapter. Set presentation:"vehicle" when a moving vehicle display is requested; motion is derived from executed motor GPIO. Requirements and acceptance tests establish direction/stop/reversal behavior, not a distance or speed measurement. Require both direction outputs to activate when bidirectional motion is requested. For keyboard control, combine with the serial module instead of substituting buttons or LEDs. Use 2-3 focused scenarios for startup, forward, reverse, stop, unknown commands and repeated commands as relevant. A duration check counts complete intervals, so send a later serial stop command before the duration window ends. Do not invent automatic two-second stops or airlock delays for a latched direction contract.`,
    sources: [{ title: 'Arduino digital output reference', url: 'https://docs.arduino.cc/language-reference/en/functions/digital-io/digitalwrite/' }, { title: 'AVR8js external peripheral adapter model', url: 'https://github.com/wokwi/avr8js' }],
  },
];

export function capabilityCatalog() {
  return modules.map(({ id, version, title, description, dependencies }) => ({ id, version, title, description, dependencies: [...dependencies] }));
}

export function searchCapabilities(query: string) {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(term => term.length > 1);
  const ranked = modules.map(module => ({ module, score: terms.reduce((score, term) => score + (module.keywords.some(word => word.includes(term) || term.includes(word)) ? 1 : 0), 0) }))
    .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score);
  const ids = new Set(ranked.map(entry => entry.module.id));
  return capabilityCatalog().filter(module => ids.has(module.id));
}

export function readCapabilities(ids: string[]): CapabilityModule[] {
  if (!ids.length || ids.length > modules.length || new Set(ids).size !== ids.length) throw new Error('Choose one or more distinct installed module IDs.');
  const selected = new Map<string, CapabilityModule>();
  const add = (id: string) => {
    const module = modules.find(entry => entry.id === id);
    if (!module) throw new Error(`Unknown capability module: ${id}`);
    module.dependencies.forEach(add);
    selected.set(id, module);
  };
  ids.forEach(add);
  return structuredClone([...selected.values()]);
}

export function capabilityDocumentation(ids: string[]): string {
  return readCapabilities(ids).map(module => `${module.title} (${module.id}, version ${module.version})\n${module.documentation}\nReference sources: ${module.sources.map(source => `${source.title}: ${source.url}`).join('; ')}`).join('\n\n');
}
