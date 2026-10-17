# Hardware workflow verification

The integration suite drives the running HTTP API through project creation, browser simulation checks, real board catalog search, hardware configuration, compilation, ZIP download, extraction, and a second compilation of the extracted project. Generation is supplied by deterministic test agents so this suite does not require API credentials. Browser verification, native C++ compilation, target compilation, the package manager, and ZIP downloads are real.

## Verified projects

| Project | Selected board | Architecture and package | Behavior checked | Download independently compiled |
|---|---|---|---|---|
| Keyboard controlled car | Arduino Uno, `arduino:avr:uno` | AVR, `arduino:avr@1.8.6` | Forward/reverse, opposing turns, release-to-stop, separate keyboard-to-serial companion | Yes, AVR GCC |
| Hysteresis thermostat | Arduino MKR Zero, `arduino:samd:mkrzero` | ARM Cortex-M0+ / SAMD, `arduino:samd@1.8.14` | Analog temperature binding, enable switch, 30 °C / 26 °C hysteresis | Yes, ARM GCC |
| Timed task light | Arduino Uno, `arduino:avr:uno` | AVR, `arduino:avr@1.8.6` | Button-triggered two-second pulse, release, expiry, reset | Yes, AVR GCC |

These are test fixtures, not production routing rules or project templates. They use the same generic controller format, hardware configuration, build adapter, and export endpoint as any generated project. No car-specific routing is used.

All three projects replay their frozen acceptance scenarios in the isolated browser runtime and compare the authoritative controller's JavaScript implementation against actual compiled native C++. The car additionally executes its downloaded AVR HEX in AVR8js: actual UART bytes drive GPIO/PWM, reverse changes direction, and the inactivity timeout stops the outputs. The light's downloaded AVR HEX executes with an active-low button and proves that holding the button does not continuously retrigger its input event. These are emulated MCU tests. SAMD firmware is compiled by its actual ARM toolchain; no SAMD CPU emulator is claimed.

The independent build starts from the downloaded ZIP in a fresh extracted directory and invokes Arduino CLI directly with fresh build/output directories. It does not call the app's generator or project service. It uses the installed toolchain; it does not claim to validate installation on every host operating system. Each ZIP includes its source, separate visual environment, controller program, exact board profile, pin configuration, wiring/component documentation, build/upload instructions, dependency lock, verification report, and real firmware. The car includes a syntax-checked Python keyboard/serial companion and pinned Python requirements.

## Physical testing

**No physical hardware was uploaded to or tested.** No connected device was flashed. The catalog test discovers actual ports, but a discovered serial port is not treated as an identified or tested board. Physical behavior flags remain false, including after compilation and emulation. Wiring, electrical ratings, driver selection, sensor calibration, motor polarity, and real dynamics still require physical validation.

## Reproduce

Install the local Arduino CLI and AVR package, then install the SAMD package:

```sh
npm run setup:arduino
npx tsx -e 'import("./server/hardware-adapters.ts").then(m => m.installHardwarePackage("arduino:samd", "1.8.14"))'
npx vitest run tests/hardware-adapters.test.ts tests/hardware.integration.test.ts
```

The integration suite also installs and compiles the real Library Manager package `Servo@1.3.0`, then deliberately introduces a compiler error and checks that stale firmware cannot survive the failed build. The app does not equate a library's presence with an implemented component driver: a project requiring an unsupported device protocol is rejected with its missing capability.

Other checks cover exact toolchain pin metadata, AVR processor menu options, analog-only Nano pins, SAMD analog/digital/PWM capabilities, unknown adapters, malformed targets, explicit upload intent, duplicate pin assignments, same-project follow-up revisions, retained bindings, and invalidation of old exports when hardware configuration changes.

Evidence is retained under `.artifacts/hardware-verification/` after each integration run:

- `report.json`: board, compiler/core version, verification levels, physical/upload flags, ZIP hash, independent build command.
- `keyboard-car.zip`, `thermostat.zip`, `timed-light.zip`: the bytes downloaded from the HTTP endpoint.
- `*-independent-compile.log`: output from directly rebuilding each extracted ZIP.
- `*-verification.json`: export evidence and artifact hashes.

## Extending hardware support

`server/hardware-adapters.ts` reads board names and versions from the actual configured Arduino package indexes, exact FQBNs and options from `arduino-cli board listall` / `board details`, and connected devices from Arduino CLI discovery. Uninstalled packages expose catalog board names before they have an exact FQBN; install the selected package and repeat the search to select its exact board.

AVR profiles preprocess the installed variant's `pins_arduino.h` using its actual AVR compiler and MCU setting. SAMD profiles read the installed variant header and pin-description table, including PWM/timer channels. Capabilities do not come from a list of application types. Unknown architectures remain discoverable but identify their missing pin-capability reader instead of promising a usable export.

