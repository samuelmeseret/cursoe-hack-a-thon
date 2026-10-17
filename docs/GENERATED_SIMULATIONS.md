# Generated simulation integration

The application root is a general simulation chat with an integrated hardware workflow. Legacy Arduino URLs remain compatible; no prompt keywords route a general request into a project template. See [the hardware workflow](HARDWARE_WORKFLOW.md) for configuration, compilation and export.

## HTTP contract

| Route | Purpose |
|---|---|
| `POST /api/simulations` | `{prompt,previousId?}` starts an initial project or revision; returns `202` and `SimulationRun` |
| `GET /api/simulations/:id` | Read state; completed runs reload from disk and artifacts are rechecked |
| `GET /api/simulations/:id/events` | `simulation-event` SSE; supports `Last-Event-ID` and `?after=` |
| `POST /api/simulations/:id/cancel` | Cancel without accepting a late successful result |
| `GET /api/simulations/:id/artifacts` | Download standalone HTML, source, spec, scenarios, and report after completion |

Prompts contain 5–5000 characters; accumulated revision goals are capped at 24,000. A revision carries the latest model contract and nearest available source, paired with that source's original specification, as context. The new specification and independent scenarios become authoritative. If an update failed before producing a model or source, the next revision resolves that context from its ancestors. The UI restores the nearest checked preview after a reload. Records contain the user/assistant message history. No credentials or provider response bodies belong in them.

Statuses progress through `QUEUED`, `PLANNING`, `DESIGNING_TESTS`, `BUILDING`, and `CHECKING`; repairs repeat build/check. Terminal states are `READY`, `DRAFT`, `FAILED`, `CANCELLED`, and `STALE`. `READY` is granted only when every expected assertion executed and its observed value satisfies the frozen comparison. Model verdict strings are not inputs to that gate.

Each generation role has a bounded schema-correction budget plus one independent output-length recovery. Length recovery disables reasoning, requests up to 24,000 completion tokens (capped by the provider), and requests a complete compact replacement while preserving the last schema diagnostic, specification and frozen scenarios. It does not consume a schema correction or reuse truncated content. Verifier draft and semantic review share their budgets. Provider filtering, cancellation and other transport failures are not retried as schema errors. Failed provider completions persist `errorCode` and `errorFinishReason` (`length` or `content_filter`) in the run and exported report; the visible error distinguishes the two causes without storing provider content or credentials.

If a combined Builder response still exceeds the length budget, or a portable-controller repair repeatedly returns unchanged source, one bounded fallback generates the controller and environment separately. The controller is validated first and frozen into the environment request; the final candidate still passes the ordinary binding, source and behavior checks. Both parts share correction/recovery budgets (at most six additional completions) and remain within the run deadline. No prompt-topic routing, hand-authored project template, partial response concatenation, or test weakening is used. Filtering never triggers this fallback.

## Model contract

`SimulationSpec` describes the original goal, title, summary, assumptions, controls, observables, and numbered requirements. It contains no device inventory or scene classification. Controls are ranges, toggles, buttons, selects, or keyboard states. Observables are flat finite numbers, strings, or booleans.

The Builder normally returns a portable controller program and separate environment JavaScript. The trusted composer emits `function createSimulation()` from both; see [portable controllers](PORTABLE_CONTROLLERS.md). Explicit simulation-only fallbacks may supply this factory directly. The returned object supplies:

| Method | Behavior |
|---|---|
| `reset()` | Restore deterministic initial state |
| `input(id,value)` | Apply declared controls; button `true` is an event, key `true/false` is held/released |
| `step(dt)` | Advance model time by `dt` seconds |
| `snapshot()` | Return fresh scalar observable values from the actual model |
| `draw(ctx,width,height)` | Draw that same model using Canvas2D, without mutating it |

The host applies every control's initial value after reset. Simulation steps are bounded to 1/60 second with partial final steps. It owns playback, keyboard focus/release, rendering, and command timing. State and visuals are never taken from a predefined topic-specific implementation.

Generated code runs in a Worker, never in Node or the application's main JavaScript realm. The preview and verifier use the exact document from `buildSimulationDocument()`, embedded with `sandbox="allow-scripts"` and no same-origin permission. The document's CSP blocks outbound requests and external code. Blob workers inherit their creator's CSP ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)). Worker code cannot manipulate the parent DOM. A watchdog terminates nonresponsive code; browser verification also has wall-clock and cancellation bounds. Blank drawings, absent or invalid observables, exceptions, and nonfinite state fail checks. Randomness must use a model-owned resettable generator so extra render calls cannot alter its sequence.

The iframe exposes a trusted `window.simulationHost` bridge with `ready` and `command()`. Parent messages use channel `generated-simulation` and type `command`; responses include the matching request ID. `ready`, `state`, and `error` messages publish state, simulation time, running status, and control values. Parent UI must verify `event.source` is the current iframe before reading messages. These messages never grant server verification.

## Independent verification

The Verifier receives the goal and specification before Builder code exists. It drafts structured scenarios and performs a semantic review with a concise calculation or state-rule basis for every final assertion. These calculations support review; they are not execution evidence. Draft and review share two schema corrections. Scenarios contain `input`, `advance`, `reset`, and `assert` steps, with comparisons `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, and `approx`. Every requirement and control needs exercised coverage. A suite is limited to eight scenarios and 180 seconds of total simulated advancement. Long advances are split into equivalent chunks of at most ten seconds before freezing, without changing elapsed time or assertions. Browser verification still has a separate 60-second execution timeout.

After freezing, only implementation code may change. Actual Chromium results feed the Builder's next attempt. The controller independently rechecks observed assertion values and binds successful evidence to source, specification, scenarios, and runtime version. This demonstrates the listed model behavior, not scientific or physical validity. Keep stated assumptions visible.

`READY` requires the complete frozen suite to pass. `DRAFT` is a separate terminal outcome: the source initializes, draws, advances, and resets in the actual sandbox, but its behavior has not been verified. If independent check authoring fails, an explicit draft build may receive an empty suite and must implement the validated specification. If completed behavior checks still fail after repair, a runtime check can retain the model as a draft with the failures visible. Runtime errors, missing execution results, cancellation, and deadlines cannot produce a usable draft. Draft artifact hashes are stored separately from verified evidence and become stale when changed. Never present a draft's runtime check as passing behavior checks.

## Adding scope

New subject matter generally needs no application code: the model supplies its own controller, environment algorithms and Canvas drawing. A new host interaction mechanism (for example file input or a different renderer) does require an explicit contract and runtime implementation. Do not add prompt keyword routers, topic-specific generated-source templates, or a component whitelist to general generation. Extend hardware through profiles, source generators and build adapters in the integrated workflow.

When changing runtime semantics, increment `SIMULATION_RUNTIME_VERSION`. The test suite includes actual Worker/Chromium cases across unrelated domains and a real React preview harness. Run those along with controller/API/agent contracts and production compilation.
