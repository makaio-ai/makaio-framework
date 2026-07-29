/**
 * Regression tests for session-ID deferred and consumption-loop deadlocks
 * that manifest after a query rotation triggered by responseSchema changes.
 *
 * ## Scenario
 *
 * When `ClaudeConnectorSession.createQuery()` is called (on every rotation),
 * it sets `confirmedSessionId = false` and installs a FRESH, UNRESOLVED
 * `deferredSessionId`. A rotation is triggered by
 * `ensureQueryForResponseSchema()` when a turn arrives with a different
 * `responseSchema` than the active query.
 *
 * After rotation:
 * - `connector.sendMessage()` awaits `session.getAdapterSessionId()`,
 *   capturing the fresh deferred's promise.
 * - Pre-FIX-2: `system.init` replaced the deferred instance, abandoning that
 *   captured promise so it could never settle → the turn hung.
 * - Pre-FIX-1: the consumption loop called `emitSdkEvent` for every message
 *   that `isKnownSdkMessageForRouting` rejects. `emitSdkEvent` awaited the
 *   blocking `getAdapterSessionId()` — parking the drain on a promise that
 *   only `system.init` can settle, while that same drain is the only thing
 *   able to deliver `system.init`. Permanent deadlock.
 *
 * Real Claude Code CLI 2.1.x emits pre-init traffic (operational `system`
 * subtypes such as `hook_started`, and top-level types the client does not
 * model yet such as `command_lifecycle`) before `system.init`.
 *
 * ## Harness
 *
 * A `vi.hoisted()` query harness (same pattern as session-native-fork.test.ts)
 * drives the mocked SDK query. A REAL `ClaudeSdkConnector` is used — the bug
 * lived in its `emitSdkEvent` callback, which a vi.fn() stub would hide.
 */

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { SDKMessage } from '@makaio/client-claude-code';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import type { NormalizedMessageInput } from '@makaio/ai-adapters-core';

// ─────────────────────────────────────────────────────────────────────────────
// SDK stub harness (verbatim pattern from session-native-fork.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

type MessageCallback = (msg: SDKMessage) => void;

