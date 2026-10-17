# One controller from simulation to hardware

A portable Simulation Lab candidate contains two sources:

- `controller`: a typed, bounded JSON program. This is the authoritative application logic.
- `environmentSource`: JavaScript implementing `createEnvironment(controller)`. It models the surroundings and draws the scene.

`shared/portable-controller.ts` validates the program and emits both the browser controller and the standalone C++11 `PortableController` class. The firmware wrapper does not interpret the visual scene or ask an agent to approximate it. The runtime and candidate validator recompose the simulation from its controller and environment, ignoring any stale combined source.

The browser environment receives only `controller.get(id)` and `controller.snapshot()`. It cannot call input/reset/step or assign controller state. Its optional `sensors()` method can feed declared digital/analog sensor inputs; it cannot synthesize serial keyboard commands. Sensor feedback is delivered only when the sampled, float32-normalized value changes, matching the hardware sampling wrapper. The controller's inputs, state and outputs override duplicate environment snapshot properties.

Keep unmeasured position, simulated temperature evolution, collision geometry and rendering in the environment. A real device can only observe a quantity when the project includes the necessary sensor and supported driver. Readable string labels belong in the environment, derived from differently named numeric/boolean controller signals. For example a boolean output may be displayed as “active” or “idle”; the display label is not a hardware pin.

## Program v1

A program declares `version: 1`, `name`, `inputs`, internal `state`, `outputs`, `step`, and `update`. Optional fields are `onInput`, `requiredCapabilities`, and `assumptions`. Inputs, internal state and outputs share one identifier namespace. Outputs already have mutable storage and must not also appear in state. Values are numbers or booleans; strings and collections are environment-only.

An expression is a number, boolean, `{ "ref": "signalId" }`, `{ "dt": true }`, or `{ "op": "add", "args": [EXPRESSION, EXPRESSION] }`. Arithmetic includes addition, subtraction, multiplication, defined division/modulo, min/max/clamp, abs/floor/round/negation, and sin/cos. Comparisons and boolean operations support conditions. `select` chooses between two same-type values. Statements assign state/output values or branch on a boolean condition. There are no unbounded loops, arbitrary code, pointers, or imports.

Each input carries its initial value, scalar type, label and physical-interface requirement. Current interfaces are serial, digital input, and analog input. Outputs use serial telemetry, digital output, or PWM. Component, connection, engineering-range, unit and voltage metadata inform configuration and documentation. Extra drivers or protocols must be declared as required capabilities, for example `driver:i2c:bme280` or `transport:wifi`; listing a capability does not implement it. The hardware service blocks unsupported capabilities instead of exporting a fictional device implementation.

The execution order is:

1. Reset every input/state/output to its initial value, then execute `update` with `dt = 0`.
2. On an input event, assign the input, execute its optional `onInput` statements, then `update` with `dt = 0`.
3. On time advancement, execute `step` and then `update` with elapsed seconds in `dt`.

Use `step` for elapsed-time integration and `update` for immediate derived outputs. Repeated true button events are distinct events, while a held keyboard key is a retained boolean state.

Every arithmetic operation rounds to IEEE-754 binary32. Division/modulo by zero and nonfinite arithmetic produce zero consistently in both backends. Sin/cos use the same range reduction and polynomial operations in JavaScript and C++; they avoid differing platform math-library implementations. Moderate-angle error is approximately 1e-6; applications should wrap phase because very large binary32 angles lose resolution.

## Verification boundaries

`tests/portable-controller.test.ts` invokes a real native C++ compiler and replays the same traces against emitted C++ and JavaScript, including every expression operation and hysteresis/event/timer behavior. `tests/portable-firmware.test.ts` compiles the actual generated Arduino wrapper and executes its Intel HEX in the existing AVR CPU simulator to check serial frames, heartbeat, malformed commands, release and timeout at GPIO level.

Native parity proves agreement between the two controller backends on the exercised traces. Browser acceptance checks prove the modeled requirements on their exercised scenarios. Selected-target compilation proves that the actual board toolchain accepts the generated hardware project. AVR CPU simulation exercises compiled firmware without a board. None of these establish physical wiring, sensor calibration, motor polarity, power adequacy or actual physical behavior. Physical testing is reported separately and remains false until it has actually happened.

Older source-only simulations remain runnable but have no portable controller. They cannot gain hardware support through an unrelated firmware template; an agent must create a new portable revision. A generation failure or incomplete independent acceptance suite remains visibly failed/draft even when a controller compiles.
