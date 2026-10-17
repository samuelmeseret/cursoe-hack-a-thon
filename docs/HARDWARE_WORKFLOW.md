# Simulation to hardware

Simulation Lab owns one project. `SimulationRun.projectId` remains stable across chat follow-ups; `id` identifies a revision and `revision` its sequence. A persisted project-head record prevents configuring, downloading, or uploading an old revision after a follow-up. Hardware bindings carry forward but previous evidence does not. No production route selects a project template based on words such as “car”.

## Shared controller and environment

`candidate.controller` is a validated `PortableControllerProgram`: typed inputs, numeric/boolean state and outputs, input handlers, time-step statements, and derived-output statements. Expressions have bounded size/depth, fixed operators, and no loops, pointers, imports, or arbitrary code. Both emitters consume this exact program. Arithmetic is binary32 (including intermediate results), matching AVR/ARM floats; division by zero and nonfinite arithmetic normalize to zero in both backends. This is a small embedded-control language, not a general JavaScript-to-C++ compiler.

`candidate.environmentSource` defines `createEnvironment(controller)`. It reads a frozen controller facade, renders the scene, and models external physics. Optional sensor feedback supplies declared analog/digital inputs when values change. Controller-owned snapshot keys override environment keys. The trusted composer forwards controls and time to the real shared controller; the renderer cannot replace controller results. Candidate validation and runtime rendering recompose the source from the program and environment.

The firmware includes the generated `controller.h` and uses its `input`, `step`, `get`, and `reset` methods. Arduino API calls are confined to the generated device binding layer. Environment code never becomes approximate firmware. Legacy browser-only candidates remain viewable but cannot export hardware until a portable controller exists; unsupported devices have an explicit `hardwareUnavailableReason` or `requiredCapabilities` requirement.

## Hardware configuration

Search uses `arduino-cli board listall` and installed Arduino package-manager indexes. Uninstalled catalog entries name a board package; install it to resolve exact FQBNs and available board menu options. Connected-device discovery uses `arduino-cli board list`; an unidentified serial port is not proof of a particular board. Profile metadata comes from `board details`, core properties, variant headers, and SAMD pin-description tables.

A profile contains architecture, framework, toolchain, package/version, pins, interfaces, capabilities, constraints, menu options, upload support, and source provenance. AVR and SAMD pin metadata readers are implemented; unsupported architectures/variants return a concrete missing-reader requirement. Catalog listing is not a claim of working support.

Bindings identify signal, input/output direction, interface, component, pin, polarity, wiring notes, and analog engineering range. Validation rejects missing signals/pins, stale bindings, duplicate physical pins (including analog aliases), reserved pins, unsupported PWM/digital/analog functions, and missing driver capabilities. Analog input maps the default 10-bit ADC range to the configured minimum/maximum; PWM maps the controller's declared output range to 0–255 duty. Nominal hardware polling is 10 ms; changes are delivered once. Check the component datasheet to select a valid calibration range.

The adapter installs missing cores and Library Manager packages and records resolved versions. Extra library names are dependencies, not implemented drivers: `requiredCapabilities`, such as `driver:i2c:bme280`, must be implemented before export. Current application bindings support GPIO, ADC, PWM, and serial. I²C, SPI, servo pulses, radio/networking and vendor protocols need a registered driver/build extension. No unsupported transport is silently relabeled as analog input or PWM.

## Build, checks, and repair

1. Validate the current revision and saved hardware configuration.
2. Emit controller/application source and documentation from that revision.
3. Compile and execute the controller with the native C++ compiler. Replay acceptance-suite inputs/timing and additional varied inputs/timing in C++ and float32 JavaScript; compare all controller variables.
4. Run the frozen behavior suite in the same isolated browser runtime used by the UI. Tests are authored before the controller and cannot be rewritten to satisfy it.
5. Compile firmware using the exact selected FQBN and its real Arduino toolchain. Install missing core/library packages. On failure, repair package requirements and retry; if still failing, request one bounded shared-controller repair against the same frozen specification/scenarios, recheck, regenerate all files, and retry compilation. Missing capabilities or unrepaired failures remain explicit failures.
6. Hash the exported files and bind evidence to the entire candidate, specification, scenarios, hardware configuration, profile, and generator version. Source/configuration/artifact changes invalidate the evidence.

