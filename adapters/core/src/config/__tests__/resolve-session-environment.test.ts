import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { resolveClientBinary } from '@makaio/subsystem-client';
import { createTestCall } from '@makaio/test-utils';
import { resolveSessionEnvironment } from '../resolve-session-environment.js';

vi.mock('@makaio/subsystem-client', () => ({
  resolveClientBinary: vi.fn(),
}));

const resolveClientBinaryMock = vi.mocked(resolveClientBinary);

describe('resolveSessionEnvironment', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('scrubs auth variables after every non-auth environment source is merged', async () => {
    const call = createTestCall();
    const globalBus = createBusInstance();
    resolveClientBinaryMock.mockResolvedValue({
      binaryPath: '/managed/bin/client',
      env: {
        BINARY_AUTH: 'binary-secret',
        SHARED_AUTH: 'binary-shared',
        PATH: '/managed/bin',
      },
      configDir: null,
      source: 'managed',
      version: '1.0.0',
    });

    const result = await resolveSessionEnvironment(call, {
      globalBus,
      clientId: 'test-client',
      baseEnv: {
        BASE_AUTH: 'base-secret',
        SHARED_AUTH: 'base-shared',
        CONFIG_HOME: '/canonical/credential-home',
        PATH: '/base/bin',
      },
      sessionEnv: {
        SESSION_AUTH: 'session-secret',
        SHARED_AUTH: 'session-shared',
      },
      leaseEnv: {
        LEASE_AUTH: 'lease-secret',
        SHARED_AUTH: 'lease-shared',
        CONFIG_HOME: '/isolated/config',
      },
      scrubEnvVars: ['BASE_AUTH', 'SESSION_AUTH', 'BINARY_AUTH', 'LEASE_AUTH', 'SHARED_AUTH'],
      selectedAuthEnv: { SELECTED_AUTH: 'selected-secret' },
    });

    expect(result.connectorEnv).toEqual({
      PATH: '/managed/bin',
      CONFIG_HOME: '/isolated/config',
      SELECTED_AUTH: 'selected-secret',
    });
    expect(result.contextEnv).toEqual({ PATH: '/managed/bin' });
    expect(Object.isFrozen(result.connectorEnv)).toBe(true);
    expect(Object.isFrozen(result.contextEnv)).toBe(true);
    expect(resolveClientBinaryMock).toHaveBeenCalledWith(call, globalBus, 'test-client');
  });

  it('applies selected auth after scrub even when a lease supplied the same target', async () => {
    resolveClientBinaryMock.mockResolvedValue(undefined);

    const result = await resolveSessionEnvironment(createTestCall(), {
      baseEnv: { CODEX_ACCESS_TOKEN: 'ambient-token' },
      leaseEnv: { CODEX_ACCESS_TOKEN: 'lease-token', CODEX_HOME: '/isolated/codex' },
      scrubEnvVars: ['CODEX_ACCESS_TOKEN'],
      selectedAuthEnv: { CODEX_ACCESS_TOKEN: 'selected-token' },
    });

    expect(result.connectorEnv).toEqual({
      CODEX_HOME: '/isolated/codex',
      CODEX_ACCESS_TOKEN: 'selected-token',
    });
    expect(result.contextEnv).toEqual({});
  });

  it('does not read process.env or resolve a binary when no client is selected', async () => {
    const previous = process.env['AMBIENT_AUTH'];
    process.env['AMBIENT_AUTH'] = 'ambient-secret';
    try {
      const result = await resolveSessionEnvironment(createTestCall(), {
        baseEnv: { PATH: '/explicit/bin', NODE_OPTIONS: '--inspect' },
        scrubEnvVars: ['AMBIENT_AUTH'],
      });

      expect(result.connectorEnv).toEqual({ PATH: '/explicit/bin' });
      expect(result.contextEnv).toEqual({ PATH: '/explicit/bin' });
      expect(resolveClientBinaryMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env['AMBIENT_AUTH'];
      } else {
        process.env['AMBIENT_AUTH'] = previous;
      }
    }
  });

  it('rejects client resolution without the runtime-owned bus', async () => {
    await expect(resolveSessionEnvironment(createTestCall(), { clientId: 'test-client' })).rejects.toThrow(
      'Client binary resolution requires the adapter runtime global bus',
    );
    expect(resolveClientBinaryMock).not.toHaveBeenCalled();
  });
});
