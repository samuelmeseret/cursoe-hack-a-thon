import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RunState } from '../shared/types.js';
import { artifactHashes, canonical, evidencePasses, sha256 } from './evidence.js';
import { circuitSvg } from './diagram.js';

export const artifactDirectory = path.resolve(process.env.ARTIFACT_DIR || path.join(homedir(), '.local', 'share', 'airlock-lab', 'runs'));
export const runDirectory = (id: string) => {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid run identifier');
  return path.join(artifactDirectory, id);
};
export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export async function saveState(run: RunState) {
  const directory = runDirectory(run.id);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, 'run.json.tmp');
  await writeFile(temporary, json(run));
  await rename(temporary, path.join(directory, 'run.json'));
}
export async function saveCurrentArtifacts(run: RunState, diagram: string) {
  const directory = runDirectory(run.id);
  await mkdir(directory, { recursive: true });
  const files: Record<string, string> = {
    'requirements.json': json(run.spec), 'tests.json': json(run.scenarios),
    'sketch.ino': run.candidate!.source, 'circuit.json': json(run.circuit),
    'circuit.svg': diagram, 'firmware.hex': run.hex!, 'verification.json': json(run.evidence),
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content);
}
export async function artifactsStillMatch(run: RunState): Promise<boolean> {
  if (!run.candidate || !run.circuit || !run.hex || !run.spec || !run.scenarios || !run.evidence) return false;
  try {
    const read = (name: string) => readFile(path.join(runDirectory(run.id), name), 'utf8');
    const [source, circuit, hex, spec, scenarios, report, diagram] = await Promise.all(['sketch.ino', 'circuit.json', 'firmware.hex', 'requirements.json', 'tests.json', 'verification.json', 'circuit.svg'].map(read));
    const hashes = artifactHashes({ ...run.candidate, source }, JSON.parse(circuit), hex, JSON.parse(spec), JSON.parse(scenarios));
    if (sha256(canonical(JSON.parse(report))) !== sha256(canonical(run.evidence))) return false;
    if (diagram !== circuitSvg(JSON.parse(circuit))) return false;
    return evidencePasses(run.evidence, hashes, run.scenarios, run.candidate.id);
  } catch { return false; }
}
