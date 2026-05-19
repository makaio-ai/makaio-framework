/// <reference types="bun-types" />
/**
 * Tests for ClaudeAccountObservationEmitter and normalizeClaudeAccountObservationPayload.
 *
 * Verifies that:
 * - `emitIfChanged` emits `client.session.account.observe` after a successful
 *   turn when the normalized account info has changed.
 * - Duplicate (unchanged) payloads are suppressed (dedup behavior).
 * - A missing or unsupported `accountInfo()` method does not break the turn.
 * - Both session locators (`sessionId` + `adapterSessionId`) are forwarded when
 *   both are present on the context.
 * - The retry logic for overlapping in-flight turn completions works correctly.
 */

import { beforeEach, describe, it, expect, mock } from 'bun:test';
import type { OptionalResult } from '@makaio/core';
import type { ClientSessionAccountObserveResponse } from '@makaio/contracts/client';
import {
  ClaudeAccountObservationEmitter,
  normalizeClaudeAccountObservationPayload,
  type ClaudeAccountObservationContext,
} from '../account-observation.js';
import type { RequestSessionAccountObservation } from '../account-observation-requester.js';

/**
 * Poll until `fn` resolves without throwing, or the timeout elapses.
 * @param fn - Async assertion or resolution function to retry
 * @param options - Optional `timeout` in ms (default 5000) and `interval` in ms (default 50)
 */