const queryHarness = vi.hoisted(() => {
  let messageCallback: MessageCallback | undefined;
  let closeCallback: (() => void) | undefined;
  let endIteratorCallback: (() => void) | undefined;
  let iteratorErrorCallback: ((error: Error) => void) | undefined;
  let nextIteratorError: Error | undefined;
  let nextQueryError: Error | undefined;
  let endIteratorOnInterrupt = false;

  const queryInstance = {
    /** Async iterator that yields messages pushed via emitMessage. */
    [Symbol.asyncIterator]() {
      const pending: SDKMessage[] = [];
      const initialError = nextIteratorError;
      nextIteratorError = undefined;
      let waiting:
        | {
            resolve: (value: IteratorResult<SDKMessage, undefined>) => void;
            reject: (error: Error) => void;
          }
        | undefined;
      let done = false;

      messageCallback = (msg: SDKMessage) => {
        if (waiting) {
          const { resolve } = waiting;
          waiting = undefined;
          resolve({ value: msg, done: false });
        } else {
          pending.push(msg);
        }
      };

      closeCallback = () => {
        done = true;
        if (waiting) {
          const { resolve } = waiting;
          waiting = undefined;
          resolve({ value: undefined, done: true });
        }
      };
      endIteratorCallback = closeCallback;

      iteratorErrorCallback = (error: Error) => {
        if (waiting) {
          const { reject } = waiting;
          waiting = undefined;
          reject(error);
        }
      };

      return {
        next(): Promise<IteratorResult<SDKMessage, undefined>> {
          if (initialError) {
            return Promise.reject(initialError);
          }
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve, reject) => {
            waiting = { resolve, reject };
          });
        },
        return(): Promise<IteratorResult<SDKMessage, undefined>> {
          done = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
    close: vi.fn(() => {
      closeCallback?.();
    }),
    setMcpServers: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => {
      if (endIteratorOnInterrupt) endIteratorCallback?.();
    }),
    setModel: vi.fn(async () => undefined),
    setMaxThinkingTokens: vi.fn(async () => undefined),
  };

  return {
    queryFn: vi.fn((_input: { options: { resume?: string } }) => {
      const error = nextQueryError;
      nextQueryError = undefined;
      if (error) throw error;
      return queryInstance;
    }),
    queryInstance,
    /**
     * Emit a message into the active consumption loop.
     * @param msg - SDK message to deliver.
     */
    emitMessage(msg: SDKMessage): void {
      if (!messageCallback) {
        throw new Error('Query consumption not started — was initialize() called?');
      }
      messageCallback(msg);
    },
    /**
     * Fail the active SDK iterator, simulating a transport or SDK crash.
     * @param error - Error delivered to the iterator's pending read.
     */
    failIterator(error: Error): void {
      if (!iteratorErrorCallback) {
        throw new Error('Query consumption not started — was initialize() called?');
      }
      iteratorErrorCallback(error);
    },
    /**
     * Fail the next SDK iterator as soon as consumption begins.
     * @param error - Error delivered by the iterator's first read.
     */
    failNextIterator(error: Error): void {
      nextIteratorError = error;
    },
    /** End the active SDK iterator without emitting a terminal result. */
    endIterator(): void {
      if (!endIteratorCallback) throw new Error('Query consumption not started — was initialize() called?');
      endIteratorCallback();
    },
    /**
     * Throw from the next SDK query construction.
     * @param error - Error thrown by the SDK query factory.
     */
    failNextQuery(error: Error): void {
      nextQueryError = error;
    },
    /** End the active iterator while the next interrupt is being handled. */
    endIteratorOnNextInterrupt(): void {
      endIteratorOnInterrupt = true;
    },
    reset(): void {
      messageCallback = undefined;
      closeCallback = undefined;
      endIteratorCallback = undefined;
      iteratorErrorCallback = undefined;
      nextIteratorError = undefined;
      nextQueryError = undefined;
      endIteratorOnInterrupt = false;
      queryInstance.close.mockClear();
      queryInstance.setMcpServers.mockClear();
      queryInstance.interrupt.mockClear();
      queryInstance.setModel.mockClear();
      queryInstance.setMaxThinkingTokens.mockClear();
      this.queryFn.mockClear();
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryHarness.queryFn,
}));

import { ClaudeSdkConnector } from '../connector.js';
import { ClaudeCodeConnectorNamespace, ClaudeCodeConnectorSubjects } from '../namespace/index.js';
import { ClaudeCodeAdapterName } from '../constants.js';
import { createSessionAccountObservationRequester } from '../account-observation-requester.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared test data
// ─────────────────────────────────────────────────────────────────────────────

/** User message driven into the connector for each rotation scenario. */
const TEST_MESSAGE: NormalizedMessageInput = {
  role: 'user',
  blocks: [{ type: 'text', content: 'structured output test' }],
  message: 'structured output test',
};

/**
 * A response schema descriptor that differs from the initial nil schema so
 * that `ensureQueryForResponseSchema` rotates the SDK query on the first
 * `sendMessage()` call.
 */
const ROTATION_SCHEMA = {
  schema: { type: 'object' as const, properties: { answer: { type: 'string' } } },
  name: 'test-schema',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reject after a fixed timeout so hung turns surface as test failures rather
 * than stalling the entire vitest suite.
 * @param ms - Milliseconds to wait before rejecting.
 */
function timeoutRejecting(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Expected operation to complete within ${ms}ms`)), ms),
  );
}

/**
 * Build base SDK event metadata shared across all mock events.
 * @param sessionId - Adapter session ID to embed.
 */
function sdkBase(sessionId: string) {
  return { uuid: randomUUID(), session_id: sessionId };
}

/**
 * Build a well-formed `system.init` SDK event that resolves the session
 * deferred and sets `confirmedSessionId = true` in the session.
 * @param sessionId - Provider-confirmed session ID.
 */
function systemInit(sessionId: string): SDKMessage {
  return {
    ...sdkBase(sessionId),
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    cwd: os.tmpdir(),
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
  } as unknown as SDKMessage;
}

/**
 * Build a successful `result` SDK event to complete the active turn.
 * @param sessionId - Session ID for the completed turn.
 */
function successResult(sessionId: string): SDKMessage {
  return {
    ...sdkBase(sessionId),
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
      service_tier: 'standard',
    },
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage;
}

/**
 * Pause until the JS micro-task / macro-task queue has drained.
 * @param ms - Milliseconds to wait before resolving.
 */
const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Create a fully configured ClaudeSdkConnector backed by the mocked SDK.
 * Config shape mirrors the sibling `changeModelInPlace` connector test.
 * @returns A connector wired to the scoped connector bus.
 */
async function makeConnector(): Promise<ClaudeSdkConnector> {
  const bus = await ClaudeCodeConnectorNamespace.scopedBus();
  return new ClaudeSdkConnector({
    bus,
    adapterId: 'adapter-test',
    adapterName: ClaudeCodeAdapterName,
    agentId: 'agent-test',
    model: 'claude-sonnet-4-20250514',
    cwd: os.tmpdir(),
    env: {},
    clientId: claudeClientDefinition.id,
    requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ClaudeSdkConnector session-ID rotation deadlock prevention', () => {
  let connector: ClaudeSdkConnector;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    queryHarness.reset();
    connector = await makeConnector();
  });

  afterEach(async () => {
    MakaioBus.__resetHandlers?.();
    await connector.close().catch(() => undefined);
  });

  it('captured session-ID promise settles when system.init arrives after query rotation (guards FIX 2)', async () => {
    // Phase 1 — establish the initial session (no responseSchema).
    // initialize() eagerly resolves the deferred for non-fork sessions so the
    // caller does not block.  No messages need to be pushed to the initial query.
    await connector.initialize();

    const rotatedSessionId = randomUUID();

    // Phase 2 — trigger a rotation via responseSchema.
    //
    // sendMessage() with a responseSchema calls processQueue → startNewTurn →
    // ensureQueryForResponseSchema which notices the schema key mismatch and
    // calls createQuery().  createQuery() installs a FRESH, UNRESOLVED deferred
    // (confirmedSessionId = false).  sendMessage() then awaits
    // session.getAdapterSessionId(), capturing the new deferred's promise.
    //
    // Pre-FIX-2: system.init replaced the deferred with a new already-resolved
    // instance, abandoning the captured promise forever → the turn hung.
    // Post-FIX-2: system.init calls .resolve() on the EXISTING deferred, so
    // the captured promise settles and sendMessage() returns.
    const sendPromise = connector.sendMessage(TEST_MESSAGE, { responseSchema: ROTATION_SCHEMA });

    // Verify sendMessage() has NOT resolved before we emit system.init.
    const resolvedEarly = await Promise.race([sendPromise.then(() => true), tick(30).then(() => false)]);
    expect(resolvedEarly).toBe(false);

    // Emit system.init — resolves the fresh deferred installed by createQuery().
    queryHarness.emitMessage(systemInit(rotatedSessionId));
    // Give the consumption loop microtasks time to settle the deferred.
    await tick(10);

    // Emit result so the turn finalizes cleanly before the afterEach close().
    queryHarness.emitMessage(successResult(rotatedSessionId));

    // The turn must resolve within the bounded window — a hang here means the
    // deferred was orphaned (pre-FIX-2 behaviour).
    const handle = await Promise.race([sendPromise, timeoutRejecting(2000)]);
    expect(handle).toBeDefined();
    // The session must have converged on the provider-confirmed ID from
    // system.init. Asserted on the session's own view rather than the handle:
    // the handle is stamped with whichever ID was current when sendMessage()
    // read it, which is not the invariant under test here.
    expect(connector.getConfirmedAdapterSessionId()).toBe(rotatedSessionId);

    // Allow result processing to complete so afterEach teardown is fast.
    await tick(30);
  }, 5_000);

  it.each([
    [
      'unmodeled top-level type (command_lifecycle)',
      {
        type: 'command_lifecycle',
        subtype: 'started',
        command_uuid: randomUUID(),
        uuid: randomUUID(),
        session_id: randomUUID(),
      } as unknown as SDKMessage,
    ],
    [
      'unmodeled system subtype (hook_started — empirically observed pre-init traffic from CLI 2.1.x)',
      {
        type: 'system',
        subtype: 'hook_started',
        uuid: randomUUID(),
        session_id: randomUUID(),
      } as unknown as SDKMessage,
    ],
  ])(
    'unknown SDK message (%s) before system.init does not block the consumption loop (guards FIX 1)',
    async (_label: string, preinitMessage: SDKMessage) => {
      // Phase 1 — establish the initial session (no responseSchema).
      await connector.initialize();

      const rotatedSessionId = randomUUID();

      // Subscribe to sdk.event BEFORE the rotation so we capture all emitted
      // payloads including the pre-init traffic.
      const sdkEvents: unknown[] = [];
      const unsubscribe = MakaioBus.on(ClaudeCodeConnectorSubjects.sdk.event, (ctx) => {
        sdkEvents.push(ctx.payload);
      });

      try {
        // Phase 2 — trigger rotation via responseSchema.
        const sendPromise = connector.sendMessage(TEST_MESSAGE, { responseSchema: ROTATION_SCHEMA });

        // Allow rotation to complete and the new consumption loop to start.
        await tick(30);

        // Phase 3 — emit pre-init traffic BEFORE system.init.
        //
        // isKnownSdkMessageForRouting returns false for both shapes, so
        // handleSdkMessage routes them through emitSdkEvent and returns early.
        //
        // Pre-FIX-1: the connector's emitSdkEvent callback awaited the blocking
        // getAdapterSessionId() which parks the drain on the unresolved deferred.
        // system.init can only arrive via that same drain → permanent deadlock.
        //
        // Post-FIX-1: emitSdkEvent uses the non-blocking getConfirmedSessionId()
        // so the drain is not parked and continues to deliver system.init.
        queryHarness.emitMessage(preinitMessage);
        // Allow the consumption loop to process the pre-init message.
        await tick(10);

        // Phase 4 — emit system.init.  If pre-init traffic deadlocked the drain,
        // this message never arrives and sendPromise never resolves.
        queryHarness.emitMessage(systemInit(rotatedSessionId));
        await tick(10);

        // Emit result so the turn finalizes cleanly.
        queryHarness.emitMessage(successResult(rotatedSessionId));

        // The turn must resolve within the bounded window — a hang here means
        // the pre-init message parked the consumption loop (pre-FIX-1 behaviour).
        const handle = await Promise.race([sendPromise, timeoutRejecting(2000)]);
        expect(handle).toBeDefined();

        // The pre-init payload must have been forwarded to the sdk.event subject
        // rather than silently dropped.  We match only on `type` (and `subtype`
        // when present) to stay resilient against connector-injected metadata.
        expect(sdkEvents).toContainEqual(expect.objectContaining({ type: preinitMessage.type }));

        // Allow result processing to complete so afterEach teardown is fast.
        await tick(30);
      } finally {
        unsubscribe();
      }
    },
    5_000,
  );

  it('rejects sendMessage when the rotated query iterator fails before system.init', async () => {
    await connector.initialize();

    const sendPromise = connector.sendMessage(TEST_MESSAGE, { responseSchema: ROTATION_SCHEMA });
    await tick(30);

    queryHarness.failIterator(new Error('SDK transport failed'));

    await expect(Promise.race([sendPromise, timeoutRejecting(2000)])).rejects.toThrow('SDK transport failed');
  }, 5_000);

  it('preserves an immediate iterator failure for a later session-ID waiter', async () => {
    await connector.initialize();
    queryHarness.failNextIterator(new Error('SDK transport failed before session-ID lookup'));

    const sendPromise = connector.sendMessage(TEST_MESSAGE, { responseSchema: ROTATION_SCHEMA });

    await expect(Promise.race([sendPromise, timeoutRejecting(2000)])).rejects.toThrow('Session not initialized');
    await expect(Promise.race([connector.getAdapterSessionId(), timeoutRejecting(2000)])).rejects.toThrow(
      'SDK transport failed before session-ID lookup',
    );
  }, 5_000);

  it('rejects sendMessage when the rotated query ends before system.init', async () => {
    await connector.initialize();
    const sendPromise = connector.sendMessage(TEST_MESSAGE, { responseSchema: ROTATION_SCHEMA });
    await tick(30);

    queryHarness.endIterator();

    await expect(Promise.race([sendPromise, timeoutRejecting(2000)])).rejects.toThrow(
      'Claude query ended before terminal result',
    );
  }, 5_000);

  it('preserves a synchronous query construction error for a later session-ID waiter', async () => {
    await connector.initialize();
    queryHarness.failNextQuery(new Error('SDK query construction failed'));

    await expect(connector.sendMessage(TEST_MESSAGE, { responseSchema: ROTATION_SCHEMA })).rejects.toThrow(
      'SDK query construction failed',
    );
    expect(connector.getConfirmedAdapterSessionId()).toBeUndefined();
    await expect(Promise.race([connector.getAdapterSessionId(), timeoutRejecting(2000)])).rejects.toThrow(
      'SDK query construction failed',
    );
  }, 5_000);

  it('preserves a query-options construction error for a later session-ID waiter', async () => {
    await connector.initialize();
    Object.defineProperty(connector, 'createToolApprovalHandler', {
      value: () => {
        throw new Error('SDK query options construction failed');
      },
    });

    await expect(connector.sendMessage(TEST_MESSAGE, { responseSchema: ROTATION_SCHEMA })).rejects.toThrow(
      'SDK query options construction failed',
    );
    await expect(Promise.race([connector.getAdapterSessionId(), timeoutRejecting(2000)])).rejects.toThrow(
      'SDK query options construction failed',
    );
  }, 5_000);

  it('retries a failed schema rotation from the provider-confirmed session ID', async () => {
    await connector.initialize();
    const confirmedSessionId = randomUUID();
    queryHarness.emitMessage(systemInit(confirmedSessionId));
    await tick(10);

    queryHarness.failNextQuery(new Error('SDK query construction failed'));
    await expect(connector.sendMessage(TEST_MESSAGE, { responseSchema: ROTATION_SCHEMA })).rejects.toThrow(
      'SDK query construction failed',
    );
    expect(connector.getConfirmedAdapterSessionId()).toBe(confirmedSessionId);

    const retryPromise = connector.sendMessage(TEST_MESSAGE, { responseSchema: ROTATION_SCHEMA });
    await tick(10);

    expect(queryHarness.queryFn.mock.calls.at(-1)?.[0].options.resume).toBe(confirmedSessionId);
    queryHarness.emitMessage(systemInit(confirmedSessionId));
    await retryPromise;
  }, 5_000);

  it('rejects sendMessage when the rotated query closes before system.init', async () => {
    await connector.initialize();

    const sendPromise = connector.sendMessage(TEST_MESSAGE, { responseSchema: ROTATION_SCHEMA });
    await tick(30);

    queryHarness.endIteratorOnNextInterrupt();
    await connector.close();

    await expect(Promise.race([sendPromise, timeoutRejecting(2000)])).rejects.toThrow(
      'Claude query interrupted before terminal result',
    );
  }, 5_000);
});
