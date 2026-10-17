import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SimulationController, type SimulationAgentService } from '../server/simulation-controller';
import { HardwareFixtureAgents, timedLight } from './hardware-fixtures';
import { composeControllerSimulation } from '../shared/portable-controller';
import type { SimulationCandidate } from '../shared/simulation-types';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('repairing the authoritative controller after hardware compilation fails', () => {
  it('preserves the frozen requirements and checks while replacing both simulation and firmware controller source', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hardware-repair-')); directories.push(directory);
    const base = new HardwareFixtureAgents(timedLight);
    let calls = 0;
    const build = vi.fn<SimulationAgentService['build']>(async (): Promise<SimulationCandidate> => {
      const candidate = await base.build();
      if (++calls > 1) {
        candidate.controller!.name += ' repaired';
        candidate.environmentSource += '\n// Toolchain repair retained physical environment.';
        candidate.source = composeControllerSimulation(candidate.controller!, candidate.environmentSource!);
      }
      return candidate;
    });
    const agents = { model: base.model, validateModel: base.validateModel.bind(base), specify: base.specify.bind(base), verify: base.verify.bind(base), build };
    const controller = new SimulationController({ directory, agents });
    const initial = await controller.start({ prompt: timedLight.spec.goal });
    const original = (await controller.wait(initial.id))!;
    expect(original.status).toBe('READY');
    const repaired = await controller.repairHardware(initial.id, 'Actual compiler reported flash overflow. Simplify control expressions.');
    expect(repaired.status).toBe('READY');
    expect(repaired.projectId).toBe(original.projectId);
    expect(repaired.id).toBe(original.id);
    expect(repaired.spec).toEqual(original.spec);
    expect(repaired.scenarios).toEqual(original.scenarios);
    expect(repaired.candidate!.source).not.toBe(original.candidate!.source);
    expect(repaired.evidence!.sourceHash).not.toBe(original.evidence!.sourceHash);
    expect(build.mock.calls[1][2]).toMatchObject({ previous: original.candidate, failures: { error: expect.stringContaining('flash overflow') } });
    expect((await controller.get(initial.id))!.status).toBe('READY');
    const next = await controller.start({ previousId: initial.id, prompt: 'Preserve the timer and change the visual color.' });
    await controller.wait(next.id);
    await expect(controller.repairHardware(initial.id, 'late error')).rejects.toThrow('newer project revision');
  }, 120000);
});
