/**
 * Tests for the host-provided credential resolver on NodeExtensionContext.
 *
 * Covers:
 * - Extensions booted through the ExtensionCoordinator receive a `credentials`
 *   field on their context when one is supplied in `extensionContextBase`.
 * - `ctx.credentials.resolve` can resolve `env:` refs from the process environment.
 * - `NodeCredentialProvider.resolve` returns null (never throws) for `stored:` refs.
 * - `NodeCredentialProvider.resolve` returns null (never throws) for missing `file:` refs.
 * - `StoredCredentialProvider.resolve` returns null (never throws) for `stored:`
 *   refs when no credential-service handler is registered on the bus.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, createChannelEndpoint } from '@makaio/bus-core';
import { CredentialSubjects, FrameworkContractNamespaces } from '@makaio/contracts';
import { buildStoredCredentialRef, CredentialRefSchema } from '@makaio/contracts/config';
import { ExtensionCoordinator, type KernelMakaioExtension } from '@makaio/kernel';
import type { NodeExtensionContext } from '@makaio/contracts/extension';
import { NodeCredentialProvider, StoredCredentialProvider } from '../credential-provider.js';

const TEST_MAKAIO_HOME = '/home/test/.makaio';

// ---------------------------------------------------------------------------
// Extension context field: credentials
// ---------------------------------------------------------------------------

describe('NodeExtensionContext.credentials', () => {
  const ENV_VAR = 'MAKAIO_TEST_CRED_RESOLVER_SECRET';

  beforeEach(() => {
    process.env[ENV_VAR] = 'test-secret-value';
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it('is present on the extension context when supplied in extensionContextBase', async () => {
    const bus = createBusInstance();
    const credentials = new NodeCredentialProvider();

    let capturedCredentials: NodeExtensionContext['credentials'];

    const testExtension: KernelMakaioExtension = {
      name: 'test-credentials-extension',
      displayName: 'Test Credentials Extension',
      version: '0.0.1',
      create: (ctx) => {
        capturedCredentials = (ctx as NodeExtensionContext).credentials;
        return {
          init: async () => {},
          destroy: async () => {},
        };
      },
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: {
        platform: process.platform,
        homedir: '/home/test',
        makaioHome: TEST_MAKAIO_HOME,
        username: 'test',
        machineId: 'machine-1',
        tryImport: async () => null,
        credentials,
      },
    });

    coordinator.load([testExtension]);

    try {
      await coordinator.startAll();
      expect(capturedCredentials).toBeDefined();
    } finally {
      await coordinator.shutdown();
    }
  });

  it('resolves an env: credential ref set in the process environment', async () => {
    const bus = createBusInstance();
    const credentials = new NodeCredentialProvider();

    let resolvedValue: string | null | undefined;

    const ref = CredentialRefSchema.parse(`env:${ENV_VAR}`);

    const testExtension: KernelMakaioExtension = {
      name: 'test-credentials-env-extension',
      displayName: 'Test Credentials Env Extension',
      version: '0.0.1',
      create: (ctx) => {
        const nodeCtx = ctx as NodeExtensionContext;
        return {
          init: async () => {
            if (nodeCtx.credentials) {
              resolvedValue = await nodeCtx.credentials.resolve(ref);
            }
          },
          destroy: async () => {},
        };
      },
    };

    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: {
        platform: process.platform,
        homedir: '/home/test',
        makaioHome: TEST_MAKAIO_HOME,
        username: 'test',
        machineId: 'machine-1',
        tryImport: async () => null,
        credentials,
      },
    });

    coordinator.load([testExtension]);

    try {
      await coordinator.startAll();
      expect(resolvedValue).toBe('test-secret-value');
    } finally {
      await coordinator.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// NodeCredentialProvider: null contract for stored: and missing file: refs
// ---------------------------------------------------------------------------

describe('NodeCredentialProvider.resolve', () => {
  it('returns null without throwing for a stored: ref', async () => {
    const provider = new NodeCredentialProvider();
    const ref = buildStoredCredentialRef('provider-config-123', 'apiKey');

    // stored: refs require a bus-backed credential service; NodeCredentialProvider
    // must never try to forward them to resolveCredentialRef (which would return
    // the ref string itself as a raw token, violating the null contract).
    const result = await provider.resolve(ref);
    expect(result).toBeNull();
  });

  it('returns null without throwing for a file: ref pointing to a missing file', async () => {
    const provider = new NodeCredentialProvider();
    // Use a path that is guaranteed not to exist on any host.
    const missingPath = path.join(os.tmpdir(), `makaio-test-missing-cred-${Date.now()}.txt`);
    const ref = CredentialRefSchema.parse(`file:${missingPath}`);

    const result = await provider.resolve(ref);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// StoredCredentialProvider: graceful null for stored: refs without a handler
// ---------------------------------------------------------------------------

describe('StoredCredentialProvider.resolve', () => {
  it('returns null without throwing when no credential-service handler is registered', async () => {
    const bus = createBusInstance();
    bus.registerNamespaces(FrameworkContractNamespaces);

    const provider = new StoredCredentialProvider(bus);
    const ref = buildStoredCredentialRef('provider-config-123', 'apiKey');

    // Must not throw even though CredentialSubjects.getChannelToken has no handler.
    const result = await provider.resolve(ref);
    expect(result).toBeNull();
  });

  it('resolves env: refs via the NodeCredentialProvider fallback', async () => {
    const ENV_VAR = 'MAKAIO_TEST_STORED_FALLBACK_SECRET';
    process.env[ENV_VAR] = 'fallback-secret';

    try {
      const bus = createBusInstance();
      bus.registerNamespaces(FrameworkContractNamespaces);

      const provider = new StoredCredentialProvider(bus);
      const ref = CredentialRefSchema.parse(`env:${ENV_VAR}`);
      const result = await provider.resolve(ref);
      expect(result).toBe('fallback-secret');
    } finally {
      delete process.env[ENV_VAR];
    }
  });

  it('re-checks the bus on each call when no handler is registered, then resolves after handler registers', async () => {
    // Verifies that getChannel() does NOT permanently cache a null result.
    // A service registering after the first call must be visible to subsequent calls.
    const PROVIDER_CONFIG_ID = 'provider-config-late-handler';
    const CREDENTIAL_KEY = 'apiKey';
    const CREDENTIAL_VALUE = 'resolved-after-registration';
    const TEST_CHANNEL_TOKEN = 'late-handler-test-token';

    const bus = createBusInstance();
    bus.registerNamespaces(FrameworkContractNamespaces);

    const provider = new StoredCredentialProvider(bus);
    const ref = buildStoredCredentialRef(PROVIDER_CONFIG_ID, CREDENTIAL_KEY);

    // First call: no getChannelToken handler is registered — must return null
    // without throwing.
    const firstResult = await provider.resolve(ref);
    expect(firstResult).toBeNull();

    // Now register a real credential channel endpoint — bus handler for
    // getChannelToken plus a channel endpoint serving CredentialSubjects.get.
    const cleanups: Array<() => void> = [];
    try {
      cleanups.push(
        bus.on(CredentialSubjects.getChannelToken, (ctx) => {
          ctx.setResult({ token: TEST_CHANNEL_TOKEN });
        }),
      );

      const endpoint = createChannelEndpoint(
        bus.getContext(),
        'credentials',
        (channel) => {
          channel.on(CredentialSubjects.get, (ctx) => {
            ctx.setResult({
              credentials: { [CREDENTIAL_KEY]: CREDENTIAL_VALUE },
            });
          });
        },
        { token: TEST_CHANNEL_TOKEN },
      );
      cleanups.push(() => endpoint.close());

      // Second call: handler is now registered — must return the credential value.
      const secondResult = await provider.resolve(ref);
      expect(secondResult).toBe(CREDENTIAL_VALUE);
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
  });
});
