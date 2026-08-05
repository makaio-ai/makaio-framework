/**
 * Tests for the provider-session movement seam.
 *
 * Covers the two adapters-core producers that do not go through cold
 * rehydration: confirmed-identity tracking (provider confirmation and connector
 * swaps both land in {@link ConfirmedAdapterSessionTracker}) and the
 * pre-confirmation rotation signal raised by {@link AgentTurnExecutor}.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type AdapterSessionMoved } from '@makaio/contracts';
import {
  ConfirmedAdapterSessionTracker,
  providerCommittedAdapterSessionId,
} from '../agent-adapter-session-movement.js';
import { AgentTurnExecutor } from '../agent-turn-executor.js';
import type { AIAgentConnector } from '../../connector/index.js';
import { MessageHandle } from '../../message-handle/index.js';
import type { SendMessageRequestPayload } from '../types.js';

vi.mock('@makaio/hooks', () => ({
  runPreUserMessageHooks: vi.fn(async (payload: { message: unknown; sessionContext?: unknown }) => ({
    message: payload.message,
    sessionContext: payload.sessionContext,
  })),
  runPostUserMessageHooks: vi.fn(async () => {}),
}));

const HOST_BASE = {
  agentId: 'agent-1',
  adapterId: 'adapter-1',
  adapterName: 'claude-code',
  sessionId: 'session-1',
};

/**
 * Subscribe to the movement seam and collect every announced payload.
 * @returns Collected payloads and an unsubscribe callback
 */
function captureMovements(): { movements: AdapterSessionMoved[]; unsubscribe: () => void } {
  const movements: AdapterSessionMoved[] = [];
  const unsubscribe = MakaioBus.on(AgentSubjects.adapterSession.moved, ({ payload }) => {
    movements.push(payload);
  });
  return { movements, unsubscribe };
}

