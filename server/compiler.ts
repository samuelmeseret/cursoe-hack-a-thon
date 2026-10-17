import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Candidate } from '../shared/types.js';

const root = process.cwd();
const arduinoDirectory = path.resolve(root, '.arduino');
const allowedHeaders = new Set(['Arduino.h', 'stdint.h', 'stdbool.h', 'stddef.h', 'stdlib.h', 'string.h', 'math.h', 'avr/io.h', 'avr/interrupt.h', 'util/delay.h', 'util/atomic.h']);

export function validateFirmwareSource(source: string): void {
  // Constrain the local compiler's file access: model sketches need only the installed Uno core.
  // Check after line splicing so a split directive cannot bypass this check.
  const normalized = source.replace(/\\\r?\n/g, '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  if (/\b(?:asm|__asm|__asm__)\b|##|%:|\?\?[=/']/.test(normalized)) throw new Error('Inline assembly, alternate directive tokens, and preprocessor token pasting are outside the supported firmware scope');
  for (const match of normalized.matchAll(/^\s*#\s*(\w+)([^\n]*)/gm)) {
    const [, directive, remainder] = match;
    if (directive === 'include') {
      const header = remainder.trim().match(/^[<"]([^>"]+)[>"]$/)?.[1];
      if (!header || !allowedHeaders.has(header)) throw new Error('Firmware includes must name an approved Arduino core header');
    } else if (!['define', 'undef', 'if', 'ifdef', 'ifndef', 'elif', 'else', 'endif', 'error'].includes(directive)) {
      throw new Error(`Unsupported firmware preprocessor directive: #${directive}`);
    }
  }
}

async function executable(): Promise<string> {
  if (process.env.ARDUINO_CLI_PATH) return process.env.ARDUINO_CLI_PATH;
  const local = path.join(arduinoDirectory, 'bin', process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
  try { await access(local, constants.X_OK); return local; } catch { return 'arduino-cli'; }
}

function compilerEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARDUINO_DIRECTORIES_DATA: process.env.ARDUINO_DIRECTORIES_DATA ?? path.join(arduinoDirectory, 'data'),
    ARDUINO_DIRECTORIES_DOWNLOADS: process.env.ARDUINO_DIRECTORIES_DOWNLOADS ?? path.join(arduinoDirectory, 'downloads'),
    ARDUINO_DIRECTORIES_USER: process.env.ARDUINO_DIRECTORIES_USER ?? path.join(arduinoDirectory, 'user'),
    ARDUINO_UPDATER_ENABLE_NOTIFICATION: 'false',
  };
}

async function command(args: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  const bin = await executable();
  if (options.signal?.aborted) throw new Error('Compilation cancelled');
  return new Promise((resolve, reject) => {
    // Generated source is only written to an .ino file. It never becomes a shell argument or script.
    const child = spawn(bin, args, { env: compilerEnvironment(), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let stopped: string | undefined;
    const append = (chunk: Buffer) => { log = (log + chunk.toString('utf8')).slice(-100_000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const stop = (reason: string) => {
      stopped = reason;
      // Arduino CLI launches avr-gcc children; terminate the entire process group.
      if (child.pid) {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => stop('Compilation cancelled');
    const timer = setTimeout(() => stop('Compilation timed out'), Math.max(1, options.timeoutMs ?? 45_000));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.once('error', (error) => { cleanup(); reject(new Error(`Arduino CLI unavailable: ${error.message}. Run npm run setup:arduino.`)); });
    child.once('close', (code) => {
      cleanup();
      if (stopped) reject(new Error(`${stopped}${log ? `\n${log}` : ''}`));
      else if (code !== 0) reject(new Error(`Arduino compilation failed (exit ${code}):\n${log}`));
      else resolve(log);
    });
  });
}

export async function compilerAvailable(): Promise<boolean> {
  try {
    const result = await command(['core', 'list', '--json'], { timeoutMs: 8_000 });
    const data: unknown = JSON.parse(result);
    const platforms = Array.isArray(data) ? data : (data as { platforms?: unknown[] }).platforms;
    return Array.isArray(platforms) && platforms.some((platform) => {
      const entry = platform as { id?: string; installed_version?: string; version?: string };
      return entry.id === 'arduino:avr' && Boolean(entry.installed_version ?? entry.version);
    });
  } catch { return false; }
}

export async function compileCandidate(candidate: Candidate, workDir: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ hex: string; log: string; hexPath: string }> {
  if (typeof candidate.source !== 'string' || !candidate.source.trim()) throw new Error('Firmware source is empty');
  if (Buffer.byteLength(candidate.source, 'utf8') > 100_000) throw new Error('Firmware source exceeds 100 KB');
  validateFirmwareSource(candidate.source);
  const directory = path.resolve(workDir);
  const sketchDir = path.join(directory, 'sketch');
  const outputDir = path.join(directory, 'firmware');
  await mkdir(sketchDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(sketchDir, 'sketch.ino'), candidate.source, 'utf8');
  const log = await command(['compile', '--fqbn', 'arduino:avr:uno', '--warnings', 'all', '--jobs', '2', '--output-dir', outputDir, '--build-path', path.join(directory, 'build'), sketchDir], options);
  const hexPath = path.join(outputDir, 'sketch.ino.hex');
  const hex = await readFile(hexPath, 'utf8');
  if (!hex.startsWith(':') || !hex.trimEnd().endsWith(':00000001FF')) throw new Error('Compiler did not produce a complete Intel HEX file');
  return { hex, log, hexPath };
}
