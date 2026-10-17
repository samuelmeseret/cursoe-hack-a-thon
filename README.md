# Airlock Lab

A local Arduino agent backend with a small browser integration harness. It turns a goal into a frozen specification, executable acceptance scenarios, firmware, and generated wiring. Arduino CLI compiles the sketch; AVR8js executes the resulting HEX. Application code grants **Verified in simulation** only when every expected check passes against the current artifacts.

The flagship repair challenge starts from an explicitly labeled sketch that opens both airlock doors. Its failure is measured before a repair is requested. The browser can inspect those recorded signals and run the compiled firmware interactively.

The current delivery is the compiler, shared simulator, Crusoe agent integration, controller, verification, exports, and a minimal React harness. The teammate handoff covers the full workbench, circuit presentation, airlock experience, and demo recording: [integration guide](docs/INTEGRATION.md), [demo runbook](docs/DEMO.md).

## Local setup

Use Node.js 22 (22.12 or newer) or Node.js 24 and npm. The tested development runtime is Node.js 24. The toolchain setup supports macOS and Linux on x64/arm64 and needs `curl`, `tar`, and a SHA-256 utility.

```sh
npm ci
npm run setup:arduino
cp .env.example .env
```

On an existing checkout, preserve your existing `.env`. Put a Crusoe Intelligence API key with inference access in `CRUSOE_API_KEY`. The key stays in the Node backend; it is not a Vite variable.

| Setting | Default / purpose |
|---|---|
| `CRUSOE_API_KEY` | Required for real inference; optional for explicit offline rehearsals |
| `CRUSOE_MODEL` | `deepseek-ai/Deepseek-V4-Flash`; must exist in the account catalog |
| `CRUSOE_BASE_URL` | `https://api.inference.crusoecloud.com/v1` |
| `PORT` | Backend port `3001` |
| `ARTIFACT_DIR` | `~/.local/share/airlock-lab/runs`; keep artifacts outside Git |
| `ARDUINO_CLI_PATH` | Optional CLI executable override; otherwise uses `.arduino/bin/arduino-cli`, then PATH |

The setup script installs checksum-verified Arduino CLI 1.3.1 and Arduino AVR core 1.8.6 under ignored `.arduino/`. `ARDUINO_CLI_VERSION` and `ARDUINO_AVR_VERSION` are setup-script overrides. Compilation targets `arduino:avr:uno`.

```sh
npm run dev
```

