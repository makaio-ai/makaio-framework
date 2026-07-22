/**
 * Tests for {@link collectContributions}.
 *
 * Verifies concurrent execution, timeout/deadline handling, failure
 * policies (open vs closed), validation, signal composition, and the
 * deterministic-first-closed-failure rule.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContributorCallbackContext, ContributorDefinition, ContributorResponse } from '@makaio/contracts/client';
import { type RegisteredContributor } from '../client-hook-response-collector.js';
import { collectContributions as collectForClient } from '../client-hook-response-collector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EVENT_NAME = 'PreToolUse';
const EVENT_PAYLOAD = { tool: 'bash' };
const CLIENT_ID = 'claude-code';
type CanonicalContributorDefinition = Extract<ContributorDefinition, { lane: 'canonical' }>;

/**
 * Collect using the fixed client identity for these focused collector tests.
 * @param snapshot - Ordered contributor snapshot.
 * @param requestDeadline - Optional absolute request cutoff.
 * @param requestSignal - Optional request abort signal.
 * @param eventName - Hook event name.
 * @param eventPayload - Hook event payload.
 * @returns Collection result for the test client.
 */
function collectContributions(
  snapshot: ReadonlyArray<RegisteredContributor>,
  requestDeadline: number | undefined,
  requestSignal: AbortSignal | undefined,
  eventName: string,
  eventPayload: unknown,
) {
  return collectForClient(snapshot, CLIENT_ID, requestDeadline, requestSignal, eventName, eventPayload);
}

/**
 * Build a minimal {@link ContributorDefinition} for tests.
 * @param overrides - Fields to override on the default definition.
 * @returns A contributor definition with sensible defaults.
 */
function makeContributor(
  overrides: Partial<CanonicalContributorDefinition> & Pick<CanonicalContributorDefinition, 'id'>,
): CanonicalContributorDefinition {
  return {
    lane: 'canonical',
    priority: 100,
    timeoutMs: 5000,
    selectors: [{ kind: 'event-name', name: EVENT_NAME }],
    respond: () => ({ canonicalEffects: [] }),
    ...overrides,
  };
}

/**
 * Wrap a contributor definition in the {@link RegisteredContributor} shape.
 * @param def - The contributor definition.
 * @returns A registered contributor entry.
 */
function registered(def: ContributorDefinition): RegisteredContributor {
  return { definition: def };
}

/**
 * Build a snapshot from a list of contributor definition overrides.
 * @param contributors - Partial contributor definitions.
 * @returns An ordered snapshot array.
 */
function makeSnapshot(
  ...contributors: Array<Partial<CanonicalContributorDefinition> & Pick<CanonicalContributorDefinition, 'id'>>
): ReadonlyArray<RegisteredContributor> {
  return contributors.map((c) => registered(makeContributor(c)));
}

/**
 * Create a respond callback that resolves after a specified delay.
 * @param delayMs - Delay in milliseconds before resolving.
 * @param response - The response to return.
 * @returns An async respond callback.
 */
