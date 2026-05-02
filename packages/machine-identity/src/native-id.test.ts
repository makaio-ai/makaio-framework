import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { getNativeHardwareMachineId } from './native-id.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

describe('getNativeHardwareMachineId', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.unstubAllEnvs();
  });

  it('uses execFileSync with the hardened macOS ioreg path and normalizes the UUID', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.mocked(execFileSync).mockReturnValue('"IOPlatformUUID" = "ABCDEF12-3456-7890-ABCD-EF1234567890"\n');

    expect(getNativeHardwareMachineId()).toBe('abcdef12-3456-7890-abcd-ef1234567890');
    expect(execFileSync).toHaveBeenCalledWith(
      '/usr/sbin/ioreg',
      ['-rd1', '-c', 'IOPlatformExpertDevice'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 5_000 }),
    );
  });

  it('normalizes Linux machine-id values and rejects malformed contents', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.mocked(fs.readFileSync).mockReturnValueOnce('ABCDEF1234567890ABCDEF1234567890\n');

    expect(getNativeHardwareMachineId()).toBe('abcdef1234567890abcdef1234567890');
    expect(fs.readFileSync).toHaveBeenCalledWith('/etc/machine-id', 'utf-8');

    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readFileSync).mockReturnValueOnce('not-a-machine-id');
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error('missing');
    });

    expect(getNativeHardwareMachineId()).toBeUndefined();
    expect(fs.readFileSync).toHaveBeenNthCalledWith(1, '/etc/machine-id', 'utf-8');
    expect(fs.readFileSync).toHaveBeenNthCalledWith(2, '/var/lib/dbus/machine-id', 'utf-8');
  });

  it('uses execFileSync with the hardened Windows reg.exe path and normalizes braces', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.mocked(execFileSync).mockReturnValue('MachineGuid    REG_SZ    {ABCDEF12-3456-7890-ABCD-EF1234567890}\r\n');

    expect(getNativeHardwareMachineId()).toBe('abcdef12-3456-7890-abcd-ef1234567890');
    expect(execFileSync).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 5_000 }),
    );
  });
});
