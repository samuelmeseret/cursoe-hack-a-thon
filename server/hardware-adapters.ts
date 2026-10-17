import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BoardCatalogEntry, BoardPackageEntry, ConnectedDevice, HardwareBuildResult, HardwareCatalog, HardwareLibrary, HardwarePin, HardwareProfile } from '../shared/hardware-types.js';

export type { HardwareProfile, HardwareBuildResult, HardwareCatalog, ConnectedDevice } from '../shared/hardware-types.js';

const localArduino = path.resolve('.arduino');
const fqbnPattern = /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+=[a-zA-Z0-9_.+-]+(?:,[a-zA-Z0-9_-]+=[a-zA-Z0-9_.+-]+)*)?$/;
const packagePattern = /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/;
const versionPattern = /^[a-zA-Z0-9_.+-]{1,80}$/;

export function hardwareEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARDUINO_DIRECTORIES_DATA: process.env.ARDUINO_DIRECTORIES_DATA ?? path.join(localArduino, 'data'),
    ARDUINO_DIRECTORIES_DOWNLOADS: process.env.ARDUINO_DIRECTORIES_DOWNLOADS ?? path.join(localArduino, 'downloads'),
    ARDUINO_DIRECTORIES_USER: process.env.ARDUINO_DIRECTORIES_USER ?? path.join(localArduino, 'user'),
    ARDUINO_UPDATER_ENABLE_NOTIFICATION: 'false',
  };
}

