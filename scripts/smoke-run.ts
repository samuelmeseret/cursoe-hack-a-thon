import type { RunState, StartRunRequest } from '../shared/types';

const fixture = process.argv.includes('--fixture');
const buzzer = process.argv.includes('--buzzer');
const base = process.env.API_URL || 'http://127.0.0.1:3001';
const goalIndex = process.argv.indexOf('--goal');
const customGoal = goalIndex >= 0 ? process.argv[goalIndex + 1] : undefined;
const buzzerGoal = fixture
  ? 'Build a two-player quiz buzzer with two player buttons, a reset button, and two winner LEDs. First stable press wins and latches its LED until reset. Debounce all buttons for 20 ms. Both winner LEDs must never overlap. Holding a player button across reset must not win again until released and pressed. Simultaneous players award player one.'
  : 'Build a two-player first-press-wins quiz buzzer using two buttons and two LEDs. Both LEDs start off. Debounce each button for at least 20 ms. The first debounced press turns on only its matching LED within 100 ms and latches it on until the Arduino is reset. After a winner is latched, ignore all buttons. If both press edges occur at the same physical instant, player one wins; do not introduce a tie window or delay a single-player win to wait for the other player. The two winner LEDs must never overlap. Starting a new round uses the simulator Reset control; no reset button is needed.';
const request: StartRunRequest = {
  mode: buzzer || customGoal ? 'generate' : 'airlock-repair', inference: fixture ? 'fixture' : 'crusoe',
  goal: customGoal ?? (buzzer ? buzzerGoal : 'Build a spaceship airlock following the published challenge contract: two request buttons, two door LEDs,20 ms debounce,2 second opening,250 ms both-closed interval, simultaneous request lockout until both released, busy requests discarded, held buttons never repeat, no overlapping open signals.'),
};
const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
if (!response.ok) throw new Error(JSON.stringify(await response.json()));
const run = await response.json() as RunState;
console.log(`Run ${run.id} (${run.inference})\nOpen ${process.env.API_URL ? base : 'http://127.0.0.1:5173'}/?run=${run.id}`);
const stream = await fetch(`${base}/api/runs/${run.id}/events`);
const reader = stream.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
let terminal = false;
while (!terminal) {
  const { done, value } = await reader.read(); if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let boundary: number;
  while ((boundary = buffer.indexOf('\n\n')) >= 0) {
    const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
    const data = frame.split('\n').find(line => line.startsWith('data: '));
    if (!data) continue;
    const event = JSON.parse(data.slice(6));
    console.log(`${event.sequence}. [${event.agent}] ${event.message}`);
    if (event.kind === 'terminal') terminal = true;
  }
}
await reader.cancel();
const final = await (await fetch(`${base}/api/runs/${run.id}`)).json() as RunState;
console.log(JSON.stringify({ status: final.status, attempts: final.attempts.length, replans: final.replanCount, checks: final.evidence?.expectedCheckIds.length, originalFailedChecks: final.failureEvidence?.results.flatMap(r => r.checks).filter(c => !c.passed).length, error: final.error }, null, 2));
if (final.status !== 'VERIFIED') process.exitCode = 1;