Per-project operation locks prevent overlapping configuration, build, or upload operations. Revision/head checks discard older work after chat changes. An interrupted build becomes an explicit failure after restart. A source repair updates the same simulation preview, controller, application, and documentation; it never patches an unrelated firmware copy.

Verification fields are separate: **generated**, **compiled**, **simulationChecked**, **controllerParity**, and **physicalTested**. Physical testing is always false in this automated pipeline. A compiled project with failing/incomplete simulation checks remains a labeled draft. A compilation or parity failure cannot produce a “compiled” download. There is no claim that native parity emulates the target CPU, that modeled physics proves real dynamics, or that compilation proves wiring.

## Export and execution

The downloadable ZIP includes:

- `controller.json`, `device/controller.h`, `device/device.ino`
- `hardware.json`, `device-profile.json`, `dependency-lock.json`, `project.json`
- `environment.js`, `simulation.js`, standalone offline `simulation.html`
- `requirements.json`, `scenarios.json`, `simulation-verification.json`
- `WIRING.md` with pin assignments, connection notes, component list and constraints
- `README.md` with pinned core/library installation, build and explicit upload commands
- compiled `firmware/` binaries/ELF/HEX as produced by the target, plus `compile.log`
- `checks/` native parity harness/header/report and `verification-report.json`
- for serial inputs, `host/controller.py` and pinned Python requirements

The host bridge requires an explicit `--port`. It sends ASCII `signalId=value\n` updates and `@heartbeat=1\n` every 50 ms. Keyboard shortcuts are global while the companion runs. Keyboard states are sent only on changes; repeated explicit terminal commands remain distinct input events. Firmware rejects malformed/nonfinite packets and restores initial serial values after the configured timeout. Escape/Ctrl-C requests the same initial values on shutdown. This requires a running connected computer; browser inputs only control the simulation.

Flashing is never a side effect of generation, build, or export. The UI requires selecting a detected matching device and pressing the upload button. The API requires `{port, confirm:true}`, rechecks artifact integrity, target matching, revision, and connected presence, then invokes the adapter. Successful upload is recorded separately and never sets `physicalTested`.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/hardware/catalog?q=...` | Real catalog search |
| `GET /api/hardware/profile?fqbn=...` | Resolve installed profile; install known core if required |
| `GET /api/hardware/devices` | Discover connected devices |
| `POST /api/hardware/packages {core}` | Install a package from configured indexes |
| `GET /api/simulations/:id/hardware` | Current hardware state/evidence |
| `PUT /api/simulations/:id/hardware` | Save full configuration; invalidate prior evidence |
| `POST /api/simulations/:id/hardware/build` | Start real generation/check/compile task; poll GET |
| `GET /api/simulations/:id/hardware/export` | Hash-checked downloadable compiled project |
| `POST /api/simulations/:id/hardware/upload {port,confirm:true}` | Explicit device upload |

## Extending support

`registerDeviceProfileReader({ architecture, read })` adds pin metadata extraction. `registerDeviceProfileProvider({ id, matches, resolve, search? })` adds a custom runtime profile/catalog and binds it to a registered build adapter. `registerBuildAdapter(adapter)` adds a compiler/upload backend selected through the adapter registry. A new adapter must return real artifacts and dependency versions and describe unavailable capabilities. For a non-Arduino runtime, also register a `HardwareSourceGenerator` through `registerHardwareSourceGenerator(adapterId, generator)`; a profile and compiler alone cannot implement application I/O. The shipped source generator targets Arduino C++. Adding an I²C/SPI/servo or networking driver also requires implementing its binding/application code and exposing its capability; simply adding a catalog row or library does not provide device behavior. Keep controller IR and environment independent, and add native/controller, actual target-toolchain, ZIP-rebuild, and UI tests.

Official toolchain references: [Arduino CLI platform specification](https://docs.arduino.cc/arduino-cli/platform-specification/), [board details](https://docs.arduino.cc/arduino-cli/commands-reference/arduino-cli_board_details/), and [project build profiles](https://docs.arduino.cc/arduino-cli/sketch-project-file/).