async function waitFor<T>(fn: () => Promise<T>, options?: { timeout?: number; interval?: number }): Promise<T> {
  const timeout = options?.timeout ?? 5_000;
  const interval = options?.interval ?? 50;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A well-formed raw account info snapshot that produces a valid payload. */
const VALID_RAW_ACCOUNT_INFO = {
  accountUuid: '11111111-1111-1111-8111-111111111111',
  orgUuid: '22222222-2222-2222-8222-222222222222',
  email: 'user@example.com',
  organization: 'Acme Corp',
  subscriptionType: 'pro',
  tokenSource: 'oauth',
  apiProvider: 'firstParty' as const,
};

/** A modified snapshot that produces a different payload (triggers re-emit). */
const UPDATED_RAW_ACCOUNT_INFO = {
  accountUuid: '11111111-1111-1111-8111-111111111111',
  orgUuid: '22222222-2222-2222-8222-222222222222',
  email: 'user@example.com',
  organization: 'New Corp',
  subscriptionType: 'pro',
};

/** The "handled" response returned by a successful session account observe handler. */
function handledResponse(): OptionalResult<ClientSessionAccountObserveResponse> {
  return {
    handled: true,
    data: {
      handled: true,
      sessionId: 'session-123',
      clientAccountId: 'account-abc',
      changed: true,
    },
  };
}

/** A "handled but not acted on" response (handled: false in data). */
function unhandledDataResponse(): OptionalResult<ClientSessionAccountObserveResponse> {
  return {
    handled: true,
    data: {
      handled: false,
      sessionId: null,
      clientAccountId: null,
      changed: false,
    },
  };
}

/** A bus-level "no handler registered" response. */
function noHandlerResponse(): OptionalResult<ClientSessionAccountObserveResponse> {
  return { handled: false };
}

/**
 * Build a minimal query instance stub with `accountInfo()`.
 * @param rawAccountInfo - Value to resolve from `accountInfo()`
 */
function makeQueryInstance(rawAccountInfo: unknown) {
  return {
    accountInfo: mock(async () => rawAccountInfo),
  };
}

/**
 * Build a context that yields the given query instance.
 * @param queryInstance - Stub query instance (may be undefined to simulate missing)
 * @param sessionId - Optional framework session ID
 * @param adapterSessionId - Optional adapter session ID
 */
function makeContext(
  queryInstance: ReturnType<typeof makeQueryInstance> | undefined,
  sessionId?: string,
  adapterSessionId?: string,
): ClaudeAccountObservationContext {
  return {
    sessionId,
    adapterSessionId,
    getQueryInstance: () => queryInstance,
  };
}

// ---------------------------------------------------------------------------
// normalizeClaudeAccountObservationPayload — unit tests
// ---------------------------------------------------------------------------

describe('normalizeClaudeAccountObservationPayload', () => {
  it('returns null when rawAccountInfo is not an object', () => {
    expect(normalizeClaudeAccountObservationPayload(null)).toBeNull();
    expect(normalizeClaudeAccountObservationPayload(undefined)).toBeNull();
    expect(normalizeClaudeAccountObservationPayload('string')).toBeNull();
    expect(normalizeClaudeAccountObservationPayload(42)).toBeNull();
  });

  it('returns null when no strong canonical identifier can be derived', () => {
    // Neither accountUuid nor orgUuid present
    expect(normalizeClaudeAccountObservationPayload({ email: 'user@example.com' })).toBeNull();
    // Only accountUuid — both required for a strong identifier
    expect(
      normalizeClaudeAccountObservationPayload({
        accountUuid: '11111111-1111-1111-8111-111111111111',
      }),
    ).toBeNull();
    // Only orgUuid — both required
    expect(
      normalizeClaudeAccountObservationPayload({
        orgUuid: '22222222-2222-2222-8222-222222222222',
      }),
    ).toBeNull();
  });

  it('returns null when UUIDs are malformed', () => {
    expect(
      normalizeClaudeAccountObservationPayload({
        accountUuid: 'not-a-uuid',
        orgUuid: '22222222-2222-2222-8222-222222222222',
      }),
    ).toBeNull();
  });

  it('returns a payload with identifiers when both UUIDs are valid', () => {
    const result = normalizeClaudeAccountObservationPayload(VALID_RAW_ACCOUNT_INFO);
    expect(result).not.toBeNull();
    expect(result!.identifiers).toHaveLength(1);
    expect(result!.identifiers[0]).toMatchObject({
      scheme: 'account-org-uuid',
      strength: 'strong',
    });
  });

  it('normalizes email to lowercase and sets it as displayLabel', () => {
    const result = normalizeClaudeAccountObservationPayload({
      ...VALID_RAW_ACCOUNT_INFO,
      email: 'UPPER@Example.COM',
    });
    expect(result!.accountInfo.email).toBe('upper@example.com');
    expect(result!.displayLabel).toBe('upper@example.com');
  });

  it('falls back to organization as displayLabel when email is absent', () => {
    const { email: _email, ...withoutEmail } = VALID_RAW_ACCOUNT_INFO;
    const result = normalizeClaudeAccountObservationPayload(withoutEmail);
    expect(result!.displayLabel).toBe('Acme Corp');
  });

  it('normalizes UUIDs to lowercase for canonical identifier value', () => {
    const result = normalizeClaudeAccountObservationPayload({
      accountUuid: '11111111-1111-1111-8111-111111111111',
      orgUuid: '22222222-2222-2222-8222-222222222222',
    });
    expect(result!.identifiers[0]!.value).toBe(
      '11111111-1111-1111-8111-111111111111:22222222-2222-2222-8222-222222222222',
    );
  });

  it('strips unknown apiProvider values', () => {
    const result = normalizeClaudeAccountObservationPayload({
      ...VALID_RAW_ACCOUNT_INFO,
      apiProvider: 'unknown-provider',
    });
    expect(result!.accountInfo.apiProvider).toBeUndefined();
  });

  it('preserves recognized apiProvider values', () => {
    const result = normalizeClaudeAccountObservationPayload({
      ...VALID_RAW_ACCOUNT_INFO,
      apiProvider: 'bedrock',
    });
    expect(result!.accountInfo.apiProvider).toBe('bedrock');
  });
});

// ---------------------------------------------------------------------------
// ClaudeAccountObservationEmitter
// ---------------------------------------------------------------------------

describe('ClaudeAccountObservationEmitter', () => {
  let requestObservation: ReturnType<typeof mock>;
  let emitter: ClaudeAccountObservationEmitter;

  beforeEach(() => {
    requestObservation = mock(async () => handledResponse());
    emitter = new ClaudeAccountObservationEmitter(
      requestObservation as unknown as RequestSessionAccountObservation,
      'claude-code',
    );
  });

  // -------------------------------------------------------------------------
  // Emit behavior
  // -------------------------------------------------------------------------

  describe('emitIfChanged', () => {
    it('emits client.session.account.observe after successful turn when account info is valid', async () => {
      const ctx = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), undefined, 'adapter-session-1');
      await emitter.emitIfChanged(ctx);
      expect(requestObservation).toHaveBeenCalledTimes(1);
      const [call] = requestObservation.mock.calls;
      expect(call![0]).toMatchObject({
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account-info',
        locator: {
          kind: 'adapter-session',
          adapterSessionId: 'adapter-session-1',
        },
      });
      expect(call![0]!.payload).toMatchObject({
        identifiers: expect.arrayContaining([
          expect.objectContaining({ scheme: 'account-org-uuid', strength: 'strong' }),
        ]),
      });
    });

    it('includes both sessionId and adapterSessionId in locator when both are present', async () => {
      const ctx = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), 'framework-session-1', 'adapter-session-1');
      await emitter.emitIfChanged(ctx);
      expect(requestObservation).toHaveBeenCalledTimes(1);
      expect(requestObservation.mock.calls[0]![0]!.locator).toEqual({
        kind: 'both',
        sessionId: 'framework-session-1',
        adapterSessionId: 'adapter-session-1',
      });
    });

    it('uses sessionId-only locator when adapterSessionId is absent', async () => {
      const ctx = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), 'framework-session-2');
      await emitter.emitIfChanged(ctx);
      expect(requestObservation.mock.calls[0]![0]!.locator).toEqual({
        kind: 'session',
        sessionId: 'framework-session-2',
      });
    });

    it('skips emit when neither sessionId nor adapterSessionId is set', async () => {
      const ctx = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO));
      await emitter.emitIfChanged(ctx);
      expect(requestObservation).not.toHaveBeenCalled();
    });

    it('stamps observedAt as a number on the emitted observation', async () => {
      const before = Date.now();
      const ctx = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), undefined, 'adapter-session-ts');
      await emitter.emitIfChanged(ctx);
      const after = Date.now();
      const { observedAt } = requestObservation.mock.calls[0]![0]!;
      expect(observedAt).toBeGreaterThanOrEqual(before);
      expect(observedAt).toBeLessThanOrEqual(after);
    });
  });

  // -------------------------------------------------------------------------
  // Dedup behavior
  // -------------------------------------------------------------------------

  describe('dedup (skips emit when account info is unchanged)', () => {
    it('does not re-emit when the payload and locator are identical on a subsequent call', async () => {
      const instance = makeQueryInstance(VALID_RAW_ACCOUNT_INFO);
      const ctx = makeContext(instance, 'session-dedup', 'adapter-dedup');

      await emitter.emitIfChanged(ctx);
      expect(requestObservation).toHaveBeenCalledTimes(1);

      // Second call with the same data — should be suppressed
      await emitter.emitIfChanged(ctx);
      expect(requestObservation).toHaveBeenCalledTimes(1);
    });

    it('re-emits when the payload changes between calls', async () => {
      const ctx1 = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), 'session-change', 'adapter-change');
      await emitter.emitIfChanged(ctx1);
      expect(requestObservation).toHaveBeenCalledTimes(1);

      const ctx2 = makeContext(makeQueryInstance(UPDATED_RAW_ACCOUNT_INFO), 'session-change', 'adapter-change');
      await emitter.emitIfChanged(ctx2);
      expect(requestObservation).toHaveBeenCalledTimes(2);
    });

    it('does not re-emit when only the locator changes (sessionId rotation)', async () => {
      const ctx1 = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), 'session-a', 'adapter-x');
      await emitter.emitIfChanged(ctx1);

      const ctx2 = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), 'session-b', 'adapter-x');
      await emitter.emitIfChanged(ctx2);

      expect(requestObservation).toHaveBeenCalledTimes(1);
    });

    it('does not cache the dedup key when the handler returns handled:false in data', async () => {
      requestObservation.mockResolvedValueOnce(unhandledDataResponse());
      const ctx = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), undefined, 'adapter-unhandled');

      await emitter.emitIfChanged(ctx);
      // Not cached — second call should attempt again
      await emitter.emitIfChanged(ctx);
      expect(requestObservation).toHaveBeenCalledTimes(2);
    });

    it('does not cache the dedup key when requestOptional returns handled:false (no handler)', async () => {
      requestObservation.mockResolvedValueOnce(noHandlerResponse());
      const ctx = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), undefined, 'adapter-no-handler');

      await emitter.emitIfChanged(ctx);
      await emitter.emitIfChanged(ctx);
      expect(requestObservation).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Tolerates missing / unsupported accountInfo()
  // -------------------------------------------------------------------------

  describe('missing or unsupported accountInfo()', () => {
    it('returns without emitting when queryInstance is undefined', async () => {
      const ctx = makeContext(undefined, undefined, 'adapter-no-instance');
      await emitter.emitIfChanged(ctx);
      expect(requestObservation).not.toHaveBeenCalled();
    });

    it('returns without emitting when queryInstance has no accountInfo method', async () => {
      // Simulate an SDK version that does not expose accountInfo()
      const ctx: ClaudeAccountObservationContext = {
        adapterSessionId: 'adapter-no-method',
        getQueryInstance: () => ({}) as ReturnType<typeof makeQueryInstance>,
      };
      await emitter.emitIfChanged(ctx);
      expect(requestObservation).not.toHaveBeenCalled();
    });

    it('does not throw when accountInfo() rejects', async () => {
      const failingInstance = {
        accountInfo: mock(async () => {
          throw new Error('accountInfo API unavailable');
        }),
      };
      const ctx = makeContext(failingInstance, undefined, 'adapter-fail');
      await expect(emitter.emitIfChanged(ctx)).resolves.toBeUndefined();
      expect(requestObservation).not.toHaveBeenCalled();
    });

    it('does not throw when requestObservation itself rejects', async () => {
      requestObservation.mockRejectedValueOnce(new Error('bus unavailable'));
      const ctx = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), undefined, 'adapter-bus-fail');
      await expect(emitter.emitIfChanged(ctx)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Retry logic for overlapping in-flight turn completions
  // -------------------------------------------------------------------------

  describe('retry logic for overlapping turns', () => {
    it('retries the observation once when an identical key arrives while in-flight', async () => {
      // Slow down the first requestObservation to create an in-flight window
      let resolveFirst!: (v: OptionalResult<ClientSessionAccountObserveResponse>) => void;
      const firstInflight = new Promise<OptionalResult<ClientSessionAccountObserveResponse>>(
        (resolve) => (resolveFirst = resolve),
      );
      requestObservation.mockReturnValueOnce(firstInflight).mockResolvedValue(handledResponse());

      const ctx = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), undefined, 'adapter-overlap');

      // Start first call — it is now in-flight
      const firstCall = emitter.emitIfChanged(ctx);

      // Start second call while first is still in-flight — the key is in-flight
      // so it enqueues a pending retry and returns immediately
      const secondCall = emitter.emitIfChanged(ctx);
      await secondCall;

      // Resolve the first in-flight call (not handled → triggers retry)
      resolveFirst(unhandledDataResponse());
      await firstCall;

      // The retry is fired asynchronously after firstCall settles; wait for it
      // rather than relying on a fixed wall-clock delay.
      await waitFor(() => Promise.resolve(expect(requestObservation).toHaveBeenCalledTimes(2)));
    });

    it('does not retry when the pending retry key is absent after the in-flight call settles', async () => {
      // Both calls succeed independently — no overlap scenario
      const ctx = makeContext(makeQueryInstance(VALID_RAW_ACCOUNT_INFO), undefined, 'adapter-no-retry');
      await emitter.emitIfChanged(ctx);
      // Second call is a different payload to bypass dedup
      const ctx2 = makeContext(makeQueryInstance(UPDATED_RAW_ACCOUNT_INFO), undefined, 'adapter-no-retry');
      await emitter.emitIfChanged(ctx2);
      // Exactly two observations sent — one per distinct key, no extra retries
      expect(requestObservation).toHaveBeenCalledTimes(2);
    });
  });
});
