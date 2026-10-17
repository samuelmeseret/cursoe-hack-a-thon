# Simulation Lab

Describe a system, experiment, game, or process in chat. Live Crusoe agents generate its controller, interactive Canvas environment, controls, and observable state. Simulation Lab then carries the same project through hardware selection, pin configuration, real compilation, checks, and ZIP export. Follow-up messages revise the previous project. The default flow has no component inventory, project-type switch, or predefined scene templates.

An independent verifier drafts and reviews structured behavior checks before the builder writes code. The application runs the generated code in an isolated browser Worker, evaluates the checks, and feeds observed failures back for up to three builds. A **Ready** result passed those browser checks; it does not establish real-world or engineering accuracy. If the agents cannot complete valid behavior checks, a model that passes actual browser initialization, drawing, advancement, and reset remains available as a **Draft · behavior not verified**. Runtime failures remain explicit failures.

## Local setup

Use Node.js 22.12+ or 24 and npm.

```sh
npm ci
npx playwright install chromium
# On a new checkout only; preserve an existing .env.
cp .env.example .env
```

Set `CRUSOE_API_KEY` in `.env`. The default model is `deepseek-ai/Deepseek-V4-Flash`; `CRUSOE_MODEL` must be available in the account catalog. Credentials stay in the Node backend. Browser verification uses the installed Playwright Chromium, `CHROME_EXECUTABLE_PATH`, or installed Google Chrome on macOS.

```sh
npm run dev
```

