import { describe, expect, it } from 'vitest';
import { buildHardwareProject, connectedHardware, getBuildAdapter, getDeviceProfile, metadataInteger, registerBuildAdapter, registerDeviceProfileProvider, searchHardware, uploadHardwareProject } from '../server/hardware-adapters';

describe('real Arduino catalog and device profiles', () => {
  it('searches installed boards and uninstalled official package metadata without invented FQBNs', async () => {
    const uno = await searchHardware('arduino:avr:uno');
    expect(uno.boards).toContainEqual(expect.objectContaining({ fqbn: 'arduino:avr:uno', architecture: 'avr', installed: true }));
    const due = await searchHardware('Arduino Due');
    expect(due.boards.some(board => board.core === 'arduino:sam')).toBe(true);
    expect(due.boards.find(board => board.core === 'arduino:sam')?.missingCapabilities.join(' ')).toMatch(/pin-capability reader/);
    expect(due.packages.some(core => core.id === 'arduino:sam')).toBe(true);
  });

  it('reads AVR PWM, analog, bus pins, memory, and Nano processor options from the installed toolchain', async () => {
    const uno = await getDeviceProfile('arduino:avr:uno');
    expect(uno.supported, uno.missingCapabilities.join(' ')).toBe(true);
    expect(uno.pins.filter(pin => pin.pwm).map(pin => pin.number)).toEqual([3, 5, 6, 9, 10, 11]);
    expect(uno.pins.find(pin => pin.id === 'A4')).toMatchObject({ number: 18, analog: true, digital: true, interfaces: ['i2c.sda'] });
    expect(uno.flashBytes).toBe(32256);
    expect(uno.toolchain).toBe('avr-g++');
    expect(uno.metadataSources.join(' ')).toMatch(/preprocessed/);
    const nano = await getDeviceProfile('arduino:avr:nano');
    expect(nano.options.find(option => option.id === 'cpu')?.values.some(value => value.id === 'atmega328old')).toBe(true);
    expect(nano.pins.find(pin => pin.id === 'A6')).toMatchObject({ analog: true, digital: false });
  });

  it('reads SAMD capabilities from its variant table without treating analog header pins as analog-only', async () => {
    const mkr = await getDeviceProfile('arduino:samd:mkrzero');
    expect(mkr.supported, mkr.missingCapabilities.join(' ')).toBe(true);
    expect(mkr.toolchain).toBe('arm-none-eabi-g++');
    expect(mkr.logicVoltage).toBe(3.3);
    expect(mkr.pins.find(pin => pin.id === 'A3')).toMatchObject({ number: 18, analog: true, digital: true, pwm: true });
    expect(mkr.pins.find(pin => pin.id === '9')?.pwm).toBe(false);
    expect(mkr.pins.find(pin => pin.id === '13')?.interfaces).toContain('uart1.rx');
  });

  it('discovers actual ports but never calls an unidentified serial port a tested board', async () => {
    for (const device of await connectedHardware()) {
      expect(device.port).toBeTruthy();
      expect(device.identified).toBe(device.boards.length > 0);
    }
  });

  it('rejects malformed targets and upload without explicit intent before touching a port', async () => {
    await expect(getDeviceProfile('--fqbn arduino:avr:uno')).rejects.toThrow(/exact board FQBN/);
    await expect(uploadHardwareProject({ fqbn: 'arduino:avr:uno', port: 'irrelevant', inputDirectory: '.', explicitRequest: false as never })).rejects.toThrow(/explicit user request/);
    expect(() => getBuildAdapter('unsupported-runtime')).toThrow(/No build adapter/);
  });

  it('dispatches registered profile providers, catalog search, builds, and explicit upload to their adapters', async () => {
    const target = 'test:native:controller';
    const base = await getDeviceProfile('arduino:avr:uno');
    const profile = { ...base, id: target, fqbn: target, name: 'Test-only native profile', architecture: 'native-test', adapter: 'test-native' };
    registerBuildAdapter({ id: 'test-native', framework: 'Test only', build: async () => { throw new Error('Custom compiler selected'); }, upload: async () => { throw new Error('Custom upload selected; no device touched'); } });
    registerDeviceProfileProvider({ id: 'test-native', matches: candidate => candidate === target, resolve: async () => profile, search: async query => ({ boards: query === 'test-native' ? [{ id: target, fqbn: target, name: profile.name, architecture: profile.architecture, core: 'test:native', version: '1', installed: true, supported: true, missingCapabilities: [] }] : [], packages: [], warnings: [] }) });
    expect((await getDeviceProfile(target)).adapter).toBe('test-native');
    expect((await searchHardware('test-native')).boards[0].fqbn).toBe(target);
    await expect(buildHardwareProject({ adapter: 'test-native', fqbn: target, sketchDirectory: '.', outputDirectory: '.unused-test-output' })).rejects.toThrow('Custom compiler selected');
    await expect(uploadHardwareProject({ adapter: 'test-native', fqbn: target, port: 'unit-test-only', inputDirectory: '.', explicitRequest: true })).rejects.toThrow('Custom upload selected');
    await expect(uploadHardwareProject({ adapter: 'test-native', fqbn: target, port: 'unit-test-only', inputDirectory: '.', explicitRequest: false as never })).rejects.toThrow(/explicit user request/);
  });
});

describe('bounded metadata expressions', () => {
  it('supports arithmetic, ternaries, suffixes, and constant aliases without evaluating code', () => {
    expect(metadataInteger('((3) == 3 || (3) == 5)')).toBe(1);
    expect(metadataInteger('(A0 + 2u)', { A0: '14' })).toBe(16);
    expect(metadataInteger('0 ? 2 : (3 < 4 ? 5 : 6)')).toBe(5);
    expect(metadataInteger('process.exit()')).toBeUndefined();
    expect(metadataInteger('1 / 0')).toBeUndefined();
    expect(metadataInteger('LOOP', { LOOP: 'LOOP' })).toBeUndefined();
  });
});
