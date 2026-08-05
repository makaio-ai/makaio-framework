/**
 * Tests for tri-state resume-currency resolution in the attach handler.
 *
 * `session.adapterSessionId` is write-once origin provenance; the resume
 * currency lives in `currentAdapterSessionId` + `currentAdapterSessionIdState`.
 * The attach handler must resolve that currency once and use the same value in
 * all three roles: locality evaluation, live-writer detection, and the resume
 * target handed to `adapter.startAgent`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { buildDeterministicAdapterId } from '../../../adapter-runtime/index.js';
import {
  ATTACH_TEST_IDS,
  createAttachHandlerContext,
  holdProviderSession,
  type AttachHandlerTestContext,
  type StartAgentRequestPayload,
} from './shared.js';

describe('registerAttachHandler - resume currency', () => {
  const { sessionId, adapterName } = ATTACH_TEST_IDS;
  const originAdapterSessionId = 'origin-provider-session';
  const currentAdapterSessionId = 'current-provider-session';
  const localMachine = 'local-machine';

  let ctx: AttachHandlerTestContext;

  beforeEach(() => {
    ctx = createAttachHandlerContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  /**
   * Register the session, startAgent, and attach handlers for one currency state.
   * @param currency - Currency columns to place on the mock session
   * @returns Captured `adapter.startAgent` request payloads
   */
  function setupCurrencyTest(currency: {
    currentAdapterSessionId?: string;
    currentAdapterSessionIdState?: 'inherited' | 'moved' | 'confirmed';
  }): StartAgentRequestPayload[] {
    ctx.trackUnsubscribe(
      ctx.registerSessionGetHandler(
        ctx.createMockSession({
          machineId: localMachine,
          adapterName,
          adapterSessionId: originAdapterSessionId,
          ...currency,
        }),
      ),
    );
    const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
    ctx.trackUnsubscribe(unsubscribe);
    ctx.trackUnsubscribe(ctx.registerHandler(localMachine));
    return receivedRequests;
  }

  /**
   * Take a generation for a foreign agent on one provider session.
   *
   * The reservation is what decides occupancy now, so the fixture takes a real
   * claim instead of mocking a liveness probe the attach path never asks.
   * @param heldAdapterSessionId - Provider session the foreign generation owns
   */
  async function holdSession(heldAdapterSessionId: string): Promise<void> {
    await holdProviderSession({
      sessionId,
      agentId: 'existing-agent',
      adapterId: buildDeterministicAdapterId(localMachine, adapterName),
      adapterName,
      machineId: localMachine,
      providerSessionId: heldAdapterSessionId,
    });
  }

  /** Issue the attach request under test. */
  async function attach(): Promise<void> {
    await MakaioBus.request(SessionSubjects.agent.attach, {
      sessionId,
      agent: { kind: 'adapter', adapterName },
    });
  }

  it('resumes the origin identity when the currency is inherited', async () => {
    const requests = setupCurrencyTest({ currentAdapterSessionIdState: 'inherited' });

    await attach();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mode: 'resume', adapterSessionId: originAdapterSessionId });
  });

  it('treats an absent currency state as inherited', async () => {
    const requests = setupCurrencyTest({});

    await attach();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mode: 'resume', adapterSessionId: originAdapterSessionId });
  });

  it('resumes the confirmed current identity, not the origin identity', async () => {
    const requests = setupCurrencyTest({
      currentAdapterSessionIdState: 'confirmed',
      currentAdapterSessionId,
    });

    await attach();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mode: 'resume', adapterSessionId: currentAdapterSessionId });
  });

  it('degrades to adapter-session-moved when the identity moved unconfirmed', async () => {
    const requests = setupCurrencyTest({ currentAdapterSessionIdState: 'moved' });

    await attach();

    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('mode');
    expect(requests[0]).not.toHaveProperty('adapterSessionId');
    expect(requests[0].sessionContext?.nativeLocality).toEqual({
      kind: 'degrade',
      reason: 'adapter-session-moved',
    });
  });

  it('emits locality.degraded for a moved identity', async () => {
    const captured: Array<{ intent: string; verdictKind: string; reason?: string }> = [];
    ctx.trackUnsubscribe(
      MakaioBus.on(SessionSubjects.locality.degraded, ({ payload }) => {
        captured.push(payload);
      }),
    );
    setupCurrencyTest({ currentAdapterSessionIdState: 'moved' });

    await attach();
    // The degrade event is fire-and-forget; give the emit a bounded window.
    const deadline = Date.now() + 500;
    while (captured.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      intent: 'resume',
      verdictKind: 'degrade',
      reason: 'adapter-session-moved',
    });
  });

  it('keys occupancy on the confirmed current identity', async () => {
    // A generation on the *origin* ID is irrelevant once the currency moved on.
    const requests = setupCurrencyTest({
      currentAdapterSessionIdState: 'confirmed',
      currentAdapterSessionId,
    });
    await holdSession(originAdapterSessionId);

    await attach();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mode: 'resume', adapterSessionId: currentAdapterSessionId });
  });

  it('degrades when another generation holds the confirmed current identity', async () => {
    const requests = setupCurrencyTest({
      currentAdapterSessionIdState: 'confirmed',
      currentAdapterSessionId,
    });
    await holdSession(currentAdapterSessionId);

    await attach();

    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('mode');
    expect(requests[0].sessionContext?.nativeLocality).toEqual({
      kind: 'degrade',
      reason: 'agent-already-started',
    });
  });

  it('resolves currency from a fresh read, not the validation snapshot', async () => {
    // A movement persisted while attach was still resolving selection, adapter,
    // and provider must be seen by locality resolution: the first `session.get`
    // is the validation snapshot, every later one serves the moved row.
    const confirmedRow = ctx.createMockSession({
      machineId: localMachine,
      adapterName,
      adapterSessionId: originAdapterSessionId,
      currentAdapterSessionIdState: 'confirmed',
      currentAdapterSessionId,
    });
    const movedRow = ctx.createMockSession({
      machineId: localMachine,
      adapterName,
      adapterSessionId: originAdapterSessionId,
      currentAdapterSessionIdState: 'moved',
    });
    ctx.seedSessionRow(confirmedRow);
    let reads = 0;
    ctx.trackUnsubscribe(
      MakaioBus.on(SessionSubjects.get, (context) => {
        reads += 1;
        context.setResult({ session: reads === 1 ? confirmedRow : movedRow });
      }),
    );
    const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
    ctx.trackUnsubscribe(unsubscribe);
    ctx.trackUnsubscribe(ctx.registerHandler(localMachine));

    await attach();

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]).not.toHaveProperty('adapterSessionId');
    expect(receivedRequests[0].sessionContext?.nativeLocality).toEqual({
      kind: 'degrade',
      reason: 'adapter-session-moved',
    });
  });

  it('degrades to no-adapter-session when confirmed currency carries no ID', async () => {
    // Storage forbids this pair via a check constraint, but a resolved currency
    // is authoritative: it must never silently fall back to the origin identity
    // if a non-DB backend ever produces the pair.
    const requests = setupCurrencyTest({ currentAdapterSessionIdState: 'confirmed' });

    await attach();

    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('mode');
    expect(requests[0].sessionContext?.nativeLocality).toEqual({
      kind: 'degrade',
      reason: 'no-adapter-session',
    });
  });
});
