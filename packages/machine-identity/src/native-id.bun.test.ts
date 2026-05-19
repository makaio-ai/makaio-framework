/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { stubEnv, unstubAllEnvs } from '@makaio/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const execFileSyncMock = mock<(...args: unknown[]) => string>();
const readFileSyncMock = mock<(...args: unknown[]) => string>();

mock.module('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

mock.module('node:fs', () => ({
  readFileSync: readFileSyncMock,
}));

import { getNativeHardwareMachineId } from './native-id.js';

describe('getNativeHardwareMachineId', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    readFileSyncMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    unstubAllEnvs();
  });

  it('uses execFileSync with the hardened macOS ioreg path and normalizes the UUID', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    execFileSyncMock.mockReturnValue('"IOPlatformUUID" = "ABCDEF12-3456-7890-ABCD-EF1234567890"\n');

    expect(getNativeHardwareMachineId()).toBe('abcdef12-3456-7890-abcd-ef1234567890');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      '/usr/sbin/ioreg',
      ['-rd1', '-c', 'IOPlatformExpertDevice'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 5_000 }),
    );
  });

  it('normalizes Linux machine-id values and rejects malformed contents', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    readFileSyncMock.mockReturnValueOnce('ABCDEF1234567890ABCDEF1234567890\n');

    expect(getNativeHardwareMachineId()).toBe('abcdef1234567890abcdef1234567890');
    expect(readFileSyncMock).toHaveBeenCalledWith('/etc/machine-id', 'utf-8');

    readFileSyncMock.mockReset();
    readFileSyncMock.mockReturnValueOnce('not-a-machine-id');
    readFileSyncMock.mockImplementationOnce(() => {
      throw new Error('missing');
    });

    expect(getNativeHardwareMachineId()).toBeUndefined();
    expect(readFileSyncMock).toHaveBeenNthCalledWith(1, '/etc/machine-id', 'utf-8');
    expect(readFileSyncMock).toHaveBeenNthCalledWith(2, '/var/lib/dbus/machine-id', 'utf-8');
  });

  it('uses execFileSync with the hardened Windows reg.exe path and normalizes braces', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    stubEnv('SystemRoot', 'C:\\Windows');
    execFileSyncMock.mockReturnValue('MachineGuid    REG_SZ    {ABCDEF12-3456-7890-ABCD-EF1234567890}\r\n');

    expect(getNativeHardwareMachineId()).toBe('abcdef12-3456-7890-abcd-ef1234567890');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 5_000 }),
    );
  });
});
