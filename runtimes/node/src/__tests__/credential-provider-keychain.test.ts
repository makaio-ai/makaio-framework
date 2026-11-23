/**
 * Tests for the keychain lookup of `NodeCredentialProvider`.
 *
 * The lookup starts the host command `security`, which a Linux CI cannot run. The tests pass their own
 * implementation of the start port (`LaunchFunction`): it records the options it received and returns a settled
 * result. The provider itself is the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialRef } from '@makaio/contracts/config';
import type { LaunchStatus } from '@makaio/subprocess';
import { recordingLaunch } from '@makaio/subprocess/testing';
import { createTestCall } from '@makaio/test-utils';
import { NodeCredentialProvider } from '../credential-provider.js';

const SECRET = 'hunter2-secret-value';
const REF = 'keychain:makaio-service:work:account' as CredentialRef;

describe('NodeCredentialProvider keychain lookup', () => {
  const consoleSpies = [
    vi.spyOn(console, 'log'),
    vi.spyOn(console, 'info'),
    vi.spyOn(console, 'warn'),
    vi.spyOn(console, 'error'),
    vi.spyOn(console, 'debug'),
  ];

  beforeEach(() => {
    for (const spy of consoleSpies) spy.mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockClear();
  });

  /** Everything the console received, serialised, for secret scans. */
  function loggedText(): string {
    return JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls));
  }

  it('returns the trimmed stdout when the command completed', async () => {
    const { launch } = recordingLaunch({
      status: 'completed',
      output: { stdout: `  ${SECRET}\n`, stderr: '' },
    });

    await expect(new NodeCredentialProvider({ launch }).resolve(createTestCall(), REF)).resolves.toBe(SECRET);
  });

  it('returns null when the command completed with empty output', async () => {
    const { launch } = recordingLaunch({ status: 'completed', output: { stdout: '\n', stderr: '' } });

    await expect(new NodeCredentialProvider({ launch }).resolve(createTestCall(), REF)).resolves.toBeNull();
  });

  it('hands the port the exact command, arguments and bounds', async () => {
    const { launch, calls } = recordingLaunch({ status: 'completed', output: { stdout: SECRET, stderr: '' } });

    await new NodeCredentialProvider({ launch }).resolve(createTestCall(), REF);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: 'security',
      cwd: process.cwd(),
      args: ['find-generic-password', '-s', 'makaio-service', '-a', 'work:account', '-w'],
      envMode: 'merge',
      timeoutMs: 10_000,
      output: { kind: 'capture', limitBytes: 64 * 1024 },
    });
  });

  const nonCompleted: readonly LaunchStatus[] = [
    'failed',
    'cancelled',
    'timed-out',
    'output-limit',
    'spawn-failed',
    'stop-failed',
  ];

  it.each(nonCompleted)('returns null for status %s even when the port carries output', async (status) => {
    const { launch } = recordingLaunch({ status, output: { stdout: SECRET, stderr: SECRET } });

    await expect(new NodeCredentialProvider({ launch }).resolve(createTestCall(), REF)).resolves.toBeNull();
  });

  it('never logs the secret, whether the lookup succeeds or not', async () => {
    const found = recordingLaunch({ status: 'completed', output: { stdout: SECRET, stderr: SECRET } });
    const failed = recordingLaunch({ status: 'failed', output: { stdout: SECRET, stderr: SECRET } });

    await new NodeCredentialProvider({ launch: found.launch }).resolve(createTestCall(), REF);
    await new NodeCredentialProvider({ launch: failed.launch }).resolve(createTestCall(), REF);

    expect(loggedText()).not.toContain(SECRET);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
