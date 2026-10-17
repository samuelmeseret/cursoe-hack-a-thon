# Teammate integration guide

This document covers the Arduino workbench at `?workbench=arduino`. The application root now uses the separate [general simulation pipeline](GENERATED_SIMULATIONS.md), which generates a new model and scene from each prompt without the hardware inventory below.

The backend, shared simulation, and minimal harness are ready for the full workbench. Use the checked-in contracts in [`shared/types.ts`](../shared/types.ts); do not create independent frontend copies. The circuit renderer, airlock presentation, readable activity/evidence views, and video are the teammate's scope.

## Runtime and ownership

Start with the [README setup](../README.md#local-setup). Vite runs on `http://127.0.0.1:5173`, the Node API on `http://127.0.0.1:3001`, and `/api` is proxied during development. The browser never needs the Crusoe key.

| Area | Entry points |
|---|---|
| Typed contracts | `shared/types.ts` |
| Validation and generated connections | `shared/validation.ts`, `shared/circuit.ts` |
| GPIO execution and assertion evaluation | `shared/simulator.ts`, `shared/assertions.ts` |
| Browser worker | `src/simulator.worker.ts` |
| Authoritative Node worker | `server/simulation.ts`, `server/sim-worker.ts` |
| Agent/controller/compilation | `server/agents.ts`, `server/controller.ts`, `server/compiler.ts` |
| Capability discovery and documentation | `server/capabilities.ts` |
| Keyboard controls and vehicle display | `src/ProjectSimulation.tsx`, `shared/motion.ts` |
| Evidence, storage, diagram | `server/evidence.ts`, `server/storage.ts`, `server/diagram.ts` |
| API and minimal integration UI | `server/index.ts`, `src/App.tsx` |
| Published rehearsal data | `shared/fixtures.ts` |

## HTTP API

All responses use JSON except the SSE stream and artifact ZIP. There is no authentication. Requests with a browser `Origin` must originate from localhost; the server listens on the loopback interface. API responses use `Cache-Control: no-store`.

| Method and route | Request | Response |
|---|---|---|
| `GET /api/health` | None | `HealthResponse`: model, whether a key is configured, compiler availability, artifact directory |
| `POST /api/runs` | `StartRunRequest` | `202` with the initial `RunState` |
| `GET /api/runs/:id` | None | Current `RunState`; also rechecks integrity of previously verified artifacts |
| `GET /api/runs/:id/events` | Optional `?after=<sequence>` or `Last-Event-ID` header | Ordered `run-event` SSE messages |
| `POST /api/runs/:id/cancel` | No body required | Updated `RunState` |
| `GET /api/runs/:id/artifacts` | None | Downloadable ZIP after a terminal status |

A start request has `goal` (5–5000 characters), `mode` (`"generate"` or `"airlock-repair"`), and optional `inference` (`"crusoe"` by default, or `"fixture"`). Unknown fields are rejected. Invalid start input returns `400`; unavailable inference/configuration or another active run returns `409`; an unknown run returns `404`. Downloading before completion returns `409`.

```json
{
  "goal": "Build a spaceship airlock with two request buttons and two door LEDs.",
  "mode": "airlock-repair",
  "inference": "crusoe"
}
```

`"fixture"` must remain visibly labeled **Offline fixture rehearsal · no AI**. It runs the real compiler and simulator using documented reference sketches. Normal fixture generation supports the two-player buzzer goal; it is not arbitrary goal generation.

Run lookup is in memory. Saved artifacts survive a process restart, but historical run IDs are not restored into the API. Export useful runs before restarting the server.

## State and event handling

`RunState` contains the current `spec`, `scenarios`, `candidate`, `circuit`, `hex`, `evidence`, `failureEvidence`, all `attempts`, ordered `events`, the configured `model` for a live run, and a terminal `error` when applicable. Fields appear as work completes; do not assume they exist during initial rendering.

The normal progression is `QUEUED → SPECIFYING → VERIFYING_SPEC → BUILDING → COMPILING → SIMULATING`. It can repeat through `BUILDING` or `REPLANNING`. Terminal statuses are `VERIFIED`, `FAILED`, `CANCELLED`, and `STALE`.

Subscribe to the named SSE event:

```ts
const stream = new EventSource(`/api/runs/${runId}/events`);
stream.addEventListener('run-event', (message) => {
  const event: RunEvent = JSON.parse((message as MessageEvent).data);
  // Deduplicate by sequence, append activity, and refresh the RunState.
});
```

Each event carries `sequence`, ISO timestamp `at`, `agent`, `kind`, `message`, optional `attempt`, and optional `details`. `kind` is `activity`, `frozen`, `attempt`, `failure`, `replan`, or `terminal`. The server replays existing events, then streams new ones. SSE `id` equals `sequence`, supports reconnection, and heartbeats are comments rather than activity. Do not manufacture typing events or agent messages.

Fetch state after activity changes. On terminal status, the stream can be closed. Periodically re-fetch a displayed verified run, as the existing harness does every five seconds, so disk changes can replace its success label with `STALE`.

## Browser Worker

Create the worker using Vite's source-relative URL:

```ts
const worker = new Worker(new URL('./simulator.worker.ts', import.meta.url), { type: 'module' });
```

Use `SimulatorCommand` to send:

| Command | Payload and effect |
|---|---|
| `load` | `hex`, `circuit`; constructs a fresh paused machine |
| `play` | Starts/resumes interactive execution |
| `pause` | Pauses the interactive machine |
| `reset` | Recreates the last loaded machine and clears prior inputs; remains paused |
| `button` | `componentId`, `pressed`; changes a physical active-low button input |
| `serial` | `data`; queues ASCII bytes for the Uno USART at the circuit's configured baud rate |
| `scenario` | `hex`, `circuit`, `scenario`; executes recorded inputs in a fresh machine and returns a result |

The worker sends `SimulatorMessage`:

| Message | Meaning |
|---|---|
| `trace` | Incremental `TracePoint[]` and `atMs` |
| `state` | `running` and `atMs` |
| `result` | A complete `ScenarioResult` from a `scenario` command |
| `error` | A failure message; stop interactive playback and surface it |

A trace point contains CPU `cycle`, simulation `atMs`, logical `signal`, `value` (`0`, `1`, or `"floating"`), and `mode` (`"input"`, `"input-pullup"`, or `"output"`). Render LED/door-open state only from `value === 1 && mode === "output"`. The clock is simulation time, not elapsed animation time.

Button pointer/key down sends `pressed: true`; pointer/key up, cancellation, or lost focus must release it. Use pointer capture to avoid stuck inputs. Reload on artifact identity changes, including circuit changes. Reset the frontend's accumulated live trace when loading or resetting.

The browser worker is for interaction and parity checks. Its `result` message cannot set a server run to `VERIFIED`. Only the server's isolated Node worker and completion gate can authorize that status.

## Circuit and airlock presentation

The supported circuit is exactly one Uno, at most four buttons, six LEDs, and two bidirectional motors, with at most twelve distinct D2–D13 pins. Each motor uses `pin` and `reversePin` with an `h-bridge-motor` template, a separate motor supply, and common ground. `Circuit.components` supplies stable logical IDs, labels, meanings, pins, templates, and resistance. Draw the connections in `Circuit.connections`; the existing SVG generator offers a baseline. Do not infer new pins from source text.

Optional `Circuit.serial` and `RunSpec.serial` contain `baudRate` (9600 or 115200) and `controls`: `{key,label,data,releaseData?}`. Keys are single printable characters or arrow keys. Keydown sends `data`; keyup sends `releaseData` if supplied. Commands without release data latch according to generated firmware. Release held keys on blur, hidden document, pause, and reset; ignore global shortcuts while editing a form. The worker forwards these bytes to the actual USART rather than manipulating outputs.

Motor trace names are `${componentId}_forward` and `${componentId}_reverse`. Forward is driven `(1,0)`, reverse `(0,1)`, stop `(0,0)`, and `(1,1)` must fail the required exclusion check. `shared/components.ts` supplies `outputSignals()` for generic output consumers. Optional `presentation: "vehicle"` renders movement derived from the measured motor drive time. It does not establish physical position or speed, and UI animation never grants verification.

Before specifying a live project, `resolveCapabilities()` performs bounded search/read/select actions against the installed adapter catalog. The selected docs are supplied to every agent role. Activity event details expose tool names and module IDs. Adding registry prose alone does not add a device: its typed component, circuit template, executable simulator model, validators, and tests must also exist. `RunState.errorCode` preserves structured agent failures, including `UNSUPPORTED_GOAL`, for actionable UI states and artifact exports.

For the published airlock fixture, IDs are `outerRequest`, `innerRequest`, `outerDoor`, and `innerDoor`. The fixture assigns D2, D3, D8, and D9 respectively; live Builders may choose other approved pins. The diagram must use the current candidate's circuit.

Keep **Live interaction** separate from **Recorded failure**. For failure playback use the preserved `failureEvidence` and that attempt's circuit, HEX, and source, rather than the repaired candidate's artifacts. Pause the live worker during recorded playback. A playback scrubber selects observed trace points at or before its timestamp; it does not run or verify firmware.

## Frozen checks and evidence

`RunSpec` contains the goal, assumptions, component meanings, numbered requirements, and optional serial controls and presentation. `Candidate` contains source, pin assignments, rationale, and ID. `Scenario` contains duration, timed button or serial inputs, and assertions linked to requirement IDs. A serial input has exactly `{atMs,serial}`; a button input retains `{atMs,componentId,pressed}`. No model-generated test JavaScript is accepted.

There are two live Verifier paths, both isolated from Builder code, pin choices, implementation messages, and simulation diagnostics:

- **Normal generation:** the Verifier independently drafts a complete structured suite from the goal and specification. It then performs one semantic review using the draft, explicit button timelines, and timing arithmetic. Drafting and review share at most two validation corrections before the suite freezes. The application stably sorts finite timed button inputs chronologically before validation; timestamps, equal-time ordering, and assertions are preserved. Requirements and component meanings cannot change.
- **Airlock repair challenge:** the application preserves the fixed published contract and all **86 baseline checks across 12 scenarios**. The Verifier receives that valid baseline, goal, specification, and allowed recipes. It selects exactly two distinct `baselineScenarioId` values from `held`, `bounce`, `busy`, `closed-interval`, `alternating`, and `reset`, each with `transform: "swap-doors"`. It returns recipes, not scenarios or test code.

For challenge recipes, application code clones the selected baseline scenarios and swaps `outerRequest ↔ innerRequest` and `outerDoor ↔ innerDoor` in inputs and assertion references. It gives the copies new IDs and names, while preserving every input timestamp, scenario duration, assertion window, level, count, timing bound, safety check, and requirement link. The full unchanged baseline runs alongside these two mirrored scenarios, producing 14 scenarios in a live challenge. The resulting check count depends on the selected recipes. Offline airlock rehearsal uses only the 12-scenario baseline.

Challenge selection allows at most two schema corrections and performs no freeform semantic rewrite of the published checks. Both paths validate and freeze the complete suite before the first candidate build. These pre-freeze corrections are separate from the single permitted implementation replan after builds begin. UI activity and submission copy should describe the challenge's constrained mirror selection accurately, rather than claim its baseline was generated by the model.

The assertion types are `level`, `transition`, `duration`, `mutual-exclusion`, and `deadtime`. Check identities are `scenarioId/assertionId`; assertion IDs must be unique inside their scenario. Duration checks require complete observed intervals. Deadtime measures an actual driven-LOW gap between output activation episodes; initial startup LOW does not count. The validator rejects empty suites, unsupported signals/components, uncovered requirements, and suites that never require useful HIGH output from every LED and both directions of every motor. Every motor scenario requires a full-scenario mutual-exclusion check for its direction pair.

`Evidence` binds `runId`, `candidateId`, expected check IDs, timestamp, simulator version, full scenario results, and SHA-256 hashes of source, circuit, HEX, requirements, and tests. Every expected check must execute once and pass. The server re-evaluates trace checks and verifies artifact identity before completion. The display statement is **Verified in simulation — all listed checks passed**.

Treat `RunState.status` as the current authority. An old `Evidence.passed: true` is insufficient if the run becomes `STALE`. Reading a verified run checks saved artifacts, report contents, and the generated diagram; changes revoke its status. Live button interactions do not modify saved evidence or certify new behavior.

Runs allow four builds, one replan, and 180 seconds. A repeated source/pin candidate or two consecutive identical failed-check sets triggers replanning. Another stall stops the run. Cancellation, timeouts, missing evidence, compiler failure, and simulator failure remain non-success.

## Artifact export and handoff checks

The ZIP can contain `sketch.ino`, `circuit.json`, `circuit.svg`, `firmware.hex`, `requirements.json`, `tests.json`, and `verification-report.json`. The report includes current status, inference mode, evidence, original failure, attempts, and events. A failed run may have only partial artifacts. Compiler intermediates and `.env` are excluded.

Before integrating a new view:

- Run `npm run typecheck` and relevant tests.
- Keep real inference and fixture rehearsal visibly distinct.
- Display current attempt data, and label preserved failure data with its original attempt.
- Check live press/release, pause, reset, and switching to recorded playback.
- Check `FAILED`, `CANCELLED`, and `STALE` displays without retaining a verified badge.
- Confirm the artifact download includes the exact inspected run.

For real browser/Node trace parity, use `npm run build:worker` and `PARITY_BASE_URL=http://127.0.0.1:5173 npx vitest run tests/compiler.browser.test.ts`. Install Chromium with `npx playwright install chromium` if needed. These tests use real compiled Blink, button, and airlock-bounce firmware.
