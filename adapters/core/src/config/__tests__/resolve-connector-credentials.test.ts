import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus, createChannelEndpoint } from '@makaio/bus-core';
import type { ChannelEndpoint } from '@makaio/bus-core';
import { CredentialSubjects } from '@makaio/contracts';
import { CredentialRefSchema } from '@makaio/contracts/config';
import type { CredentialRef } from '@makaio/contracts/config';
import { resolveConnectorCredentials } from '../resolve-connector-credentials.js';

/** Token that grants access to the credential channel in tests. */
const TEST_CHANNEL_TOKEN = 'resolve-connector-credentials-test-token';

/**
 * In-memory store used by the test channel endpoint to serve resolve requests.
 * Maps ref string → resolved plaintext value (or null = not found).
 */
let resolveStore: Map<string, string | null>;

/**
 * Cleanup callbacks collected during each test setup, flushed in afterEach.
 * Each entry is either an unsubscribe function returned by `MakaioBus.on` or a
 * `() => endpoint.close()` thunk.
 */
let cleanups: Array<() => void>;

/** Active channel endpoint for the duration of a single test. */
let channelEndpoint: ChannelEndpoint | null;

/**
 * Register a real credential channel endpoint on the shared MakaioBus singleton.
 *
 * Mimics the subset of CredentialService used by resolveConnectorCredentials:
 * - `CredentialSubjects.getChannelToken` on the public bus
 * - `CredentialSubjects.resolve` on the encrypted DirectChannel
 *
 * Using real bus infrastructure (createChannelEndpoint, DirectChannel) so that
 * resolveConnectorCredentials exercises its actual code path end-to-end.
 */
function setupCredentialBus(): void {
  cleanups.push(
    MakaioBus.on(CredentialSubjects.getChannelToken, (ctx) => {
      ctx.setResult({ token: TEST_CHANNEL_TOKEN });
    }),
  );

  channelEndpoint = createChannelEndpoint(
    MakaioBus.getContext(),
    'credentials',
    (channel) => {
      channel.on(CredentialSubjects.resolve, (ctx) => {
        const { ref: credRef } = ctx.payload;
        if (!resolveStore.has(credRef)) {
          ctx.setResult({ value: null, error: `Ref not found: ${credRef}` });
          return;
        }
        const value = resolveStore.get(credRef) ?? null;
        ctx.setResult({ value });
      });
    },
    { token: TEST_CHANNEL_TOKEN },
  );

  cleanups.push(() => channelEndpoint?.close());
}

beforeEach(() => {
  resolveStore = new Map();
  cleanups = [];
  channelEndpoint = null;
});

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
  channelEndpoint = null;
});

/**
 * Cast a plain string to CredentialRef brand for use in test fixtures.
 * @param ref - Raw credential reference string
 * @returns Branded CredentialRef
 */
function ref(ref: string): CredentialRef {
  return CredentialRefSchema.parse(ref);
}

describe('resolveConnectorCredentials', () => {
  it('returns an empty object immediately when credentialRefs is empty (no channel opened)', async () => {
    // No channel endpoint registered — confirms no channel is opened on the empty path.
    const result = await resolveConnectorCredentials(MakaioBus, {});
    expect(result).toEqual({});
  });

  it('resolves a single credential ref to its plaintext value', async () => {
    setupCredentialBus();
    resolveStore.set('env:MY_API_KEY', 'sk-123');

    const result = await resolveConnectorCredentials(MakaioBus, {
      apiKey: ref('env:MY_API_KEY'),
    });

    expect(result).toEqual({ apiKey: 'sk-123' });
  });

  it('resolves multiple credential refs in parallel', async () => {
    setupCredentialBus();
    resolveStore.set('env:API_KEY', 'sk-abc');
    resolveStore.set('env:BASE_URL', 'https://api.example.com');

    const result = await resolveConnectorCredentials(MakaioBus, {
      apiKey: ref('env:API_KEY'),
      baseUrl: ref('env:BASE_URL'),
    });

    expect(result).toEqual({ apiKey: 'sk-abc', baseUrl: 'https://api.example.com' });
  });

  it('omits fields whose refs fail to resolve, and resolves the remaining fields', async () => {
    setupCredentialBus();
    resolveStore.set('env:GOOD_KEY', 'good-value');
    // 'env:BAD_KEY' is deliberately absent from resolveStore → triggers error path

    const result = await resolveConnectorCredentials(MakaioBus, {
      goodField: ref('env:GOOD_KEY'),
      badField: ref('env:BAD_KEY'),
    });

    expect(result).toEqual({ goodField: 'good-value' });
    expect('badField' in result).toBe(false);
  });

  it('omits a field when the resolved value is null (credential not found)', async () => {
    setupCredentialBus();
    resolveStore.set('env:NULL_KEY', null);

    const result = await resolveConnectorCredentials(MakaioBus, {
      apiKey: ref('env:NULL_KEY'),
    });

    expect(result).toEqual({});
    expect('apiKey' in result).toBe(false);
  });

  it('omits a field and completes without throwing when the channel handler rejects (finally block runs)', async () => {
    // Set up a fresh endpoint whose resolve handler always throws, triggering the
    // Promise.allSettled 'rejected' branch. The function must still return a clean
    // result — the finally block's channel.close() is what makes this safe.
    const throwingToken = 'throwing-token';
    cleanups.push(
      MakaioBus.on(CredentialSubjects.getChannelToken, (ctx) => {
        ctx.setResult({ token: throwingToken });
      }),
    );

    const throwingEndpoint = createChannelEndpoint(
      MakaioBus.getContext(),
      'credentials',
      (channel) => {
        channel.on(CredentialSubjects.resolve, () => {
          throw new Error('simulated resolve failure');
        });
      },
      { token: throwingToken },
    );
    cleanups.push(() => throwingEndpoint.close());

    // The function must not throw and must omit the failed field.
    const result = await resolveConnectorCredentials(MakaioBus, {
      field: ref('env:ANY_KEY'),
    });

    expect(result).toEqual({});
  });
});