/** Yield to the macrotask queue so any queued emission work completes. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ConfirmedAdapterSessionTracker', () => {
  let capture: { movements: AdapterSessionMoved[]; unsubscribe: () => void };

  beforeEach(() => {
    capture?.unsubscribe();
    capture = captureMovements();
  });

  it('announces the first confirmed identity', async () => {
    const host = { ...HOST_BASE };
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, host);

    await tracker.record('provider-1');
    await settle();

    expect(capture.movements).toHaveLength(1);
    expect(capture.movements[0]).toMatchObject({
      agentId: HOST_BASE.agentId,
      adapterId: HOST_BASE.adapterId,
      adapterName: HOST_BASE.adapterName,
      sessionId: HOST_BASE.sessionId,
      adapterSessionId: 'provider-1',
      confirmed: true,
    });
    expect(tracker.lastKnownAdapterSessionId).toBe('provider-1');
  });

  it('does not re-announce an unchanged identity', async () => {
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });

    await tracker.record('provider-1');
    await tracker.record('provider-1');
    await tracker.record('provider-1');
    await settle();

    expect(capture.movements).toHaveLength(1);
  });

  it('announces each genuine identity change', async () => {
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });

    await tracker.record('provider-1');
    await tracker.record('provider-2');
    await settle();

    expect(capture.movements.map((movement) => movement.adapterSessionId)).toEqual(['provider-1', 'provider-2']);
  });

  it('re-points an armed resume target onto the confirmed identity', async () => {
    const host = { ...HOST_BASE, resumeAdapterSessionId: 'start-time-target' };
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, host);

    await tracker.record('provider-1');

    expect(host.resumeAdapterSessionId).toBe('provider-1');
  });

  it('never introduces a resume target on an agent that had none', async () => {
    const host: { resumeAdapterSessionId?: string } & typeof HOST_BASE = { ...HOST_BASE };
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, host);

    await tracker.record('provider-1');

    expect(host.resumeAdapterSessionId).toBeUndefined();
  });

  it('drops an abandoned resume target so no later generation can resume it', async () => {
    const host = { ...HOST_BASE, resumeAdapterSessionId: 'start-time-target' };
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, host);

    await tracker.recordUnconfirmedMove();

    expect(host.resumeAdapterSessionId).toBeUndefined();
  });

  it('re-points inheritance onto the first identity confirmed after an abandonment', async () => {
    // The reason the inheritance policy is tracked separately from the datum: a
    // dropped target must not end inheritance, or continuity would be lost for
    // good the moment the provider does confirm a successor.
    const host = { ...HOST_BASE, resumeAdapterSessionId: 'start-time-target' };
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, host);

    await tracker.recordUnconfirmedMove();
    await tracker.record('provider-successor');

    expect(host.resumeAdapterSessionId).toBe('provider-successor');
  });

  it('still introduces no resume target after an abandonment on a fresh-born agent', async () => {
    // Complement of the case above: the abandonment must not be mistaken for
    // inheritance. An agent that never had a target keeps fresh-swap semantics.
    const host: { resumeAdapterSessionId?: string } & typeof HOST_BASE = { ...HOST_BASE };
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, host);

    await tracker.recordUnconfirmedMove();
    await tracker.record('provider-1');

    expect(host.resumeAdapterSessionId).toBeUndefined();
  });

  it('arms inheritance from an explicit resume decision on a fresh-born agent', async () => {
    // The re-arming path: a swap that explicitly resumes a session hands the
    // decision here, so the confirmations that follow keep tracking that thread
    // instead of leaving the adopted target frozen at the requested ID.
    const host: { resumeAdapterSessionId?: string } & typeof HOST_BASE = { ...HOST_BASE };
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, host);

    tracker.adoptResumeTarget('explicitly-resumed');
    expect(host.resumeAdapterSessionId).toBe('explicitly-resumed');

    await tracker.record('provider-rotated-on-resume');

    expect(host.resumeAdapterSessionId).toBe('provider-rotated-on-resume');
  });

  it('takes inheritance away for an explicit fresh decision', async () => {
    const host = { ...HOST_BASE, resumeAdapterSessionId: 'start-time-target' };
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, host);

    tracker.adoptResumeTarget(undefined);
    await tracker.record('provider-1');

    expect(host.resumeAdapterSessionId).toBeUndefined();
  });

  it('ignores an unresolved identity', async () => {
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });

    await tracker.record(undefined);
    await settle();

    expect(capture.movements).toHaveLength(0);
  });

  it('keeps the cached identity when a later resolution comes back unresolved', async () => {
    // Payload enrichment records `undefined` whenever the connector has no
    // confirmed session at that instant. That must not erase the last confirmed
    // identity: enrichment keeps reporting it until a successor is confirmed,
    // and a cleared cache would make the next confirmation look like a
    // first-ever identity instead of a movement.
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });

    await tracker.record('provider-1');
    await tracker.record(undefined);
    await settle();

    expect(tracker.lastKnownAdapterSessionId).toBe('provider-1');
    expect(capture.movements.map((movement) => movement.adapterSessionId)).toEqual(['provider-1']);
  });

  it('retries a failed announcement on the next record of the same identity', async () => {
    // A rejecting consumer must not count as delivered: the cache still serves
    // enrichment immediately, but the change guard deduplicates against the
    // acknowledged announcement — for a stable identity no later movement
    // would arrive, so the retry has to come from re-recording the same ID.
    let failNext = true;
    const consumer = MakaioBus.on(AgentSubjects.adapterSession.moved, async () => {
      if (failNext) throw new Error('storage write failed');
    });
    try {
      const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });

      await tracker.record('provider-1');
      // The failed announcement still reaches other consumers; the cache
      // serves enrichment regardless of delivery.
      expect(tracker.lastKnownAdapterSessionId).toBe('provider-1');
      expect(capture.movements).toHaveLength(1);

      failNext = false;
      await tracker.record('provider-1');
      await tracker.record('provider-1');
      await settle();

      // Exactly one retry: the acknowledged announcement re-arms the change
      // guard, so the third record deduplicates again.
      expect(capture.movements.map((movement) => movement.adapterSessionId)).toEqual(['provider-1', 'provider-1']);
    } finally {
      consumer();
    }
  });

  it('announces an unconfirmed movement without an identity', async () => {
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });

    await tracker.recordUnconfirmedMove();
    await settle();

    expect(capture.movements).toHaveLength(1);
    expect(capture.movements[0].confirmed).toBe(false);
    expect(capture.movements[0].adapterSessionId).toBeUndefined();
  });

  it('retries a rejected unconfirmed movement as unconfirmed, not as the abandoned identity', async () => {
    // The rotation signal that raises an unconfirmed movement is one-shot: the
    // dispatch consumes the resume target, so nothing re-triggers the producer.
    // Enrichment is the only retry clock, and until a successor is confirmed it
    // still resolves the *abandoned* identity from the cache — re-announcing that
    // as confirmed would restore currency on the session the agent just left.
    let failNext = false;
    const consumer = MakaioBus.on(AgentSubjects.adapterSession.moved, async () => {
      if (failNext) throw new Error('storage write failed');
    });
    try {
      const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });
      // Delivered, so the row now advertises provider-1 as the resume currency.
      await tracker.record('provider-1');
      failNext = true;
      await tracker.recordUnconfirmedMove();

      failNext = false;
      // Enrichment on the next emitted event, still resolving the abandoned ID.
      await tracker.record('provider-1');
      await settle();

      // Two unconfirmed announcements: the rejected original and the retry.
      // Counting them is what distinguishes a real retry from the rejected
      // announcement simply being the last one on the bus.
      const unconfirmed = capture.movements.filter((movement) => movement.confirmed === false);
      expect(unconfirmed).toHaveLength(2);
      expect(unconfirmed[1].adapterSessionId).toBeUndefined();
      // Crucially not a confirmed re-assert of the abandoned provider-1.
      expect(capture.movements.filter((movement) => movement.confirmed === true)).toHaveLength(1);
    } finally {
      consumer();
    }
  });

  it('re-drives an undelivered movement even when the connector resolves nothing', async () => {
    // An agent whose connector reports no confirmed session is exactly the one
    // whose unconfirmed movement is still outstanding, so the `undefined`
    // enrichment call must not short-circuit the retry.
    let failNext = true;
    const consumer = MakaioBus.on(AgentSubjects.adapterSession.moved, async () => {
      if (failNext) throw new Error('storage write failed');
    });
    try {
      const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });
      await tracker.recordUnconfirmedMove();
      expect(capture.movements).toHaveLength(1);

      failNext = false;
      await tracker.record(undefined);
      await settle();

      expect(capture.movements).toHaveLength(2);
      expect(capture.movements[1].confirmed).toBe(false);
    } finally {
      consumer();
    }
  });

  it('supersedes an undelivered unconfirmed movement once a successor is confirmed', async () => {
    // The retry must not outlive its purpose: a confirmed successor is a newer
    // statement about the same agent, so it replaces the parked movement instead
    // of both being delivered.
    let failNext = false;
    const consumer = MakaioBus.on(AgentSubjects.adapterSession.moved, async () => {
      if (failNext) throw new Error('storage write failed');
    });
    try {
      const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });
      await tracker.record('provider-1');
      failNext = true;
      await tracker.recordUnconfirmedMove();

      failNext = false;
      await tracker.record('provider-2');
      // Two further enrichment calls must not re-announce anything.
      await tracker.record('provider-2');
      await tracker.record('provider-2');
      await settle();

      const last = capture.movements[capture.movements.length - 1];
      expect(last).toMatchObject({ adapterSessionId: 'provider-2', confirmed: true });
      expect(capture.movements.filter((movement) => movement.confirmed === false)).toHaveLength(1);
      expect(capture.movements.filter((movement) => movement.adapterSessionId === 'provider-2')).toHaveLength(1);
    } finally {
      consumer();
    }
  });

  it('supersedes an undelivered movement when the caller settles the successor', async () => {
    // The caller-settled twin of the case above, and it supersedes for the same
    // reason plus a sharper one. A parked movement is re-driven by the next
    // enrichment call, which would hand it to the movement observer — the second
    // settle producer a caller-settled movement exists to remove — and an
    // unconfirmed one re-announced after the settlement would blank the very
    // currency that settlement wrote.
    let failNext = false;
    const consumer = MakaioBus.on(AgentSubjects.adapterSession.moved, async () => {
      if (failNext) throw new Error('storage write failed');
    });
    try {
      const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });
      await tracker.record('provider-1');
      failNext = true;
      await tracker.recordUnconfirmedMove();
      failNext = false;
      capture.movements.length = 0;

      // The caller settles the successor itself, so nothing is announced for it.
      await tracker.record('provider-2', true);
      expect(capture.movements).toEqual([]);

      // And the parked movement is gone rather than waiting for the next event:
      // enrichment re-records the identity, then reports none, and neither
      // re-drives it.
      await tracker.record('provider-2');
      await tracker.record(undefined);
      await settle();

      expect(capture.movements).toEqual([]);
      expect(tracker.lastKnownAdapterSessionId).toBe('provider-2');
    } finally {
      consumer();
    }
  });

  it('resolves only after the seam consumers finished applying the movement', async () => {
    // The ordering guarantee the currency seam depends on: a producer that
    // awaits the announcement can rely on the session row already carrying the
    // new currency, so a resume started afterwards cannot read the superseded
    // identity.
    let applied = false;
    const consumer = MakaioBus.on(AgentSubjects.adapterSession.moved, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      applied = true;
    });
    try {
      const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });
      await tracker.record('provider-1');
      expect(applied).toBe(true);
    } finally {
      consumer();
    }
  });

  it('re-delivers a movement whose announcement a sibling consumer rejected', async () => {
    // `bus.emit` rejects at the first handler rejection while slower siblings
    // keep running, so a rejecting sibling costs duty 2's ordering: the
    // applying consumer is still in flight when the producer resumes. What
    // bounds that is the retry anchor — the parked movement is re-announced on
    // the next enrichment call, and the change-guarded consumer applies it
    // idempotently, so the end state converges either way.
    let applied = 0;
    let failNext = true;
    const slowConsumer = MakaioBus.on(AgentSubjects.adapterSession.moved, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      applied++;
    });
    const rejectingSibling = MakaioBus.on(AgentSubjects.adapterSession.moved, async () => {
      if (failNext) throw new Error('sibling observer failed');
    });
    try {
      const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });

      await tracker.record('provider-1');
      // The honest residual: the announcement reported failure before the
      // applying consumer settled, so this movement is not ordered.
      expect(applied).toBe(0);

      failNext = false;
      await new Promise((resolve) => setTimeout(resolve, 30));
      await tracker.record('provider-1');
      // The retry is ordered again: every local consumer acknowledged it.
      expect(applied).toBe(2);

      // And the acknowledged retry re-arms the change guard.
      await tracker.record('provider-1');
      await settle();
      expect(capture.movements).toHaveLength(2);
    } finally {
      rejectingSibling();
      slowConsumer();
    }
  });

  it('omits sessionId for an agent that runs outside a session', async () => {
    const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE, sessionId: undefined });

    await tracker.record('provider-1');
    await settle();

    expect(capture.movements[0].sessionId).toBeUndefined();
  });
});

describe('providerCommittedAdapterSessionId', () => {
  it('reports the connector identity when no rotation is pending', () => {
    const committed = providerCommittedAdapterSessionId({
      getConfirmedAdapterSessionId: () => 'provider-1',
      movesProviderSessionOnSuppressedResume: () => false,
    });

    expect(committed).toBe('provider-1');
  });

  it('withholds a seeded identity the connector would rotate away from', () => {
    // The window payload enrichment samples into: the connector still reports
    // the armed resume target as authoritative, while a dispatch that declines
    // native resume — possibly already in flight, since the connector consumes
    // its target inside queue processing — abandons exactly that target. A
    // sampler that took the reported ID would announce the abandoned session as
    // confirmed currency.
    const committed = providerCommittedAdapterSessionId({
      getConfirmedAdapterSessionId: () => 'seeded-resume-target',
      movesProviderSessionOnSuppressedResume: () => true,
    });

    expect(committed).toBeUndefined();
  });

  it('reports nothing when the connector holds no identity', () => {
    const committed = providerCommittedAdapterSessionId({
      getConfirmedAdapterSessionId: () => undefined,
      movesProviderSessionOnSuppressedResume: () => false,
    });

    expect(committed).toBeUndefined();
  });

  it('leaves an unconfirmed movement as the tracker state when sampled in the window', async () => {
    // End-to-end at the seam: the executor announces the rotation, then the
    // enrichment that runs on `user_message.sent` samples the connector. With
    // the sampling rule applied, nothing re-announces the abandoned target.
    const capture = captureMovements();
    try {
      const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });
      const connector = {
        getConfirmedAdapterSessionId: () => 'seeded-resume-target',
        movesProviderSessionOnSuppressedResume: () => true,
      };

      await tracker.recordUnconfirmedMove();
      await tracker.record(providerCommittedAdapterSessionId(connector));
      await settle();

      expect(capture.movements).toHaveLength(1);
      expect(capture.movements[0].confirmed).toBe(false);
      expect(tracker.lastKnownAdapterSessionId).toBeUndefined();
    } finally {
      capture.unsubscribe();
    }
  });

  it('announces the successor once the provider confirms it', async () => {
    // Counter-check: after `system.init` the connector reports no pending
    // rotation, so the sampler passes the confirmed ID through unchanged.
    const capture = captureMovements();
    try {
      const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, { ...HOST_BASE });
      let rotationPending = true;
      const connector = {
        getConfirmedAdapterSessionId: () => (rotationPending ? 'seeded-resume-target' : 'provider-fresh'),
        movesProviderSessionOnSuppressedResume: () => rotationPending,
      };

      await tracker.recordUnconfirmedMove();
      await tracker.record(providerCommittedAdapterSessionId(connector));
      rotationPending = false;
      await tracker.record(providerCommittedAdapterSessionId(connector));
      await settle();

      expect(capture.movements).toHaveLength(2);
      expect(capture.movements[1]).toMatchObject({ adapterSessionId: 'provider-fresh', confirmed: true });
    } finally {
      capture.unsubscribe();
    }
  });
});

describe('AgentTurnExecutor pre-confirmation rotation signal', () => {
  /**
   * Dispatch one `sendMessage` turn and observe the rotation signal.
   *
   * The rotation signal is deliberately slow so the recorded step order proves
   * the executor waits for it rather than merely starting it.
   * @param options - Native-resume decision, armed resume target, connector
   *   confirmation state, and whether the connector reports a pending rotation
   * @returns How often the rotation signal fired, and the order of rotation
   *   signal completion versus connector dispatch
   */
  async function dispatchTurn(options: {
    useNativeResume: boolean;
    hasResumeTarget: boolean;
    confirmedAdapterSessionId: string | undefined;
    movesProviderSessionOnSuppressedResume?: boolean;
  }): Promise<{ signals: number; steps: string[] }> {
    const steps: string[] = [];
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      getConfirmedAdapterSessionId: () => options.confirmedAdapterSessionId,
      movesProviderSessionOnSuppressedResume: () => options.movesProviderSessionOnSuppressedResume ?? false,
      sendMessage: (async () => {
        steps.push('dispatch');
        return new MessageHandle('m-1', { role: 'user', blocks: [{ type: 'text', content: 'hello' }] }, 'enqueue');
      }) as AIAgentConnector['sendMessage'],
    };
    let signals = 0;
    const executor = new AgentTurnExecutor({
      agentId: HOST_BASE.agentId,
      adapterId: HOST_BASE.adapterId,
      globalBus: MakaioBus,
      getConnector: () => connector as AIAgentConnector,
      shouldUseNativeResume: () => options.useNativeResume,
      hasResumeTarget: () => options.hasResumeTarget,
      setPendingStartMode: vi.fn(),
      onNativeResumeSuppressed: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        signals += 1;
        steps.push('rotation-recorded');
      },
      onMessageHandle: async () => {},
    });

    const payload: SendMessageRequestPayload = {
      agentId: HOST_BASE.agentId,
      adapterId: HOST_BASE.adapterId,
      message: 'hello',
    };
    await executor.executeSendMessage(payload);
    return { signals, steps };
  }

  it('fires when an armed resume target is discarded before confirmation', async () => {
    const { signals } = await dispatchTurn({
      useNativeResume: false,
      hasResumeTarget: true,
      confirmedAdapterSessionId: undefined,
    });
    expect(signals).toBe(1);
  });

  it('records the rotation before dispatching the turn that abandons the session', async () => {
    // Ordering invariant: the session row must stop advertising the abandoned
    // provider session before the provider is asked to start a new one.
    const { steps } = await dispatchTurn({
      useNativeResume: false,
      hasResumeTarget: true,
      confirmedAdapterSessionId: undefined,
    });
    expect(steps).toEqual(['rotation-recorded', 'dispatch']);
  });

  it('does not fire when the turn resumes natively', async () => {
    const { signals } = await dispatchTurn({
      useNativeResume: true,
      hasResumeTarget: true,
      confirmedAdapterSessionId: undefined,
    });
    expect(signals).toBe(0);
  });

  it('does not fire without an armed resume target', async () => {
    const { signals } = await dispatchTurn({
      useNativeResume: false,
      hasResumeTarget: false,
      confirmedAdapterSessionId: undefined,
    });
    expect(signals).toBe(0);
  });

  it('does not fire once the connector confirmed its own session', async () => {
    // After confirmation the generation holds continuity: the suppression flag
    // no longer moves the provider session.
    const { signals } = await dispatchTurn({
      useNativeResume: false,
      hasResumeTarget: true,
      confirmedAdapterSessionId: 'provider-1',
    });
    expect(signals).toBe(0);
  });

  it('fires when the connector reports a rotation despite advertising a seeded session ID', async () => {
    // The interleaving a reported session ID hides: an idle Claude resume agent
    // has seeded its session with the resume target and reports that target as
    // authoritative, yet `system.init` has not arrived, so this dispatch rotates
    // to a fresh provider session. Inferring "no movement" from the reported ID
    // left the session row advertising the abandoned resume target.
    const { signals, steps } = await dispatchTurn({
      useNativeResume: false,
      hasResumeTarget: true,
      confirmedAdapterSessionId: 'seeded-resume-target',
      movesProviderSessionOnSuppressedResume: true,
    });
    expect(signals).toBe(1);
    expect(steps).toEqual(['rotation-recorded', 'dispatch']);
  });

  it('does not fire when a connector advertising a session ID reports no rotation', async () => {
    // Complement of the case above: connectors that inject history without
    // abandoning their provider session must not have their currency cleared.
    const { signals } = await dispatchTurn({
      useNativeResume: false,
      hasResumeTarget: true,
      confirmedAdapterSessionId: 'provider-1',
      movesProviderSessionOnSuppressedResume: false,
    });
    expect(signals).toBe(0);
  });
});