function delayedRespond(
  delayMs: number,
  response: ContributorResponse = { canonicalEffects: [] },
): ContributorDefinition['respond'] {
  return () =>
    new Promise<ContributorResponse>((resolve) => {
      setTimeout(() => resolve(response), delayMs);
    });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('collectContributions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Empty / immediate returns
  // -------------------------------------------------------------------------

  describe('empty and fast-path cases', () => {
    it('returns immediately for an empty snapshot', async () => {
      const result = await collectContributions([], undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      expect(result.closedFailure).toBeUndefined();
    });

    it('returns all-timeout outcomes when the request deadline is already expired', async () => {
      const pastDeadline = Date.now() - 1000;
      const snapshot = makeSnapshot({ id: 'a', failurePolicy: 'open' }, { id: 'b', failurePolicy: 'open' });

      const result = await collectContributions(snapshot, pastDeadline, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes[0].outcome).toBe('timeout');
      expect(result.outcomes[1].outcome).toBe('timeout');
      expect(result.diagnostics).toHaveLength(2);
    });

    it('returns closed-failure for closed-policy contributors when deadline is expired', async () => {
      const pastDeadline = Date.now() - 1000;
      const snapshot = makeSnapshot(
        { id: 'open-one', failurePolicy: 'open' },
        { id: 'closed-one', failurePolicy: 'closed' },
      );

      const result = await collectContributions(snapshot, pastDeadline, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].outcome).toBe('timeout');
      expect(result.outcomes[1].outcome).toBe('closed-failure');
      expect(result.closedFailure).toBeDefined();
      expect(result.closedFailure!.contributorId).toBe('closed-one');
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  describe('concurrent execution', () => {
    it('starts all callbacks before awaiting any result', async () => {
      const callOrder: string[] = [];

      const snapshot = makeSnapshot(
        {
          id: 'slow',
          timeoutMs: 5000,
          respond: () => {
            callOrder.push('slow-started');
            return new Promise<ContributorResponse>((resolve) => {
              setTimeout(() => {
                callOrder.push('slow-resolved');
                resolve({ canonicalEffects: [] });
              }, 3000);
            });
          },
        },
        {
          id: 'fast',
          timeoutMs: 5000,
          respond: () => {
            callOrder.push('fast-started');
            return new Promise<ContributorResponse>((resolve) => {
              setTimeout(() => {
                callOrder.push('fast-resolved');
                resolve({ canonicalEffects: [] });
              }, 1000);
            });
          },
        },
      );

      const promise = collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      // Both should have started synchronously
      expect(callOrder).toEqual(['slow-started', 'fast-started']);

      // Advance past both timeouts
      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(callOrder).toEqual(['slow-started', 'fast-started', 'fast-resolved', 'slow-resolved']);
    });

    it('finishes near the slowest callback, not the sum of timeouts', async () => {
      // Two callbacks each taking 2s — concurrent should take ~2s, not 4s.
      const snapshot = makeSnapshot(
        {
          id: 'a',
          timeoutMs: 5000,
          respond: delayedRespond(2000),
        },
        {
          id: 'b',
          timeoutMs: 5000,
          respond: delayedRespond(2000),
        },
      );

      const promise = collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      // At 2s both should have resolved
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes.every((o) => o.outcome === 'success')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Timeout and deadline
  // -------------------------------------------------------------------------

  describe('timeout and deadline handling', () => {
    it('times out a contributor that exceeds its timeoutMs', async () => {
      const snapshot = makeSnapshot({
        id: 'slow',
        timeoutMs: 100,
        respond: delayedRespond(500),
      });

      const promise = collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].outcome).toBe('timeout');
      expect(result.diagnostics).toHaveLength(1);
    });

    it('uses the request deadline when it is earlier than the callback timeout', async () => {
      const now = Date.now();
      // Request deadline in 50ms, but callback timeout is 5000ms
      const requestDeadline = now + 50;

      const snapshot = makeSnapshot({
        id: 'a',
        timeoutMs: 5000,
        respond: delayedRespond(200),
      });

      const promise = collectContributions(snapshot, requestDeadline, undefined, EVENT_NAME, EVENT_PAYLOAD);

      // At 50ms the request deadline fires
      await vi.advanceTimersByTimeAsync(50);
      const result = await promise;

      expect(result.outcomes[0].outcome).toBe('timeout');
    });

    it('uses the callback timeout when it is earlier than the request deadline', async () => {
      const now = Date.now();
      // Request deadline in 5000ms, but callback timeout is 50ms
      const requestDeadline = now + 5000;

      const snapshot = makeSnapshot({
        id: 'a',
        timeoutMs: 50,
        respond: delayedRespond(200),
      });

      const promise = collectContributions(snapshot, requestDeadline, undefined, EVENT_NAME, EVENT_PAYLOAD);

      // At 50ms the callback timeout fires
      await vi.advanceTimersByTimeAsync(50);
      const result = await promise;

      expect(result.outcomes[0].outcome).toBe('timeout');
    });

    it('aborts the contributor signal on timeout', async () => {
      let capturedSignal: AbortSignal | undefined;

      const snapshot = makeSnapshot({
        id: 'a',
        timeoutMs: 100,
        respond: (ctx: ContributorCallbackContext) => {
          capturedSignal = ctx.signal;
          return new Promise<ContributorResponse>((resolve) => {
            setTimeout(() => resolve({ canonicalEffects: [] }), 500);
          });
        },
      });

      const promise = collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(capturedSignal!.aborted).toBe(true);
    });

    it('provides correct deadline and remainingBudgetMs in the callback context', async () => {
      const now = Date.now();
      let capturedCtx: ContributorCallbackContext | undefined;

      const snapshot = makeSnapshot({
        id: 'a',
        timeoutMs: 3000,
        respond: (ctx: ContributorCallbackContext) => {
          capturedCtx = ctx;
          return { canonicalEffects: [] };
        },
      });

      const requestDeadline = now + 2000;

      await collectContributions(snapshot, requestDeadline, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(capturedCtx).toBeDefined();
      // Deadline should be min(requestDeadline, start + 3000) = requestDeadline
      expect(capturedCtx!.deadline).toBe(requestDeadline);
      expect(capturedCtx!.remainingBudgetMs).toBeLessThanOrEqual(2000);
      expect(capturedCtx!.remainingBudgetMs).toBeGreaterThan(0);
      expect(capturedCtx!.eventName).toBe(EVENT_NAME);
      expect(capturedCtx!.eventPayload).toBe(EVENT_PAYLOAD);
    });
  });

  // -------------------------------------------------------------------------
  // Signal composition
  // -------------------------------------------------------------------------

  describe('request signal composition', () => {
    it('aborts the contributor when the request signal fires', async () => {
      const requestAbort = new AbortController();
      let capturedSignal: AbortSignal | undefined;

      const snapshot = makeSnapshot({
        id: 'a',
        timeoutMs: 5000,
        respond: (ctx: ContributorCallbackContext) => {
          capturedSignal = ctx.signal;
          return new Promise<ContributorResponse>((resolve) => {
            setTimeout(() => resolve({ canonicalEffects: [] }), 3000);
          });
        },
      });

      const promise = collectContributions(snapshot, undefined, requestAbort.signal, EVENT_NAME, EVENT_PAYLOAD);

      expect(capturedSignal!.aborted).toBe(false);

      // Abort the request signal
      requestAbort.abort(new Error('Request cancelled'));

      // The contributor's signal should fire
      expect(capturedSignal!.aborted).toBe(true);

      // Advance to let timers settle
      await vi.advanceTimersByTimeAsync(5000);
      await promise;
    });

    it('does not invoke contributors when the request signal is already aborted', async () => {
      const requestAbort = new AbortController();
      requestAbort.abort(new Error('Already cancelled'));

      let capturedSignal: AbortSignal | undefined;

      const snapshot = makeSnapshot({
        id: 'a',
        timeoutMs: 5000,
        respond: (ctx: ContributorCallbackContext) => {
          capturedSignal = ctx.signal;
          return { canonicalEffects: [] };
        },
      });

      const result = await collectContributions(snapshot, undefined, requestAbort.signal, EVENT_NAME, EVENT_PAYLOAD);

      expect(capturedSignal).toBeUndefined();
      expect(result.outcomes[0].outcome).toBe('timeout');
    });
  });

  // -------------------------------------------------------------------------
  // Failure policies
  // -------------------------------------------------------------------------

  describe('open failure policy', () => {
    it('retains successful siblings when an open-policy contributor times out', async () => {
      const snapshot = makeSnapshot(
        {
          id: 'fast-success',
          timeoutMs: 5000,
          respond: () => ({
            canonicalEffects: [{ kind: 'context.append', value: 'hello' }],
          }),
        },
        {
          id: 'slow-timeout',
          timeoutMs: 100,
          failurePolicy: 'open',
          respond: delayedRespond(500),
        },
      );

      const promise = collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      // Fast one succeeded, slow one timed out
      expect(result.outcomes[0].outcome).toBe('success');
      expect(result.outcomes[0].effects).toEqual([{ kind: 'context.append', value: 'hello' }]);
      expect(result.outcomes[1].outcome).toBe('timeout');
      expect(result.closedFailure).toBeUndefined();
    });

    it('retains successful siblings when an open-policy contributor rejects', async () => {
      const snapshot = makeSnapshot(
        {
          id: 'good',
          timeoutMs: 5000,
          respond: () => ({
            canonicalEffects: [{ kind: 'context.append', value: 'ok' }],
          }),
        },
        {
          id: 'bad',
          timeoutMs: 5000,
          failurePolicy: 'open',
          respond: () => {
            throw new Error('Extension broke');
          },
        },
      );

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].outcome).toBe('success');
      expect(result.outcomes[0].effects).toBeDefined();
      expect(result.outcomes[1].outcome).toBe('rejection');
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].message).toContain('Extension broke');
      expect(result.closedFailure).toBeUndefined();
    });
  });

  describe('closed failure policy', () => {
    it('discards ALL effects when a closed-policy contributor times out', async () => {
      const snapshot = makeSnapshot(
        {
          id: 'success-a',
          timeoutMs: 5000,
          respond: () => ({
            canonicalEffects: [{ kind: 'context.append', value: 'kept?' }],
          }),
        },
        {
          id: 'closed-timeout',
          timeoutMs: 100,
          failurePolicy: 'closed',
          respond: delayedRespond(500),
        },
      );

      const promise = collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      // Effects discarded from all outcomes
      expect(result.outcomes[0].outcome).toBe('success');
      expect(result.outcomes[0].effects).toBeUndefined();
      expect(result.outcomes[1].outcome).toBe('closed-failure');
      expect(result.closedFailure).toBeDefined();
      expect(result.closedFailure!.contributorId).toBe('closed-timeout');
    });

    it('discards ALL effects when a closed-policy contributor rejects', async () => {
      const snapshot = makeSnapshot(
        {
          id: 'success-a',
          timeoutMs: 5000,
          respond: () => ({
            canonicalEffects: [{ kind: 'context.append', value: 'data' }],
          }),
        },
        {
          id: 'closed-reject',
          timeoutMs: 5000,
          failurePolicy: 'closed',
          respond: () => {
            throw new Error('Closed policy failure');
          },
        },
      );

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.closedFailure).toBeDefined();
      expect(result.closedFailure!.contributorId).toBe('closed-reject');
      // All effects stripped
      for (const outcome of result.outcomes) {
        expect(outcome.effects).toBeUndefined();
      }
    });

    it('selects the first closed failure by snapshot order when multiple exist', async () => {
      const snapshot = makeSnapshot(
        {
          id: 'closed-first',
          timeoutMs: 5000,
          failurePolicy: 'closed',
          respond: () => {
            throw new Error('First closed');
          },
        },
        {
          id: 'closed-second',
          timeoutMs: 5000,
          failurePolicy: 'closed',
          respond: () => {
            throw new Error('Second closed');
          },
        },
      );

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.closedFailure).toBeDefined();
      expect(result.closedFailure!.contributorId).toBe('closed-first');
    });
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe('provider contract validation', () => {
    it('rejects malformed canonical effects under the open policy', async () => {
      const malformedResponse: ContributorResponse = { canonicalEffects: [] };
      Object.defineProperty(malformedResponse, 'canonicalEffects', { value: [{}] });
      const snapshot = makeSnapshot({
        id: 'invalid',
        respond: () => malformedResponse,
      });

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].outcome).toBe('rejection');
      expect(result.diagnostics[0].message).toContain('complete context.append effects');
    });

    it('rejects response and canonical-effect keys outside the declared shape', async () => {
      const malformedResponse: ContributorResponse = {
        canonicalEffects: [{ kind: 'context.append', value: 'ok' }],
      };
      Object.defineProperty(malformedResponse, 'stdout', { value: 'deny', enumerable: true });
      const snapshot = makeSnapshot({
        id: 'invalid-keys',
        respond: () => malformedResponse,
      });

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].outcome).toBe('rejection');
      expect(result.diagnostics[0].message).toContain('keys outside the canonical lane');
    });

    it('triggers closed failure for malformed canonical effects', async () => {
      const malformedResponse: ContributorResponse = { canonicalEffects: [] };
      Object.defineProperty(malformedResponse, 'canonicalEffects', { value: [{}] });
      const snapshot = makeSnapshot({
        id: 'closed-invalid',
        failurePolicy: 'closed',
        respond: () => malformedResponse,
      });

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].outcome).toBe('closed-failure');
      expect(result.closedFailure).toBeDefined();
      expect(result.closedFailure!.contributorId).toBe('closed-invalid');
    });
  });

  // -------------------------------------------------------------------------
  // Synchronous callbacks
  // -------------------------------------------------------------------------

  describe('synchronous callbacks', () => {
    it('handles synchronous respond callbacks', async () => {
      const snapshot = makeSnapshot({
        id: 'sync',
        timeoutMs: 5000,
        respond: () => ({
          canonicalEffects: [{ kind: 'context.append', value: 'sync-value' }],
        }),
      });

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].outcome).toBe('success');
      expect(result.outcomes[0].effects).toEqual([{ kind: 'context.append', value: 'sync-value' }]);
    });

    it('handles synchronous throws', async () => {
      const snapshot = makeSnapshot({
        id: 'sync-throw',
        timeoutMs: 5000,
        respond: () => {
          throw new Error('Sync explosion');
        },
      });

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].outcome).toBe('rejection');
      expect(result.diagnostics[0].message).toContain('Sync explosion');
    });
  });

  // -------------------------------------------------------------------------
  // Effects extraction
  // -------------------------------------------------------------------------

  describe('effects extraction', () => {
    it('rejects responses that mix canonical and provider lanes', async () => {
      const snapshot = makeSnapshot({
        id: 'both',
        timeoutMs: 5000,
        respond: () => ({
          canonicalEffects: [{ kind: 'context.append', value: 'hello' }],
          providerEnvelope: {
            clientId: 'claude-code',
            contractId: 'anthropic.tool-response@1',
            effects: { deny: true },
          },
        }),
      });

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].outcome).toBe('rejection');
      expect(result.diagnostics[0].message).toContain('outside the canonical lane');
    });

    it('returns undefined effects for a no-op response', async () => {
      const snapshot = makeSnapshot({
        id: 'noop',
        timeoutMs: 5000,
        respond: () => ({}),
      });

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].outcome).toBe('success');
      expect(result.outcomes[0].effects).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Default failure policy
  // -------------------------------------------------------------------------

  describe('default failure policy', () => {
    it('defaults to open when failurePolicy is omitted', async () => {
      const snapshot = makeSnapshot({
        id: 'no-policy',
        timeoutMs: 100,
        // failurePolicy omitted — should default to 'open'
        respond: delayedRespond(500),
      });

      const promise = collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      // Should be 'timeout' (open), not 'closed-failure'
      expect(result.outcomes[0].outcome).toBe('timeout');
      expect(result.closedFailure).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Late resolution
  // -------------------------------------------------------------------------

  describe('late resolution handling', () => {
    it('ignores late resolution after timeout even when callback ignores cancellation', async () => {
      let resolveCallback: ((r: ContributorResponse) => void) | undefined;

      const snapshot = makeSnapshot({
        id: 'stubborn',
        timeoutMs: 100,
        respond: () =>
          new Promise<ContributorResponse>((resolve) => {
            resolveCallback = resolve;
            // This callback never checks the signal and resolves late
          }),
      });

      const promise = collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      // Timeout fires at 100ms
      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result.outcomes[0].outcome).toBe('timeout');

      // Now the callback resolves late — should have no effect on the result
      resolveCallback!({
        canonicalEffects: [{ kind: 'context.append', value: 'late' }],
      });

      // The result object is already returned and is immutable
      expect(result.outcomes[0].outcome).toBe('timeout');
      expect(result.outcomes[0].effects).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Mixed scenario
  // -------------------------------------------------------------------------

  describe('mixed scenario', () => {
    it('handles a realistic mix of success, timeout, rejection, and closed failure', async () => {
      const snapshot = makeSnapshot(
        {
          id: 'priority-high',
          priority: 300,
          timeoutMs: 5000,
          respond: () => ({
            canonicalEffects: [{ kind: 'context.append', value: 'high-priority' }],
          }),
        },
        {
          id: 'priority-mid',
          priority: 200,
          timeoutMs: 100,
          failurePolicy: 'closed',
          respond: delayedRespond(500), // Will timeout → closed failure
        },
        {
          id: 'priority-low',
          priority: 100,
          timeoutMs: 5000,
          respond: () => {
            throw new Error('Low priority broke');
          },
        },
      );

      const promise = collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      // 3 outcomes in snapshot order
      expect(result.outcomes).toHaveLength(3);
      expect(result.outcomes[0].contributorId).toBe('priority-high');
      expect(result.outcomes[0].outcome).toBe('success');
      expect(result.outcomes[1].contributorId).toBe('priority-mid');
      expect(result.outcomes[1].outcome).toBe('closed-failure');
      expect(result.outcomes[2].contributorId).toBe('priority-low');
      expect(result.outcomes[2].outcome).toBe('rejection');

      // Closed failure present → all effects stripped
      expect(result.closedFailure).toBeDefined();
      expect(result.closedFailure!.contributorId).toBe('priority-mid');
      for (const outcome of result.outcomes) {
        expect(outcome.effects).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Deadline overrun race condition
  // -------------------------------------------------------------------------

  describe('deadline overrun guard', () => {
    it('treats a result arriving exactly at the cutoff as a timeout', async () => {
      // Use real timers for this test since we need precise Date.now()
      // control via vi.setSystemTime.
      vi.useRealTimers();
      vi.useFakeTimers();

      const baseTime = Date.now();

      const snapshot = makeSnapshot({
        id: 'edge-case',
        timeoutMs: 100,
        respond: () =>
          new Promise<ContributorResponse>((resolve) => {
            // This resolves at exactly the cutoff boundary.
            setTimeout(() => {
              // Advance time so Date.now() returns the cutoff instant.
              vi.setSystemTime(baseTime + 100);
              resolve({ canonicalEffects: [] });
            }, 99);
          }),
      });

      const promise = collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      // Advance to just before timeout (99ms) so the callback resolves
      // but Date.now() is at or past the cutoff.
      await vi.advanceTimersByTimeAsync(99);
      const result = await promise;

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].outcome).toBe('timeout');
    });
  });

  // -------------------------------------------------------------------------
  // Namespaced ID in outcomes and diagnostics
  // -------------------------------------------------------------------------

  describe('namespacedId in diagnostics', () => {
    it('uses namespacedId when present in registered contributor', async () => {
      const def = makeContributor({
        id: 'local-id',
        timeoutMs: 5000,
        respond: () => ({
          canonicalEffects: [{ kind: 'context.append', value: 'ok' }],
        }),
      });

      const snapshot: ReadonlyArray<RegisteredContributor> = [{ definition: def, namespacedId: 'ext-a/local-id' }];

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].contributorId).toBe('ext-a/local-id');
    });

    it('uses namespacedId in diagnostics for failures', async () => {
      const def = makeContributor({
        id: 'local-id',
        timeoutMs: 5000,
        respond: () => {
          throw new Error('boom');
        },
      });

      const snapshot: ReadonlyArray<RegisteredContributor> = [{ definition: def, namespacedId: 'ext-b/local-id' }];

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].contributorId).toBe('ext-b/local-id');
      expect(result.diagnostics[0].contributorId).toBe('ext-b/local-id');
    });

    it('falls back to definition.id when namespacedId is absent', async () => {
      const def = makeContributor({
        id: 'fallback-id',
        timeoutMs: 5000,
        respond: () => ({
          canonicalEffects: [{ kind: 'context.append', value: 'ok' }],
        }),
      });

      // No namespacedId — should use def.id.
      const snapshot: ReadonlyArray<RegisteredContributor> = [{ definition: def }];

      const result = await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].contributorId).toBe('fallback-id');
    });

    it('uses namespacedId in expired-deadline fast path', async () => {
      const def = makeContributor({
        id: 'local-id',
        timeoutMs: 5000,
      });

      const snapshot: ReadonlyArray<RegisteredContributor> = [{ definition: def, namespacedId: 'ext-c/local-id' }];

      const result = await collectContributions(snapshot, Date.now() - 1000, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(result.outcomes[0].contributorId).toBe('ext-c/local-id');
      expect(result.diagnostics[0].contributorId).toBe('ext-c/local-id');
    });
  });

  describe('client identity and cancellation', () => {
    it('passes the receiving client ID to callbacks', async () => {
      let callbackClientId: string | undefined;
      const snapshot = makeSnapshot({
        id: 'client-aware',
        respond: (ctx) => {
          callbackClientId = ctx.clientId;
          return undefined;
        },
      });

      await collectContributions(snapshot, undefined, undefined, EVENT_NAME, EVENT_PAYLOAD);

      expect(callbackClientId).toBe(CLIENT_ID);
    });

    it('settles on request abort even when a callback never resolves', async () => {
      const abort = new AbortController();
      const snapshot = makeSnapshot({
        id: 'stubborn',
        timeoutMs: 60_000,
        respond: () => new Promise<ContributorResponse>(() => {}),
      });

      const resultPromise = collectContributions(snapshot, undefined, abort.signal, EVENT_NAME, EVENT_PAYLOAD);
      abort.abort(new Error('request cancelled'));

      await expect(resultPromise).resolves.toMatchObject({
        outcomes: [{ contributorId: 'stubborn', outcome: 'timeout' }],
      });
    });

    it('rejects a provider envelope whose client identity differs from its lane', async () => {
      const definition: ContributorDefinition = {
        lane: 'provider',
        clientId: CLIENT_ID,
        contractId: 'test.contract',
        id: 'provider',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: EVENT_NAME }],
        respond: () => ({
          providerEnvelope: {
            clientId: 'codex',
            contractId: 'test.contract',
            effects: {},
          },
        }),
      };
      const contract = {
        clientId: CLIENT_ID,
        contractId: 'test.contract',
        version: '1.0.0',
        supportedInteractions: [EVENT_NAME],
        blockability: [{ interaction: EVENT_NAME, blockable: true }],
        validate: () => true as const,
      };

      const result = await collectForClient(
        [{ definition }],
        CLIENT_ID,
        undefined,
        undefined,
        EVENT_NAME,
        EVENT_PAYLOAD,
        contract,
      );

      expect(result.outcomes[0].outcome).toBe('rejection');
      expect(result.diagnostics[0].message).toContain('exact clientId');
    });
  });
});