Open [the browser harness](http://127.0.0.1:5173). The API listens at [localhost:3001](http://127.0.0.1:3001/api/health); Vite proxies `/api`. Both services are local. There is no database or authentication, and run lookup is scoped to the current server process. Exported files remain on disk after a restart.

For a production build on localhost, run `npm run build` followed by `npm start`; the API serves the built browser application on port 3001.

## Run a smoke check

Keep `npm run dev` running in another terminal. These commands stream actual run events and exit unsuccessfully unless the terminal status is `VERIFIED`:

```sh
# Real Crusoe agents: airlock failure → repair → verification.
npx tsx scripts/smoke-run.ts

# Explicit offline rehearsal: real compilation and simulation, no AI inference.
npx tsx scripts/smoke-run.ts --fixture

# Second supported goal: two-player first-press-wins buzzer.
npx tsx scripts/smoke-run.ts --buzzer
npx tsx scripts/smoke-run.ts --fixture --buzzer
```

`API_URL` can override the API address for the smoke script. Only one run is active at a time. Fixture mode supports the airlock repair and buzzer examples; it is always labeled as an offline rehearsal. It does not demonstrate model generation.

A real run validates `CRUSOE_MODEL` against the account's `/models` response before starting. An unavailable model or invalid key fails visibly; there is no silent fixture fallback. See [Crusoe model discovery](https://support.crusoecloud.com/hc/en-us/articles/55002524169499-How-To-List-Model-Features-via-curl-and-the-Inference-API).

## What verification means

- For normal goals, the Specifier chooses assumptions, logical components, and numbered requirements. The Verifier independently drafts structured scenarios, then performs a semantic review of their actual input timelines and assertions. It receives no Builder code or diagnostics. At most two validation corrections are allowed across drafting and review, within the run deadline.
- The airlock repair challenge uses fixed published requirements and an unchanged baseline of **86 checks across 12 scenarios**. In live inference mode, the Verifier selects exactly two distinct approved mirror recipes from valid baseline cases. Application code clones those cases and swaps the outer/inner button and door references; timing, assertions, limits, and requirement links remain unchanged. These two mirrored scenarios run alongside the full baseline. Fixture rehearsal uses the baseline alone.
- The challenge Verifier selects recipes; it does not author new test logic or rewrite the baseline. Invalid selections permit at most two schema corrections. Requirements, component meanings, and the complete structured suite freeze before the first build; these pre-freeze corrections are separate from the Builder's implementation replan.
- The Builder chooses firmware and distinct D2–D13 pin assignments. The application generates and validates button-to-ground/pull-up and LED/220 Ω resistor wiring.
- Every scenario starts a fresh 16 MHz Uno with 32 KB flash and 2 KB SRAM. The shared simulator captures every connected GPIO value or mode change at AVR instruction boundaries.
- Tests are structured data: levels, transitions, complete durations, measured closed intervals, and mutual exclusion. No model-generated test JavaScript is executed. Serial `PASS` text and animation frames have no authority.
- Runs allow four candidate builds, one implementation replan, and a 180-second deadline. Repeated candidates or two consecutive identical failed-check sets trigger replanning; a later stall stops the run.
- SHA-256 evidence binds the source, circuit, HEX, requirements, and tests. Missing checks, compile errors, timeouts, unsupported components, altered artifacts, and stale evidence cannot grant success.

The result means **passing the listed simulator checks**. Physical hardware, servos, extra boards, cloud hosting, and cross-run self-improvement are outside this build.

## Checks and demonstrated milestones

```sh
# Required once if a compatible browser is not already installed.
npx playwright install chromium
npm run typecheck
npm test
npm run build
```

The compiler tests require the Arduino setup. The browser tests launch real Chromium; `CHROME_EXECUTABLE_PATH` can select an installed executable, and macOS tests can use installed Google Chrome. A missing browser is a test setup failure, not a simulated pass.

The integration checks completed during development include actual Blink/button compilation, the published airlock suite, the independent buzzer suite, known-bad firmware, missing pull-ups, malformed source, compiler cancellation/timeouts, and resetting an active machine. Actual browser Worker and Node worker traces matched for Blink, a button sketch, and scripted airlock bounce. The full regression suite passed 103 tests. The compiler/browser group includes 86 airlock checks across 12 scenarios and 25 buzzer checks across four scenarios, plus compiled variants with a 90 ms response and 2049 ms opening or a 1951 ms opening to verify the permitted timing tolerance.

To check parity through a running Vite server instead of the standalone test harness:

```sh
npm run build:worker
PARITY_BASE_URL=http://127.0.0.1:5173 npx vitest run tests/compiler.browser.test.ts
```

The final live Crusoe airlock rehearsal passed **99 checks across 14 scenarios in 55.4 seconds** on candidate 2. The deliberately bad seed failed 71 checks before the generated repair passed. Run `97875df7-c926-47ac-bb55-989f13efb98e` used `deepseek-ai/Deepseek-V4-Flash`, with no fixture fallback. All five exported artifact hashes matched the report. An earlier successful rehearsal (`b7785481-8917-4e91-ae7d-c123651ffac5`) also demonstrated rejection of a generated repair with 9–10 microsecond door pulses before candidate 3 passed. Reports and ZIPs remain outside Git in the local run directories.

A real Crusoe run completed the two-player, first-press-wins buzzer goal: **27 independently generated checks passed across eight scenarios on candidate 2 in 53.1 seconds**. Its first candidate incorrectly awarded player two on a simultaneous press; the Builder repaired that observed failure without changing the frozen suite. The generated circuit uses the simulator Reset control to start another round. Run `658c6896-2c37-4e72-bc35-bbe152845254` used `deepseek-ai/Deepseek-V4-Flash`; its report and ZIP are stored outside Git in the local run directory. All five exported artifact hashes matched the report. This is separate from the richer three-button buzzer rehearsal fixture.

## Event work and credits

This application was created during the October 17, 2026 event. The repository had no prior application source or commit history when implementation began. Event work includes the typed contracts, deterministic GPIO simulation adapter, wiring validation, compiler integration, agents, bounded controller, evidence gate, fixtures, API, exports, tests, and integration harness. The full workbench and recording remain teammate deliverables.

Existing libraries and tools provide the foundations; they were not built during the event:

| Project | Used for |
|---|---|
| [Arduino CLI](https://github.com/arduino/arduino-cli) and [Arduino AVR core](https://github.com/arduino/ArduinoCore-avr) | Sketch compilation and Uno runtime/toolchain; retain their upstream licenses |
| [AVR8js](https://github.com/wokwi/avr8js), by Uri Shaked and contributors, MIT | Executing AVR firmware in Node and browser Workers |
| [React](https://github.com/facebook/react), MIT; [Vite](https://github.com/vitejs/vite), MIT | Browser harness and build tooling |
| [TypeScript](https://github.com/microsoft/TypeScript), Apache-2.0 | Shared contracts and application code tooling |
| [Node.js](https://github.com/nodejs/node), MIT and bundled third-party notices; [Express](https://github.com/expressjs/express), MIT | Local backend and API |
| [Playwright](https://github.com/microsoft/playwright), Apache-2.0; [Vitest](https://github.com/vitest-dev/vitest), MIT | Browser and regression verification |
| [esbuild](https://github.com/evanw/esbuild), MIT; [Zod](https://github.com/colinhacks/zod), MIT; [Archiver](https://github.com/archiverjs/node-archiver), MIT | Worker bundling, request validation, artifact ZIP export |

Crusoe supplies hosted model inference. No agent framework is used. Exact npm versions are locked in `package-lock.json`; upstream dependencies retain their own licenses.