async function arduinoExecutable(): Promise<string> {
  if (process.env.ARDUINO_CLI_PATH) return process.env.ARDUINO_CLI_PATH;
  const executable = path.join(localArduino, 'bin', process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
  try { await access(executable, constants.X_OK); return executable; } catch { return 'arduino-cli'; }
}

type CommandOptions = { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number };

async function execute(executable: string, args: string[], options: CommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw new Error('Hardware operation cancelled');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: hardwareEnvironment(), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let bytes = 0; let stopped: string | undefined;
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = reason;
      if (child.pid) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const append = (stream: 'stdout' | 'stderr', buffer: Buffer) => {
      bytes += buffer.byteLength;
      if (bytes > (options.maxOutputBytes ?? 16_000_000)) { stop('Hardware tool output exceeded the 16 MB limit'); return; }
      if (stream === 'stdout') stdout += buffer.toString('utf8'); else stderr += buffer.toString('utf8');
    };
    child.stdout.on('data', (buffer: Buffer) => append('stdout', buffer));
    child.stderr.on('data', (buffer: Buffer) => append('stderr', buffer));
    const timer = setTimeout(() => stop('Hardware operation timed out'), Math.max(1, options.timeoutMs ?? 30_000));
    const abort = () => stop('Hardware operation cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.once('error', (error) => { cleanup(); reject(new Error(`Hardware tool unavailable: ${error.message}. Install the toolchain with npm run setup:arduino.`)); });
    child.once('close', (code) => {
      cleanup();
      const log = [stdout, stderr].filter(Boolean).join('\n').slice(-120_000);
      if (stopped) reject(new Error(`${stopped}\n${log}`));
      else if (code !== 0) reject(new Error(`Hardware tool failed (exit ${code}):\n${log}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function cli(args: string[], options?: CommandOptions) { return execute(await arduinoExecutable(), args, options); }
async function cliJson<T>(args: string[], options?: CommandOptions): Promise<T> {
  const { stdout } = await cli([...args, '--json'], options);
  try { return JSON.parse(stdout) as T; } catch { throw new Error('Arduino CLI returned invalid JSON; no hardware result was accepted.'); }
}

function assertFqbn(fqbn: string): void {
  if (!fqbnPattern.test(fqbn) || fqbn.length > 400) throw new Error('Select an exact board FQBN from the catalog (vendor:architecture:board[:option=value]).');
}

function missingReader(architecture: string): string[] {
  return profileReaders.has(architecture.toLowerCase()) ? [] : [`No pin-capability reader is registered for ${architecture}; add a device profile reader before configuring or exporting this target.`];
}

interface CliBoard { name: string; fqbn: string; platform?: { metadata?: { id?: string }; release?: { version?: string } } }
interface InstalledCore { id: string; installed_version?: string; version?: string }
async function installedCores(): Promise<Map<string, string>> {
  const result = await cliJson<{ platforms?: InstalledCore[] } | InstalledCore[]>(['core', 'list']);
  return new Map((Array.isArray(result) ? result : result.platforms ?? []).map((core) => [core.id, core.installed_version ?? core.version ?? '']));
}

/** Only package-manager indexes already configured by the user are trusted for installation. */
async function indexedPackages(installed: Map<string, string>): Promise<BoardPackageEntry[]> {
  const directory = hardwareEnvironment().ARDUINO_DIRECTORIES_DATA!;
  const files = (await readdir(directory)).filter((name) => /^package.*index\.json$/.test(name));
  if (!files.length) throw new Error('Arduino package catalog is missing. Refresh the catalog or run npm run setup:arduino.');
  const latest = new Map<string, BoardPackageEntry>();
  for (const file of files) {
    const data = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as { packages?: { name: string; maintainer?: string; platforms?: { architecture: string; version: string; name: string; boards?: { name: string }[] }[] }[] };
    for (const vendor of data.packages ?? []) for (const platform of vendor.platforms ?? []) {
      const id = `${vendor.name}:${platform.architecture}`;
      const previous = latest.get(id);
      if (previous && previous.version.localeCompare(platform.version, undefined, { numeric: true }) >= 0) continue;
      latest.set(id, { id, name: platform.name, architecture: platform.architecture, version: platform.version, installed: installed.has(id), maintainer: vendor.maintainer ?? vendor.name, boards: (platform.boards ?? []).map((board) => board.name) });
    }
  }
  return [...latest.values()];
}

async function searchArduinoHardware(query = ''): Promise<HardwareCatalog> {
  if (query.length > 200) throw new Error('Board search must be 200 characters or fewer.');
  const [listed, installed] = await Promise.all([cliJson<{ boards?: CliBoard[] }>(['board', 'listall']), installedCores()]);
  const allPackages = await indexedPackages(installed);
  const needle = query.trim().toLowerCase();
  const matches = (...values: string[]) => !needle || values.some((value) => value.toLowerCase().includes(needle));
  const boards: BoardCatalogEntry[] = (listed.boards ?? []).filter((board) => matches(board.name, board.fqbn)).map((board) => {
    const core = board.fqbn.split(':').slice(0, 2).join(':');
    const architecture = board.fqbn.split(':')[1];
    const missingCapabilities = missingReader(architecture);
    return { id: board.fqbn, name: board.name, fqbn: board.fqbn, architecture, core, version: installed.get(core) ?? board.platform?.release?.version ?? '', installed: installed.has(core), supported: missingCapabilities.length === 0, missingCapabilities };
  });
  for (const core of allPackages.filter((entry) => !entry.installed)) for (const name of core.boards) {
    if (!matches(name, core.id, core.name)) continue;
    boards.push({ id: `${core.id}/${name}`, name, architecture: core.architecture, core: core.id, version: core.version, installed: false, supported: missingReader(core.architecture).length === 0, missingCapabilities: missingReader(core.architecture) });
  }
  boards.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
  return { boards: boards.slice(0, 200), packages: allPackages.filter((core) => matches(core.name, core.id, ...core.boards)), warnings: boards.length > 200 ? ['Showing the first 200 matches. Search a more specific board name.'] : [] };
}

export async function searchHardware(query = ''): Promise<HardwareCatalog> {
  if (query.length > 200) throw new Error('Board search must be 200 characters or fewer.');
  const providers = [...profileProviders.values()].filter(provider => provider.search);
  const results = await Promise.allSettled([searchArduinoHardware(query), ...providers.map(provider => provider.search!(query))]);
  const catalog: HardwareCatalog = { boards: [], packages: [], warnings: [] };
  for (const result of results) {
    if (result.status === 'fulfilled') {
      catalog.boards.push(...result.value.boards); catalog.packages.push(...result.value.packages); catalog.warnings.push(...result.value.warnings);
    } else catalog.warnings.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
  }
  if (results.every(result => result.status === 'rejected')) throw new Error(catalog.warnings.join('\n'));
  return catalog;
}

export async function connectedHardware(): Promise<ConnectedDevice[]> {
  const data = await cliJson<{ detected_ports?: { port: { address: string; label?: string; protocol?: string }; matching_boards?: { name: string; fqbn: string }[] }[] }>(['board', 'list', '--discovery-timeout', '2s']);
  return (data.detected_ports ?? []).map((entry) => ({ port: entry.port.address, label: entry.port.label ?? entry.port.address, protocol: entry.port.protocol ?? 'unknown', boards: entry.matching_boards ?? [], identified: Boolean(entry.matching_boards?.length) }));
}

let installQueue: Promise<unknown> = Promise.resolve();
function serializedInstall<T>(operation: () => Promise<T>): Promise<T> {
  const result = installQueue.then(operation, operation);
  installQueue = result.catch(() => undefined);
  return result;
}

export async function refreshHardwareCatalog(options: CommandOptions = {}): Promise<string> {
  return serializedInstall(async () => {
    const result = await cli(['core', 'update-index'], { timeoutMs: 180_000, ...options });
    return `${result.stdout}\n${result.stderr}`.trim();
  });
}

export async function installHardwarePackage(packageId: string, version?: string, options: CommandOptions = {}): Promise<{ id: string; version: string; log: string }> {
  if (!packagePattern.test(packageId) || (version && !versionPattern.test(version))) throw new Error('Invalid board package identifier or version.');
  return serializedInstall(async () => {
    const installed = await installedCores();
    if (installed.has(packageId) && (!version || installed.get(packageId) === version)) return { id: packageId, version: installed.get(packageId)!, log: 'Required board package is already installed.' };
    const catalog = await indexedPackages(installed);
    if (!catalog.some((entry) => entry.id === packageId)) throw new Error(`Board package ${packageId} is absent from the configured Arduino package catalogs. Add its official board-manager index before installing it.`);
    const selected = `${packageId}${version ? `@${version}` : ''}`;
    const result = await cli(['core', 'install', selected], { timeoutMs: 360_000, ...options });
    profileCache.clear();
    const after = await installedCores();
    if (!after.has(packageId)) throw new Error(`Package manager did not report ${packageId} installed after installation.`);
    return { id: packageId, version: after.get(packageId)!, log: `${result.stdout}\n${result.stderr}`.trim() };
  });
}

interface BoardDetails {
  fqbn: string; name: string; version: string;
  platform?: { architecture?: string };
  build_properties?: string[];
  config_options?: { option: string; option_label: string; values: { value: string; value_label: string; selected?: boolean }[] }[];
}

function properties(details: BoardDetails): Record<string, string> {
  return Object.fromEntries((details.build_properties ?? []).map((entry) => { const equals = entry.indexOf('='); return [entry.slice(0, equals), entry.slice(equals + 1)]; }));
}

/** A deliberately small, non-evaluating parser for C integer metadata expressions. */
export function metadataInteger(expression: string, constants: Record<string, string> = {}, depth = 0): number | undefined {
  if (depth > 12 || expression.length > 3000) return undefined;
  const expanded = expression.replace(/\b(0x[\da-f]+|\d+)[uUlL]*\b/gi, '$1').replace(/\b[A-Za-z_]\w*\b/g, (name) => {
    if (name === 'true') return '1'; if (name === 'false') return '0';
    const value = constants[name] ? metadataInteger(constants[name], constants, depth + 1) : undefined;
    return value === undefined ? name : String(value);
  });
  if (/[^\da-fx\s()+\-*/%<>=!&|?:]/i.test(expanded)) return undefined;
  const tokens = expanded.match(/0x[\da-f]+|\d+|&&|\|\||==|!=|<=|>=|[()+\-*/%<>&|!?:]/gi) ?? [];
  let index = 0;
  const precedence: Record<string, number> = { '||': 1, '&&': 2, '|': 3, '&': 4, '==': 5, '!=': 5, '<': 6, '>': 6, '<=': 6, '>=': 6, '+': 7, '-': 7, '*': 8, '/': 8, '%': 8 };
  const primary = (): number => {
    const token = tokens[index++];
    if (token === '(') { const value = conditional(); if (tokens[index++] !== ')') throw new Error('parenthesis'); return value; }
    if (token === '!') return Number(!primary()); if (token === '-') return -primary(); if (token === '+') return primary();
    if (!token || !/^(?:0x[\da-f]+|\d+)$/i.test(token)) throw new Error('literal');
    return Number(token);
  };
  const binary = (minimum: number): number => {
    let left = primary();
    while ((precedence[tokens[index]] ?? 0) >= minimum) {
      const operator = tokens[index++]; const right = binary(precedence[operator] + 1);
      switch (operator) {
        case '+': left += right; break; case '-': left -= right; break; case '*': left *= right; break; case '/': left = Math.trunc(left / right); break; case '%': left %= right; break;
        case '==': left = Number(left === right); break; case '!=': left = Number(left !== right); break; case '<': left = Number(left < right); break; case '>': left = Number(left > right); break; case '<=': left = Number(left <= right); break; case '>=': left = Number(left >= right); break;
        case '&&': left = Number(Boolean(left && right)); break; case '||': left = Number(Boolean(left || right)); break; case '&': left &= right; break; case '|': left |= right; break;
      }
    }
    return left;
  };
  const conditional = (): number => { const test = binary(1); if (tokens[index] !== '?') return test; index++; const yes = conditional(); if (tokens[index++] !== ':') throw new Error('conditional'); const no = conditional(); return test ? yes : no; };
  try { const value = conditional(); return index === tokens.length && Number.isFinite(value) ? value : undefined; } catch { return undefined; }
}

function metadataConstants(source: string): Record<string, string> {
  source = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const values: Record<string, string> = {};
  for (const match of source.matchAll(/^\s*#\s*define\s+(\w+)\s+([^\n]+)$/gm)) values[match[1]] = match[2].replace(/\/\/.*$/, '').trim();
  for (const match of source.matchAll(/(?:static\s+)?const\s+(?:uint\d+_t|unsigned\s+int|int)\s+(\w+)\s*=\s*([^;]+);/g)) values[match[1]] = match[2];
  return values;
}

function pinsFromMetadata(header: string, architecture: string, variantSource?: string): HardwarePin[] {
  const values = metadataConstants(header);
  const number = (name: string) => values[name] === undefined ? undefined : metadataInteger(values[name], values);
  const digitalCount = number('NUM_DIGITAL_PINS'); const analogCount = number('NUM_ANALOG_INPUTS');
  if (!digitalCount || digitalCount > 256 || analogCount === undefined || analogCount > 64) throw new Error('Installed variant does not expose usable NUM_DIGITAL_PINS and NUM_ANALOG_INPUTS metadata.');
  const analog = new Map<number, string>();
  for (let i = 0; i < analogCount; i++) { const pin = number(`A${i}`) ?? number(`PIN_A${i}`); if (pin !== undefined) analog.set(pin, `A${i}`); }
  if (analogCount && !analog.size) throw new Error('Installed variant does not expose analog pin aliases; this variant needs an additional profile reader.');
  const maxPin = Math.max(digitalCount - 1, ...analog.keys());
  const pwmMacro = header.match(/^\s*#\s*define\s+digitalPinHasPWM\((\w+)\)\s+([^\n]+)/m);
  const rows = variantSource?.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').match(/g_APinDescription\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/)?.[1].match(/\{[^{}]+\}/g);
  if (architecture === 'samd' && !rows?.length) throw new Error('SAMD variant pin-description table could not be read; this variant needs an additional profile reader.');
  const interfaceNames: Record<string, string[]> = { 'i2c.sda': ['PIN_WIRE_SDA', 'SDA'], 'i2c.scl': ['PIN_WIRE_SCL', 'SCL'], 'spi.mosi': ['PIN_SPI_MOSI', 'MOSI'], 'spi.miso': ['PIN_SPI_MISO', 'MISO'], 'spi.sck': ['PIN_SPI_SCK', 'SCK'], 'spi.ss': ['PIN_SPI_SS', 'SS'], 'uart.rx': ['PIN_SERIAL_RX'], 'uart.tx': ['PIN_SERIAL_TX'], 'uart1.rx': ['PIN_SERIAL1_RX'], 'uart1.tx': ['PIN_SERIAL1_TX'] };
  return Array.from({ length: maxPin + 1 }, (_, pin) => {
    const interfaces = Object.entries(interfaceNames).filter(([, names]) => names.some((name) => number(name) === pin)).map(([name]) => name);
    let pwm = false;
    if (architecture === 'avr' && pwmMacro) {
      const value = metadataInteger(pwmMacro[2].replace(new RegExp(`\\b${pwmMacro[1]}\\b`, 'g'), String(pin)), values);
      if (value === undefined) throw new Error('AVR PWM metadata contains an unsupported expression; add a profile reader for this variant.');
      pwm = Boolean(value);
    } else if (architecture === 'samd') {
      const columns = rows?.[pin]?.replace(/[{}]/g, '').split(',').map((column) => column.trim());
      pwm = Boolean(columns && columns.length >= 7 && (columns[5] !== 'NOT_ON_PWM' || columns[6] !== 'NOT_ON_TIMER'));
    }
    const alias = analog.get(pin); const digital = architecture === 'samd' ? /\bPIN_ATTR_DIGITAL\b/.test(rows?.[pin] ?? '') : pin < digitalCount;
    return { id: alias ?? String(pin), number: pin, label: alias ? `${alias} (D${pin})` : `D${pin}`, digital, analog: Boolean(alias), pwm, interfaces };
  });
}

const profileCache = new Map<string, { at: number; profile: HardwareProfile }>();

export interface DeviceProfileReader {
  architecture: string;
  read(context: { properties: Record<string, string>; signal?: AbortSignal }): Promise<{ pins: HardwarePin[]; metadataSources: string[]; constraints: string[] }>;
}
export interface DeviceProfileProvider {
  id: string;
  matches(target: string): boolean;
  resolve(target: string, options: { install?: boolean; signal?: AbortSignal }): Promise<HardwareProfile>;
  search?(query: string): Promise<HardwareCatalog>;
}
const profileProviders = new Map<string, DeviceProfileProvider>();
/** Providers own runtime/framework profiles; readers specialize Arduino variant metadata. */
export function registerDeviceProfileProvider(provider: DeviceProfileProvider): void {
  if (!/^[a-z][a-z0-9-]{1,50}$/.test(provider.id)) throw new Error('Invalid device profile provider identifier.');
  if (profileProviders.has(provider.id)) throw new Error(`Device profile provider ${provider.id} is already registered.`);
  profileProviders.set(provider.id, provider);
  profileCache.clear();
}
const profileReaders = new Map<string, DeviceProfileReader>();
export function registerDeviceProfileReader(reader: DeviceProfileReader): void {
  const architecture = reader.architecture.toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(architecture)) throw new Error('Invalid profile architecture.');
  if (profileReaders.has(architecture)) throw new Error(`A profile reader for ${architecture} is already registered.`);
  profileReaders.set(architecture, reader);
  profileCache.clear();
}

registerDeviceProfileReader({ architecture: 'avr', async read({ properties: props, signal }) {
  const variant = props['build.variant.path'];
  if (!variant) throw new Error('Platform does not identify build.variant.path.');
  const header = path.join(variant, 'pins_arduino.h');
  const compiler = path.join(props['compiler.path'], props['compiler.cpp.cmd']);
  const preprocessed = await execute(compiler, [`-mmcu=${props['build.mcu']}`, '-E', '-dD', '-x', 'c++', header], { timeoutMs: 15_000, signal });
  return {
    pins: pinsFromMetadata(preprocessed.stdout, 'avr'),
    metadataSources: [`${props['build.variant']}/pins_arduino.h (preprocessed by ${props['compiler.cpp.cmd']} for ${props['build.mcu']})`],
    constraints: ['Check the exact board voltage and current limits before wiring; the board package does not reliably describe electrical ratings.', 'UART RX/TX pins may be shared with the USB serial bridge. Do not drive a motor or other load directly from GPIO.'],
  };
} });
registerDeviceProfileReader({ architecture: 'samd', async read({ properties: props }) {
  const variant = props['build.variant.path'];
  if (!variant) throw new Error('Platform does not identify build.variant.path.');
  const [header, variantSource] = await Promise.all([readFile(path.join(variant, 'variant.h'), 'utf8'), readFile(path.join(variant, 'variant.cpp'), 'utf8')]);
  return {
    pins: pinsFromMetadata(header, 'samd', variantSource),
    metadataSources: [`${props['build.variant']}/variant.h`, `${props['build.variant']}/variant.cpp`],
    constraints: ['SAMD GPIO uses 3.3 V logic; do not apply 5 V to an input. Confirm the exact board current limits and header pinout.', 'PWM pin assignments come from the core variant table; shared timers may constrain simultaneous timer-dependent libraries.'],
  };
} });

export async function getDeviceProfile(fqbn: string, options: { install?: boolean; signal?: AbortSignal } = {}): Promise<HardwareProfile> {
  for (const provider of profileProviders.values()) if (provider.matches(fqbn)) {
    const profile = await provider.resolve(fqbn, options);
    if (profile.fqbn !== fqbn || !profile.adapter) throw new Error(`Device profile provider ${provider.id} returned a mismatched target or no build adapter.`);
    getBuildAdapter(profile.adapter);
    return structuredClone(profile);
  }
  assertFqbn(fqbn);
  const core = fqbn.split(':').slice(0, 2).join(':');
  if (options.install) {
    const installed = await installHardwarePackage(core, undefined, { signal: options.signal });
    if (profileCache.get(fqbn)?.profile.version !== installed.version) profileCache.delete(fqbn);
  }
  const cached = profileCache.get(fqbn);
  if (cached && Date.now() - cached.at < 60_000) return structuredClone(cached.profile);
  const details = await cliJson<BoardDetails>(['board', 'details', '--fqbn', fqbn], { signal: options.signal });
  const props = properties(details); const architecture = (details.platform?.architecture ?? fqbn.split(':')[1]).toLowerCase();
  const missingCapabilities = missingReader(architecture);
  const profile: HardwareProfile = {
    id: fqbn, fqbn, name: details.name, architecture, framework: 'Arduino C++', adapter: 'arduino-cli',
    toolchain: props['compiler.cpp.cmd'] ?? props['compiler.c.cmd'] ?? 'Arduino CLI platform recipes', core, version: details.version, installed: true,
    pins: [], interfaces: [], capabilities: ['compile'], constraints: [], supported: false, missingCapabilities,
    uploadSupported: Boolean(props['upload.tool'] || props['upload.tool.default']),
    options: (details.config_options ?? []).map((option) => ({ id: option.option, label: option.option_label, values: option.values.map((value) => ({ id: value.value, label: value.value_label, selected: Boolean(value.selected) })) })),
    flashBytes: Number(props['upload.maximum_size']) || undefined, ramBytes: Number(props['upload.maximum_data_size']) || undefined,
    ...(architecture === 'samd' ? { logicVoltage: 3.3 } : {}),
    metadataSources: [`arduino-cli board details --fqbn ${fqbn}`, `${core}@${details.version}`],
  };
  if (!missingCapabilities.length) {
    try {
      const metadata = await profileReaders.get(architecture)!.read({ properties: props, signal: options.signal });
      profile.pins = metadata.pins;
      profile.metadataSources.push(...metadata.metadataSources);
      profile.constraints.push(...metadata.constraints);
      profile.interfaces = [...new Set(profile.pins.flatMap((pin) => pin.interfaces.map((value) => value.split('.')[0])))];
      profile.interfaces.unshift('serial');
      profile.capabilities.push('digital-io', 'serial', ...(profile.pins.some((pin) => pin.pwm) ? ['pwm'] : []), ...(profile.pins.some((pin) => pin.analog) ? ['analog-input'] : []));
    } catch (error) { profile.missingCapabilities.push(error instanceof Error ? error.message : String(error)); }
  }
  profile.supported = profile.missingCapabilities.length === 0;
  profileCache.set(fqbn, { at: Date.now(), profile });
  return structuredClone(profile);
}

export async function installHardwareLibraries(libraries: HardwareLibrary[], options: CommandOptions = {}): Promise<HardwareLibrary[]> {
  if (libraries.length > 24) throw new Error('A hardware project may declare at most 24 libraries.');
  const resolved: HardwareLibrary[] = [];
  for (const library of libraries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,100}$/.test(library.name) || (library.version && !versionPattern.test(library.version))) throw new Error('Libraries must use Arduino Library Manager names and versions, not URLs or filesystem paths.');
    await serializedInstall(async () => {
      await cli(['lib', 'install', `${library.name}${library.version ? `@${library.version}` : ''}`], { timeoutMs: 180_000, ...options });
      const installed = await cliJson<{ installed_libraries?: { library: { name: string; version: string } }[] }>(['lib', 'list', library.name], options);
      const match = installed.installed_libraries?.find((entry) => entry.library.name.toLowerCase() === library.name.toLowerCase());
      if (!match) throw new Error(`Library Manager did not confirm ${library.name} after installation.`);
      resolved.push({ name: match.library.name, version: match.library.version });
      const graph = await cliJson<{ dependencies?: { name: string; version_installed?: string }[] }>(['lib', 'deps', `${match.library.name}@${match.library.version}`, '--no-overwrite'], options);
      for (const dependency of graph.dependencies ?? []) {
        if (!dependency.version_installed) throw new Error(`Required library dependency ${dependency.name} was not installed.`);
        resolved.push({ name: dependency.name, version: dependency.version_installed });
      }
    });
  }
  return [...new Map(resolved.map(library => [library.name.toLowerCase(), library])).values()];
}

export interface HardwareBuildRequest {
  adapter?: string;
  fqbn: string;
  sketchDirectory: string;
  outputDirectory: string;
  libraries?: HardwareLibrary[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HardwareUploadRequest {
  adapter?: string;
  fqbn: string;
  port: string;
  inputDirectory: string;
  /** Only the explicit upload endpoint, after device selection, may supply this. */
  explicitRequest: true;
  signal?: AbortSignal;
}

export interface BuildAdapter {
  id: string;
  framework: string;
  build(request: HardwareBuildRequest): Promise<HardwareBuildResult>;
  upload?(request: HardwareUploadRequest): Promise<string>;
}

const adapters = new Map<string, BuildAdapter>();
export function registerBuildAdapter(adapter: BuildAdapter): void {
  if (!/^[a-z][a-z0-9-]{1,50}$/.test(adapter.id)) throw new Error('Invalid adapter identifier.');
  if (adapters.has(adapter.id)) throw new Error(`Build adapter ${adapter.id} is already registered.`);
  adapters.set(adapter.id, adapter);
}
export function getBuildAdapter(id: string): BuildAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`No build adapter is registered for ${id}; compilation and export are unsupported for this runtime.`);
  return adapter;
}

async function arduinoBuild(request: HardwareBuildRequest): Promise<HardwareBuildResult> {
  assertFqbn(request.fqbn);
  const profile = await getDeviceProfile(request.fqbn, { install: true, signal: request.signal });
  if (!profile.supported) throw new Error(profile.missingCapabilities.join('\n'));
  const sketchDirectory = path.resolve(request.sketchDirectory); const outputDirectory = path.resolve(request.outputDirectory);
  if (sketchDirectory === outputDirectory || sketchDirectory.startsWith(outputDirectory + path.sep)) throw new Error('Build output must be separate from the source directory.');
  if (!(await stat(sketchDirectory)).isDirectory()) throw new Error('Arduino sketch directory is missing.');
  const dependencies = await installHardwareLibraries(request.libraries ?? [], { signal: request.signal });
  const marker = path.join(outputDirectory, '.airlock-build-output');
  try {
    const entries = await readdir(outputDirectory);
    if (entries.length && !entries.includes('.airlock-build-output')) throw new Error('Build output directory contains unrelated files; choose a dedicated empty output directory.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Never return an artifact left over from a previous successful build.
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(marker, 'Generated hardware build output. Safe to replace.\n');
  const args = ['compile', '--fqbn', request.fqbn, '--warnings', 'all', '--jobs', '2', '--output-dir', outputDirectory, '--build-path', path.join(outputDirectory, '.build'), sketchDirectory];
  try {
    const result = await cli(args, { signal: request.signal, timeoutMs: request.timeoutMs ?? 120_000 });
    const artifacts = [];
    for (const name of (await readdir(outputDirectory)).filter((entry) => /\.(?:hex|bin|uf2|elf|eep|map)$/i.test(entry))) {
      const filename = path.join(outputDirectory, name); const content = await readFile(filename);
      if (!content.byteLength) continue;
      artifacts.push({ name, path: filename, bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') });
    }
    if (!artifacts.some((artifact) => /\.(?:hex|bin|uf2)$/i.test(artifact.name))) throw new Error(`The ${profile.toolchain} build completed without an uploadable firmware artifact.`);
    return { profile, log: `${result.stdout}\n${result.stderr}`.trim(), artifacts, dependencies, command: ['arduino-cli', ...args], compiledAt: new Date().toISOString(), physicallyTested: false };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function arduinoUpload(request: HardwareUploadRequest): Promise<string> {
  assertFqbn(request.fqbn);
  if (request.explicitRequest !== true) throw new Error('Upload requires an explicit user request after selecting the connected device.');
  if (!request.port || request.port.length > 200 || /[\r\n\0]/.test(request.port)) throw new Error('Select a connected device port before uploading.');
  const profile = await getDeviceProfile(request.fqbn);
  if (!profile.uploadSupported) throw new Error('This board package does not provide an upload recipe.');
  const connected = (await connectedHardware()).find((device) => device.port === request.port);
  if (!connected) throw new Error('The selected device is no longer connected. Select it again before requesting upload.');
  if (connected.boards.length && !connected.boards.some((board) => board.fqbn.split(':').slice(0, 3).join(':') === request.fqbn.split(':').slice(0, 3).join(':'))) throw new Error('The selected port identifies a different board. Select the matching device before uploading.');
  const result = await cli(['upload', '--fqbn', request.fqbn, '--port', request.port, '--input-dir', path.resolve(request.inputDirectory)], { timeoutMs: 120_000, signal: request.signal });
  return `${result.stdout}\n${result.stderr}`.trim();
}

// Arduino Library Manager installs into one user library directory. Serialize
// builds through dependency resolution and compilation so projects requesting
// different versions cannot silently compile against each other's libraries.
let arduinoBuildQueue: Promise<unknown> = Promise.resolve();
registerBuildAdapter({ id: 'arduino-cli', framework: 'Arduino C++', build(request) {
  const operation = arduinoBuildQueue.then(() => arduinoBuild(request), () => arduinoBuild(request));
  arduinoBuildQueue = operation.catch(() => undefined);
  return operation;
}, upload: arduinoUpload });

export async function buildHardwareProject(request: HardwareBuildRequest): Promise<HardwareBuildResult> {
  return getBuildAdapter(request.adapter ?? 'arduino-cli').build(request);
}
export async function uploadHardwareProject(request: HardwareUploadRequest): Promise<string> {
  if (request.explicitRequest !== true) throw new Error('Upload requires an explicit user request after selecting the connected device.');
  const adapter = getBuildAdapter(request.adapter ?? 'arduino-cli');
  if (!adapter.upload) throw new Error(`Build adapter ${adapter.id} does not support upload. Use the generated run instructions for this runtime.`);
  return adapter.upload(request);
}