Register a `DeviceProfileReader` with `registerDeviceProfileReader()` to add an Arduino architecture's verified pin metadata. Register a `DeviceProfileProvider` with `registerDeviceProfileProvider()` for a different framework's profile resolution and catalog search, then register its `BuildAdapter` with `registerBuildAdapter()`. Build and upload requests dispatch through the selected profile's adapter. An adapter produces explicit firmware artifacts and their SHA-256 hashes; successful source generation alone cannot satisfy a compile result. Upload is a separate adapter operation and requires an explicit request, selected connected port, and matching board identity when discovery identifies it.

Additional vendor package indexes should be configured through Arduino CLI's official board-manager configuration before installation. The app uses the indexes already configured for its local toolchain and does not invent FQBNs or silently fetch an arbitrary package URL. Compilation/package installation use argument arrays without a shell, bounded output, process-group cancellation, and timeouts.

## Live generation verification

On October 17, 2026, two separate project prompts were also sent to the configured Crusoe model, `deepseek-ai/Deepseek-V4-Flash`. These runs used actual provider-generated specifications, controller programs, environments and independent acceptance checks. They did not use the integration suite's fixture agents to invent implementation or assertion data.

| Live project | Final revision | Actual browser assertions | Native C++/JavaScript comparisons | Target and independent ZIP rebuild |
|---|---|---:|---:|---|
| Arrow-key differential-drive car | `7f71b27a-a10c-4471-b787-71d5c3f5ba83` | 50 across 4 scenarios | 2,184 | Uno, AVR `arduino:avr@1.8.6`; downloaded ZIP compiled directly with Arduino CLI |
| Adjustable hysteresis thermostat | `d7d22e45-9b82-4ed9-8a11-259a50fcb7a1` | 27 across 3 scenarios | 356 | MKR Zero, ARM/SAMD `arduino:samd@1.8.14`; downloaded ZIP compiled directly with Arduino CLI |

The live car uses direction pins D7/D8 and PWM pins D5/D6. Its four keyboard inputs travel through the exported Python serial companion; car position and heading remain explicitly simulated environmental state. The actual downloaded AVR HEX was additionally executed in AVR8js: 34 comparisons exercised all four generated keyboard inputs, press/release, output direction, PWM duty and loss-of-host timeout against the authoritative controller. The live thermostat maps its linear 0–50 °C analog module to A0, relay driver control to D7, and threshold/on-time telemetry to the computer serial companion. Its sensor requires a board-compatible 0–reference-voltage output; actual calibration has not been tested. Both Python companions passed syntax compilation.

The first provider attempts did **not** pass. Earlier car attempts failed schema validation (redundant state/output declarations, unsupported mathematical expressions, string-valued hardware variables and an invalid output envelope). The thermostat's original acceptance generation failed typed-boolean validation and produced an honest runnable draft. Those failed/draft records remain in `.artifacts/live-hardware/simulations/`; they were not relabeled as successful. Generic schema explanations, safe removal of identical redundant declarations, typed 0/1 boolean normalization before tests were frozen, and the string-observable/environment boundary were improved. The car's final implementation was generated again against its unchanged frozen live specification and 50 assertions. The thermostat's unchanged generated implementation received a fresh independent verifier pass that saw only its existing specification; the resulting suite then ran in the normal SimulationController browser workflow. No frozen expected result was weakened to force a pass.

Both final runs were configured and built through `HardwareProjectService`, downloaded through the actual HTTP ZIP endpoint, extracted with `unzip`, and rebuilt using a direct Arduino CLI process in fresh build/output directories. No source generator or app service participated in that independent compilation. No board was flashed and **no physical behavior was tested**. SAMD was target-compiled but not CPU-emulated.

Live evidence and usable downloads are retained in `.artifacts/live-hardware/`:

- `keyboard-car-hardware.zip`, `thermostat-hardware.zip`: actual HTTP downloads with source, documentation, companion applications and compiled firmware.
- `car-hardware-report.json`, `thermostat-hardware-report.json`: exact bindings, core versions, assertion/parity counts, hashes and direct independent compilation commands.
- `car-avr-emulation.json`: 34 checks against the downloaded car firmware in the AVR CPU simulator.
- `*-independent-compile.log`: real compiler logs from the extracted ZIPs.
- `keyboard-car.json`, `thermostat.json`: final live project contracts, candidates and browser evidence.

`scripts/smoke-portable-generation.ts` submits the two live prompts. `scripts/repair-portable-smoke.ts` retries a live builder using an already-frozen generated contract; `scripts/recheck-portable-smoke.ts` obtains an independent suite for an unchanged live draft that had no acceptance suite. `scripts/build-live-portable.ts` configures compatible pins from actual profile metadata, builds, downloads and independently recompiles a named live artifact. `scripts/probe-live-avr.ts` reproduces the saved live car's downloaded-firmware checks. These scripts are verification harnesses; production generation contains no car-specific routing or templates.
