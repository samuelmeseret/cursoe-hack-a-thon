import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPortableController, emitControllerCpp, type PortableControllerProgram } from '../shared/portable-controller.js';
import type { SimulationScenario, SimulationSpec } from '../shared/simulation-types.js';

function execute(command: string, args: string[], input = '', timeoutMs = 45000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native controller parity check timed out.')); }, timeoutMs);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 4000000) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-20000); });
    child.once('error', reason => { clearTimeout(timer); reject(new Error(`Native C++ compiler/runtime unavailable: ${reason.message}`)); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`Native controller check failed (${code}): ${error}`)); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Replay the same input/timing trace through JS and actual compiled C++, independent of the visual renderer. */
export async function checkControllerParity(program: PortableControllerProgram, spec: SimulationSpec, scenarios: SimulationScenario[], directory: string): Promise<{ passed: true; checks: number; log: string }> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'controller.h'), emitControllerCpp(program));
  const variables = [...program.inputs, ...program.state, ...program.outputs];
  const harness = `#include <stdio.h>\n#include <string.h>\n#include "controller.h"\nint main(){PortableController c; char op[4], id[80]; float value; while(scanf("%3s",op)==1){ if(op[0]=='R')c.reset(); else if(op[0]=='I'){if(scanf("%79s %f",id,&value)!=2)return 2;c.input(id,value);} else if(op[0]=='S'){if(scanf("%f",&value)!=1)return 2;c.step(value);} else if(op[0]=='P'){${variables.map(variable => `printf("%.9g ",(double)c.get(${JSON.stringify(variable.id)}));`).join('')}puts("");}else return 3;}return 0;}\n`;
  await writeFile(path.join(directory, 'parity.cpp'), harness);
  const executable = path.join(directory, 'parity');
  await execute(process.env.CXX || 'c++', ['-std=c++11', '-O0', '-ffp-contract=off', path.join(directory, 'parity.cpp'), '-o', executable]);
  const controller = createPortableController(program);
  const operations: string[] = [];
  const expected: number[][] = [];
  const sample = () => { operations.push('P'); expected.push(variables.map(variable => Number(controller.get(variable.id)))); };
  const input = (id: string, value: number | boolean) => { controller.input(id, value); operations.push(`I ${id} ${Math.fround(Number(value))}`); };
  const reset = () => { controller.reset(); operations.push('R'); for (const control of spec.controls) if (program.inputs.some(input => input.id === control.id) && (typeof control.initial === 'number' || typeof control.initial === 'boolean')) input(control.id, control.initial); sample(); };
  const step = (dt: number) => { controller.step(dt); operations.push(`S ${Math.fround(dt)}`); };
  for (const scenario of scenarios) {
    reset();
    let elapsed = 0;
    for (const operation of scenario.steps) {
      if (operation.type === 'input' && program.inputs.some(input => input.id === operation.controlId) && (typeof operation.value === 'number' || typeof operation.value === 'boolean')) input(operation.controlId, operation.value);
      else if (operation.type === 'reset') { reset(); elapsed = 0; }
      else if (operation.type === 'advance') {
        const target = elapsed + operation.durationMs / 1000;
        while (elapsed < target) { const next = Math.min(elapsed + 1 / 60, target); step(next - elapsed); elapsed = next; }
      }
      sample();
    }
  }
  // Different inputs and scheduler intervals exercise the generated controller beyond the acceptance suite.
  reset();
  for (const signal of program.inputs) {
    for (const value of signal.type === 'boolean' ? [true, false, true, false] : [signal.hardware.min ?? 0, signal.hardware.max ?? 1, signal.initial]) {
      input(signal.id, value); sample();
      for (const dt of [0.001, 0.01, 0.016666667, 0.1]) { step(dt); sample(); }
    }
  }
  const actual = (await execute(executable, [], `${operations.join('\n')}\n`)).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  if (actual.length !== expected.length) throw new Error(`Controller parity trace incomplete: ${actual.length}/${expected.length} samples.`);
  let checks = 0;
  for (let row = 0; row < expected.length; row++) {
    if (actual[row].length !== variables.length) throw new Error('Native controller returned incomplete state.');
    for (let column = 0; column < variables.length; column++) {
      const wanted = expected[row][column], observed = actual[row][column];
      if (!Number.isFinite(wanted) || !Number.isFinite(observed) || Math.abs(observed - wanted) > Math.max(1e-6, Math.abs(wanted) * 2e-6)) throw new Error(`Controller parity failed at sample ${row}, ${variables[column].id}: browser ${wanted}, C++ ${observed}.`);
      checks++;
    }
  }
  const log = `${checks} scalar comparisons passed across ${expected.length} samples: acceptance inputs plus varied input/scheduler trace. Actual compiled native C++ matched float32 JavaScript. This is controller parity, not target MCU emulation or physical testing.`;
  await writeFile(path.join(directory, 'parity-report.json'), JSON.stringify({ passed: true, checks, samples: expected.length, log }, null, 2));
  return { passed: true, checks, log };
}
