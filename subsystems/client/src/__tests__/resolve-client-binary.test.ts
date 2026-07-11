import { createBusInstance } from '@makaio/bus-core';
import { ClientNamespace, ClientSubjects } from '@makaio/contracts/client';
import { describe, expect, it } from 'vitest';
import { resolveClientBinary } from '../resolve-client-binary.js';

describe('resolveClientBinary', () => {
  it('resolves against the injected runtime bus', async () => {
    const runtimeBus = createBusInstance();
    runtimeBus.registerNamespaces([ClientNamespace]);
    const cleanup = runtimeBus.on(ClientSubjects.resolveBinary, (context) => {
      expect(context.payload.clientId).toBe('test-client');
      context.setResult({
        binaryPath: '/runtime/bin/client',
        env: { PATH: '/runtime/bin' },
        configDir: null,
        source: 'managed',
        version: '1.0.0',
      });
    });

    try {
      await expect(resolveClientBinary(runtimeBus, 'test-client')).resolves.toEqual({
        binaryPath: '/runtime/bin/client',
        env: { PATH: '/runtime/bin' },
        configDir: null,
        source: 'managed',
        version: '1.0.0',
      });
    } finally {
      cleanup();
    }
  });

  it('returns undefined when the injected runtime has no resolver', async () => {
    const frameworkOnlyBus = createBusInstance();
    frameworkOnlyBus.registerNamespaces([ClientNamespace]);

    await expect(resolveClientBinary(frameworkOnlyBus, 'test-client')).resolves.toBeUndefined();
  });
});