Open [Simulation Lab](http://127.0.0.1:5173). The API listens at `127.0.0.1:3001`; Vite proxies `/api`. The general simulation flow does not need the Arduino compiler. Browser/Worker support is required. Use `npm run build && npm start` to serve the production application on port 3001.

## Build and revise

1. Enter the behavior you want to explore, including any important controls or constraints.
2. The agents specify the model, draft and review checks, implement the source, and run it in a real headless browser.
3. Use Play, parameters, buttons, or the generated keyboard controls. The measurements and visualization come from the same generated model. The preview distinguishes checked results from runnable drafts, with any unfinished or failing behavior checks visible.
4. Send another message to change the project. The prior model and source are supplied as context and a new specification and check suite are created. Failed updates retain the last working model, including after reloading the conversation.
5. Open **Choose hardware**, search the real Arduino board catalogs (or use a connected board/exact FQBN), and configure components, pins, analog ranges, and serial communication. Required board packages are installed locally.
6. **Save configuration → Build & check → Download hardware project ZIP**. The ZIP contains the same controller, device application, compiled firmware, pinned dependencies, wiring/component documentation, and independent build/run instructions. A separate browser-simulation download remains available. Upload requires explicitly selecting a connected device and pressing **Upload firmware to selected device**.

The model selects reasonable assumptions for underspecified requests and exposes them under **Model & assumptions**. Three-dimensional subjects can use a projected Canvas view. Generated environment code runs only as an isolated software model. Hardware package installation and compilation are performed by the trusted backend; environment code has no access to credentials, the network, files, or physical devices.

The same pipeline is available from the command line:

```sh
npm run demo:simulation -- 'Describe any simulation you want to build'
npm run demo:simulation -- 'Add a second control and change the model behavior' --previous SIMULATION_ID
```

`API_URL` overrides the API address. Only one general build runs at a time. Each build has a six-minute deadline, up to three code candidates, and a separate bounded schema-correction budget. The command exits nonzero for an unverified draft or failed build. Errors, timeouts, failed checks, and cancellations remain visible; there is no offline or template fallback. Drafts contain newly generated source and require real browser execution before appearing.

## How it works

- `server/simulation-agents.ts`: independent Specifier, Verifier, semantic review, Builder, and repair prompts using the shared Crusoe transport. These prompts bypass the Arduino capability catalog.
- `shared/simulation-types.ts` and `shared/simulation-validation.ts`: domain-independent controls, scalar observables, requirements, and data-only assertions. No model-generated test JavaScript executes.
- `shared/simulation-runtime.ts`: the generated `createSimulation()` factory runs in a disposable Worker inside an opaque iframe. Fixed-step time, reset, controls, rendering, and watchdogs are owned by the application. External networking and code loading are blocked; wall-clock and unseeded-random dependencies fail explicitly.
- `server/simulation-browser.ts`: actual Chromium execution of the same runtime used by the preview, with independent assertion evaluation and cancellation.
- `server/simulation-controller.ts`: immutable pre-build contracts, bounded repair, persistent runs, and evidence binding source, specification, scenarios, and runtime version.
- `src/SimulationWorkbench.tsx` and `src/HardwarePanel.tsx`: one conversation with simulation, device selection, configuration, compilation, and download.
- `shared/portable-controller.ts`: one typed controller program compiled deterministically to float32 JavaScript and C++. Environment rendering/physics is separate.
- `server/hardware-adapters.ts`: Arduino CLI catalog, connected-device discovery, toolchain metadata profiles, core/library installation, compilation, and explicitly requested upload.
- `server/hardware-project.ts`: hardware revision/configuration state, native C++ parity, browser acceptance checks, bounded repair, hashed export evidence, and ZIP contents.

Runs persist under `~/.local/share/airlock-lab/runs/simulations` by default, outside Git. `ARTIFACT_DIR` overrides the parent directory. Completed runs can be reopened after a server restart. Changed artifacts lose their checked status; interrupted builds resume as an explicit failure that can be revised.

See [the generated simulation integration contract](docs/GENERATED_SIMULATIONS.md) for API, runtime, and extension details.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

The regression suite includes unrelated generated-runtime fixtures (chemistry, queueing, orbital motion, and thermal controls), real Chromium preview interactions, schema validation, independent-test ordering, repair, cancellation, persistence, artifact integrity, and runtime isolation. These fixtures test the infrastructure; live project source comes from Crusoe.

## Hardware requirements and support

```sh
npm run setup:arduino
```

Hardware builds also require a native C++ compiler (`c++`, or `CXX`) for JavaScript/C++ controller parity. Install Xcode Command Line Tools on macOS or a C++ toolchain on Linux/Windows. Board packages for supported targets are installed on selection/build. Current profile readers cover **AVR** and **SAMD** variants that expose the required pin metadata. The catalog lists additional architectures honestly, with the specific missing profile/driver capability; it does not promise export for every listed board.

The current controller adapter implements digital input/output, analog input scaling, PWM, and serial input/output. I²C/SPI sensors, servos, networking, and other specialized device protocols need a component driver adapter and are blocked when its required capability is missing. Installing a library alone does not create that driver. Device profiles and build adapters have registration points for extension. See [the hardware workflow contract](docs/HARDWARE_WORKFLOW.md).

Keyboard-controlled hardware includes a **Python computer-side serial companion**. The computer must stay connected; browser keyboard events do not reach the board. The bridge sends changed inputs and a heartbeat; the firmware restores declared initial serial values on timeout. Physical wiring, supplies, calibration, and actuator behavior still require physical testing.

The previous Uno compiler, AVR simulator, validation, and API remain available for regression compatibility. The main app integrates hardware into Simulation Lab rather than linking a separate Arduino workbench. Legacy setup/demonstrations are documented in [docs/ARDUINO.md](docs/ARDUINO.md).

See [recorded hardware verification](docs/HARDWARE_VERIFICATION.md) for downloaded ZIP rebuilds across AVR/SAMD, modeled scenarios, and the exact physical-testing boundary.

## Credits

Crusoe provides model inference. React and Vite provide the application; Playwright/Chromium and browser Workers execute and inspect generated models; TypeScript and Zod define contracts; Express, Node.js, and Archiver provide the local service and exports. Hardware compilation uses Arduino CLI/cores; the retained AVR simulation infrastructure uses AVR8js. Dependencies retain their upstream licenses. No agent framework or prebuilt project scene library is used.
