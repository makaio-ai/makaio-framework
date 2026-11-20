import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import type { LaunchResult, LaunchStatus } from '@makaio/subprocess';
import { recordingLaunch } from '@makaio/subprocess/testing';
import { getNativeHardwareMachineId } from './native-id.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

/**
 * Build a completed result carrying captured stdout.
 * @param stdout - Captured standard output
 * @returns Completed launch result
 */
function completedWith(stdout: string): LaunchResult {
  return { status: 'completed', output: { stdout, stderr: '' } };
}

const MAC_UUID_OUTPUT = '"IOPlatformUUID" = "ABCDEF12-3456-7890-ABCD-EF1234567890"\n';
const WINDOWS_GUID_OUTPUT = 'MachineGuid    REG_SZ    {ABCDEF12-3456-7890-ABCD-EF1234567890}\r\n';

const EXPECTED_BOUNDS = {
  envMode: 'merge',
  timeoutMs: 5_000,
  output: { kind: 'capture', limitBytes: 64 * 1024 },
} as const;

describe('getNativeHardwareMachineId', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.unstubAllEnvs();
  });

  it('starts the hardened macOS ioreg path with its bounds and normalizes the UUID', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { launch, calls } = recordingLaunch(completedWith(MAC_UUID_OUTPUT));

    await expect(getNativeHardwareMachineId(launch)).resolves.toBe('abcdef12-3456-7890-abcd-ef1234567890');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: '/usr/sbin/ioreg',
      args: ['-rd1', '-c', 'IOPlatformExpertDevice'],
      cwd: process.cwd(),
      ...EXPECTED_BOUNDS,
    });
  });

  it('starts the hardened Windows reg.exe path with its bounds and normalizes braces', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const { launch, calls } = recordingLaunch(completedWith(WINDOWS_GUID_OUTPUT));

    await expect(getNativeHardwareMachineId(launch)).resolves.toBe('abcdef12-3456-7890-abcd-ef1234567890');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: 'C:\\Windows\\System32\\reg.exe',
      args: ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      cwd: process.cwd(),
      ...EXPECTED_BOUNDS,
    });
  });

  it('normalizes Linux machine-id values and rejects malformed contents without starting a process', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { launch, calls } = recordingLaunch(completedWith(''));
    vi.mocked(fs.readFileSync).mockReturnValueOnce('ABCDEF1234567890ABCDEF1234567890\n');

    await expect(getNativeHardwareMachineId(launch)).resolves.toBe('abcdef1234567890abcdef1234567890');
    expect(fs.readFileSync).toHaveBeenCalledWith('/etc/machine-id', 'utf-8');

    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readFileSync).mockReturnValueOnce('not-a-machine-id');
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error('missing');
    });

    await expect(getNativeHardwareMachineId(launch)).resolves.toBeUndefined();
    expect(fs.readFileSync).toHaveBeenNthCalledWith(1, '/etc/machine-id', 'utf-8');
    expect(fs.readFileSync).toHaveBeenNthCalledWith(2, '/var/lib/dbus/machine-id', 'utf-8');
    expect(calls).toHaveLength(0);
  });

  it.each<LaunchStatus>([
    'failed',
    'cancelled',
    'timed-out',
    'output-limit',
    'spawn-failed',
    'stop-failed',
  ])('ignores captured output of a command that ended with status %s', async (status) => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { launch, calls } = recordingLaunch({ status, output: { stdout: MAC_UUID_OUTPUT, stderr: '' } });

    await expect(getNativeHardwareMachineId(launch)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('returns undefined when a completed command printed no recognizable identifier', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { launch } = recordingLaunch(completedWith('unrelated output'));

    await expect(getNativeHardwareMachineId(launch)).resolves.toBeUndefined();
  });
});
