/**
 * Tests for the provider-session movement observer and the ownership authority
 * it settles through.
 *
 * `agent.adapterSession.moved` is an observation. What it implies for durable
 * currency is decided by `session.ownership.settleMovement`, in one storage
 * transaction, against the announcing agent's own row — and reaches the session
 * row only as the mirror of the designated lead's currency.
 *
 * Everything here runs against the real memory backends through the real bus:
 * the seam under test is exactly the observer→authority→storage path, so a mock
 * anywhere in it would assert nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  AgentSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  resolveResumableAdapterSessionId,
  type AgentRole,
  type IMakaioSession,
} from '@makaio/contracts';
import { MakaioSessionService } from '../session-service.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { resolveSessionResumeIdentity } from '../session-resume-identity.js';
import { registerMemorySessionBackends, resetBusHandlers, waitForAsync } from './shared.js';

const ADAPTER_NAME = 'claude-code';
const MACHINE_ID = 'currency-test-machine';

describe('session adapter-session movement observer', () => {
  let sessionService: MakaioSessionService;
  let storageCleanups: Array<() => void> = [];

  beforeEach(async () => {
    resetBusHandlers();
    storageCleanups = [...registerMemorySessionBackends(MakaioBus), registerMemorySessionEventStorage(MakaioBus)];
    sessionService = new MakaioSessionService(MakaioBus, { machineId: MACHINE_ID });
    await sessionService.init();
  });

  afterEach(() => {
    sessionService?.destroy();
    for (let index = storageCleanups.length - 1; index >= 0; index -= 1) storageCleanups[index]?.();
    storageCleanups = [];
  });

  /**
   * Create a session and attach one agent to it.
   *
   * A lead is designated through the ownership seam — the only writer of the
   * designation — so the fixture establishes exactly the state a reserving
   * start would.
   * @param sessionId - Makaio session ID to create
   * @param agentId - Agent identifier to attach
   * @param options - Agent role, adapter type name, and origin provider session ID
   */
  async function seedSessionWithAgent(
    sessionId: string,
    agentId: string,
    options?: { role?: AgentRole; adapterName?: string; adapterSessionId?: string },
  ): Promise<void> {
    const role = options?.role ?? 'lead';
    const adapterName = options?.adapterName ?? ADAPTER_NAME;
    const now = Date.now();

    const existing = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    if (existing.session === null) await MakaioBus.request(SessionSubjects.create, { sessionId });
    if (role === 'lead' && options?.adapterSessionId !== undefined) {
      // The session row's write-once origin comes from the same start as the
      // lead's, exactly as it does in production. Without it the designation's
      // mirror would resolve the lead's `inherited` currency against a session
      // that has no origin, and publish it as `confirmed` — a different
      // starting state than any of these tests is about.
      const created = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      const session = created.session ?? existing.session;
      if (session === null) throw new Error(`Session not found after create: ${sessionId}`);
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: { ...session, adapterName, adapterSessionId: options.adapterSessionId },
      });
    }
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: {
        agentId,
        adapterId: `${adapterName}-instance`,
        adapterName,
        sessionId,
        adapterSessionId: options?.adapterSessionId,
        runtimeOwner: { machineId: MACHINE_ID, instanceId: sessionService.requireOwnershipInstanceId() },
        role,
        status: 'idle',
        createdAt: now,
        lastActivityAt: now,
      },
    });
    if (role === 'lead') await designateLead(sessionId, agentId);
    await waitForAsync();
  }

  /**
   * Designate an agent as the session's lead through the reserving transaction.
   * @param sessionId - Makaio session ID
   * @param agentId - Agent to designate
   */
  async function designateLead(sessionId: string, agentId: string): Promise<void> {
    const result = await MakaioBus.request(SessionSubjects.ownership.reserveStart, {
      sessionId,
      agentId,
      adapterId: `${ADAPTER_NAME}-instance`,
      adapterName: ADAPTER_NAME,
      ownerInstanceId: sessionService.requireOwnershipInstanceId(),
      role: 'lead',
      resumeProviderSessionId: null,
      claimToken: crypto.randomUUID(),
      expectedLeadAgentId: null,
    });
    expect(result.outcome).toBe('reserved');
  }

  /**
   * Emit a provider-session movement on the seam and let the settle chain drain.
   *
   * Reports the announcement exactly as a producer sees it: the seam is
   * advisory, so a refusal comes back as `false` rather than as a throw — this
   * is `emitAdapterSessionMoved`'s contract, reproduced here so the tests read
   * the same bit the producer's delivery markers are keyed on.
   * @param sessionId - Makaio session ID
   * @param agentId - Emitting agent identifier
   * @param movement - Confirmation flag, optional confirmed ID, optional adapter name
   * @returns Whether the announcement was acknowledged as durably settled
   */
  async function emitMovement(
    sessionId: string,
    agentId: string,
    movement: { confirmed: boolean; adapterSessionId?: string; adapterName?: string },
  ): Promise<boolean> {
    const adapterName = movement.adapterName ?? ADAPTER_NAME;
    const delivered = await MakaioBus.emit(AgentSubjects.adapterSession.moved, {
      agentId,
      adapterId: `${adapterName}-instance`,
      adapterName,
      machineId: MACHINE_ID,
      ownerInstanceId: sessionService.requireOwnershipInstanceId(),
      sessionId,
      confirmed: movement.confirmed,
      ...(movement.adapterSessionId !== undefined && { adapterSessionId: movement.adapterSessionId }),
    }).then(
      () => true,
      () => false,
    );
    await waitForAsync();
    return delivered;
  }

  /**
   * Load the stored session, failing the test when it is absent.
   * @param sessionId - Makaio session ID
   * @returns Stored session record
   */
  async function loadSession(sessionId: string): Promise<IMakaioSession> {
    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(session).not.toBeNull();
    return session as IMakaioSession;
  }

  /**
   * Read one agent's settled currency from the ownership seam.
   * @param agentId - Agent whose currency is read
   * @returns The settled currency snapshot
   */
  async function loadAgentCurrency(agentId: string) {
    const { ownership } = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
    expect(ownership).not.toBeNull();
    return ownership!.currency;
  }

  it('treats a never-moved session as inherited currency', async () => {
    const sessionId = 'currency-inherited';
    await seedSessionWithAgent(sessionId, 'agent-inherited', { adapterSessionId: 'origin-id' });

    const session = await loadSession(sessionId);
    expect(session.currentAdapterSessionIdState ?? 'inherited').toBe('inherited');
    expect(session.currentAdapterSessionId).toBeUndefined();
    expect(resolveSessionResumeIdentity(session)).toEqual({
      adapterSessionId: 'origin-id',
      movedUnconfirmed: false,
    });
  });

  it('walks inherited → moved → confirmed on both the agent row and its session mirror', async () => {
    const sessionId = 'currency-transitions';
    const agentId = 'agent-transitions';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    await emitMovement(sessionId, agentId, { confirmed: false });
    expect(await loadAgentCurrency(agentId)).toMatchObject({
      currentAdapterSessionIdState: 'moved',
      currentAdapterSessionId: null,
    });
    const moved = await loadSession(sessionId);
    expect(moved.currentAdapterSessionIdState).toBe('moved');
    expect(moved.currentAdapterSessionId).toBeUndefined();
    // Origin identity is untouched — it is import provenance, not currency.
    expect(moved.adapterSessionId).toBe('origin-id');
    expect(resolveSessionResumeIdentity(moved)).toEqual({
      adapterSessionId: undefined,
      movedUnconfirmed: true,
    });

    await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'rotated-id' });
    expect(await loadAgentCurrency(agentId)).toMatchObject({
      currentAdapterSessionIdState: 'confirmed',
      currentAdapterSessionId: 'rotated-id',
    });
    const confirmed = await loadSession(sessionId);
    expect(confirmed.currentAdapterSessionIdState).toBe('confirmed');
    expect(confirmed.currentAdapterSessionId).toBe('rotated-id');
    expect(confirmed.adapterSessionId).toBe('origin-id');
    expect(resolveSessionResumeIdentity(confirmed)).toEqual({
      adapterSessionId: 'rotated-id',
      movedUnconfirmed: false,
    });
  });

  it('re-confirms a later movement over an earlier confirmation, retiring the old key', async () => {
    const sessionId = 'currency-reconfirm';
    const agentId = 'agent-reconfirm';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'first-id' });
    await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'second-id' });

    const session = await loadSession(sessionId);
    expect(session.currentAdapterSessionId).toBe('second-id');
    expect(session.currentAdapterSessionIdState).toBe('confirmed');

    // The predecessor key is retired by the confirmed successor, so exactly one
    // generation is left holding exactly the current provider session.
    const { claims } = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
      machineId: MACHINE_ID,
    });
    expect(claims.map((claim) => claim.providerSessionId)).toEqual(['second-id']);
  });

  it('records a member’s movement on its own row and leaves the session mirror to the lead', async () => {
    const sessionId = 'currency-member';
    await seedSessionWithAgent(sessionId, 'lead-agent', { adapterSessionId: 'origin-id' });
    await seedSessionWithAgent(sessionId, 'member-agent', { role: 'member' });

    await emitMovement(sessionId, 'member-agent', { confirmed: true, adapterSessionId: 'member-id' });

    // The member's own currency settled — the old handler dropped this movement
    // entirely, because the session row was the only row it could write.
    expect(await loadAgentCurrency('member-agent')).toMatchObject({
      currentAdapterSessionIdState: 'confirmed',
      currentAdapterSessionId: 'member-id',
    });
    // The session row still describes the lead's conversation.
    const session = await loadSession(sessionId);
    expect(session.currentAdapterSessionIdState ?? 'inherited').toBe('inherited');
    expect(session.currentAdapterSessionId).toBeUndefined();
  });

  it('ignores movements whose adapterName does not match the agent row', async () => {
    const sessionId = 'currency-foreign-adapter';
    const agentId = 'agent-foreign-adapter';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    const delivered = await emitMovement(sessionId, agentId, {
      confirmed: true,
      adapterSessionId: 'codex-id',
      adapterName: 'codex-mcp',
    });

    // Refused, and said so: nothing recorded the movement, so the producer must
    // keep it rather than retire it as delivered.
    expect(delivered).toBe(false);
    expect(await loadAgentCurrency(agentId)).toMatchObject({ currentAdapterSessionIdState: 'inherited' });
    const session = await loadSession(sessionId);
    expect(session.currentAdapterSessionIdState ?? 'inherited').toBe('inherited');
  });

  it('ignores a confirmed movement that carries no session ID', async () => {
    const sessionId = 'currency-confirmed-without-id';
    const agentId = 'agent-confirmed-without-id';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    await emitMovement(sessionId, agentId, { confirmed: true });

    expect(await loadAgentCurrency(agentId)).toMatchObject({ currentAdapterSessionIdState: 'inherited' });
  });

  it('ignores an unconfirmed movement that carries a session ID', async () => {
    const sessionId = 'currency-unconfirmed-with-id';
    const agentId = 'agent-unconfirmed-with-id';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    // Establish a confirmed currency the malformed payload could destroy.
    await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'rotated-id' });

    // The seam's pair invariant rejects `confirmed: false` together with an ID,
    // but `bus.emit` skips schema validation in production, so an SDK publisher
    // working from the refinement-free protocol manifest can deliver it. It must
    // not be reinterpreted as a plain demotion: that would void a live key on a
    // payload whose intent is undefined.
    await emitMovement(sessionId, agentId, { confirmed: false, adapterSessionId: 'unacknowledged-successor' });

    expect(await loadAgentCurrency(agentId)).toMatchObject({
      currentAdapterSessionIdState: 'confirmed',
      currentAdapterSessionId: 'rotated-id',
    });
  });

  it('settles a repeat announcement idempotently instead of minting a second generation', async () => {
    const sessionId = 'currency-repeat';
    const agentId = 'agent-repeat';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });
    await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'rotated-id' });

    const before = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
    await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'rotated-id' });
    const after = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });

    // Repeats are the normal case — the seam re-announces on every unconfirmed
    // dispatch and every confirmation — so nothing may move: not the revision,
    // not the fence, and not the generation holding the key.
    expect(after.ownership?.revision).toBe(before.ownership?.revision);
    expect(after.ownership?.currencyFence).toBe(before.ownership?.currencyFence);
    expect(after.ownership?.claims.map((claim) => claim.claimToken)).toEqual(
      before.ownership?.claims.map((claim) => claim.claimToken),
    );
  });

  it('settles two concurrently emitted movements in receipt order without a lost race', async () => {
    // Case 12: `emit` runs handlers concurrently across producer chains, so
    // without per-agent serialization these two interleave between the
    // authority's revision read and its transaction, and the later one is
    // refused with `currency-changed`.
    const sessionId = 'currency-serialized';
    const agentId = 'agent-serialized';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    // Counted, not replaced: a higher-priority handler that sets no result lets
    // the real storage handler run behind it. One transaction per announcement
    // is the observable consequence of serialization — an interleaved pair
    // costs the loser a `currency-changed` refusal and a third transaction.
    let settleTransactions = 0;
    const spy = MakaioBus.on(
      SessionOwnershipStorageSubjects.settleMovement,
      () => {
        settleTransactions += 1;
      },
      { priority: 100 },
    );
    try {
      await Promise.all([
        MakaioBus.emit(AgentSubjects.adapterSession.moved, {
          agentId,
          adapterId: `${ADAPTER_NAME}-instance`,
          adapterName: ADAPTER_NAME,
          machineId: MACHINE_ID,
          ownerInstanceId: sessionService.requireOwnershipInstanceId(),
          sessionId,
          confirmed: true,
          adapterSessionId: 'first-id',
        }),
        MakaioBus.emit(AgentSubjects.adapterSession.moved, {
          agentId,
          adapterId: `${ADAPTER_NAME}-instance`,
          adapterName: ADAPTER_NAME,
          machineId: MACHINE_ID,
          ownerInstanceId: sessionService.requireOwnershipInstanceId(),
          sessionId,
          confirmed: true,
          adapterSessionId: 'second-id',
        }),
      ]);
      await waitForAsync(50);
    } finally {
      spy();
    }

    expect(settleTransactions).toBe(2);
    // Receipt order decides: the second announcement is the one standing.
    const currency = await loadAgentCurrency(agentId);
    expect(resolveResumableAdapterSessionId(currency)).toBe('second-id');
    const session = await loadSession(sessionId);
    expect(session.currentAdapterSessionId).toBe('second-id');
  });

  it('ignores movements without a session ID', async () => {
    const sessionId = 'currency-no-session';
    const agentId = 'agent-no-session';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    await MakaioBus.emit(AgentSubjects.adapterSession.moved, {
      agentId,
      adapterId: `${ADAPTER_NAME}-instance`,
      adapterName: ADAPTER_NAME,
      machineId: MACHINE_ID,
      ownerInstanceId: sessionService.requireOwnershipInstanceId(),
      adapterSessionId: 'orphan-id',
      confirmed: true,
    });
    await waitForAsync();

    expect(await loadAgentCurrency(agentId)).toMatchObject({ currentAdapterSessionIdState: 'inherited' });
  });
  it('keeps the announcement pending until the settlement is durable', async () => {
    // Duty 1 of the movement seam: a resolved `emit` means the currency write
    // already happened. The producer orders the dispatch that abandons the old
    // provider session behind that resolution, so an observer that resolved
    // first and settled afterwards would hand it a window in which a concurrent
    // reader still sees the superseded currency.
    const sessionId = 'currency-pending';
    const agentId = 'agent-pending';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    let settledDuringEmit: string | null | undefined;
    const announced = MakaioBus.emit(AgentSubjects.adapterSession.moved, {
      agentId,
      adapterId: `${ADAPTER_NAME}-instance`,
      adapterName: ADAPTER_NAME,
      machineId: MACHINE_ID,
      ownerInstanceId: sessionService.requireOwnershipInstanceId(),
      sessionId,
      confirmed: true,
      adapterSessionId: 'settled-before-resolve',
    }).then(async () => {
      settledDuringEmit = resolveResumableAdapterSessionId(await loadAgentCurrency(agentId));
    });

    // Nothing is asserted about the row before the emit resolves — that is the
    // point of the ordering, not an implementation detail to pin.
    await announced;
    expect(settledDuringEmit).toBe('settled-before-resolve');
  });

  it('reports a refused settlement as undelivered and leaves the currency alone', async () => {
    // The refusal that matters most: another generation owns the key, so the
    // authority answers `already-claimed` and writes nothing. Acknowledging it
    // would let the producer advance its delivery markers past a movement no row
    // carries — and for a stable identity no later movement would arrive to
    // re-establish it.
    const sessionId = 'currency-refused';
    const agentId = 'agent-refused';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    const holderSessionId = 'currency-refused-holder';
    const holderAgentId = 'agent-refused-holder';
    await seedSessionWithAgent(holderSessionId, holderAgentId, { adapterSessionId: 'origin-holder' });
    const claimed = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
      machineId: MACHINE_ID,
      adapterId: `${ADAPTER_NAME}-instance`,
      adapterName: ADAPTER_NAME,
      providerSessionId: 'contested-id',
      sessionId: holderSessionId,
      agentId: holderAgentId,
      claimToken: crypto.randomUUID(),
      ownerInstance: { instanceId: 'currency-refused-holder-instance' },
      topology: 'shared-machine',
    });
    expect(claimed.outcome).toBe('claimed');

    const delivered = await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'contested-id' });

    expect(delivered).toBe(false);
    expect(await loadAgentCurrency(agentId)).toMatchObject({ currentAdapterSessionIdState: 'inherited' });
  });
  it('settles a movement announced by the instance the agent row names', async () => {
    // The Path-A shape: the row is persisted with its adapter instance before
    // the dispatch, so a movement announced during the start names exactly the
    // instance the row does and must be recorded.
    const sessionId = 'currency-same-instance';
    const agentId = 'agent-same-instance';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    const delivered = await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'started-id' });

    expect(delivered).toBe(true);
    expect(resolveResumableAdapterSessionId(await loadAgentCurrency(agentId))).toBe('started-id');
  });

  it('drops a stale movement from a prior runtime owner', async () => {
    // A rehydrate moves the agent onto a new instance and persists it. The old
    // connector can still be alive long enough to announce, and that
    // announcement describes a provider session the agent stopped being current
    // on — settling it would write the abandoned identity back over the one the
    // rehydrate just established.
    const sessionId = 'currency-stale-instance';
    const agentId = 'agent-stale-instance';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });
    expect(await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'resumed-id' })).toBe(true);

    // The agent is rebound to a newer incarnation of the same adapter runtime.
    await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
      agentId,
      runtimeOwner: { machineId: MACHINE_ID, instanceId: 'new-owner-instance' },
    });

    const delivered = await MakaioBus.emit(AgentSubjects.adapterSession.moved, {
      agentId,
      adapterId: `${ADAPTER_NAME}-instance`,
      adapterName: ADAPTER_NAME,
      machineId: MACHINE_ID,
      ownerInstanceId: 'old-owner-instance',
      sessionId,
      confirmed: true,
      adapterSessionId: 'abandoned-id',
    }).then(
      () => true,
      () => false,
    );
    await waitForAsync();

    expect(delivered).toBe(false);
    // Unchanged: the currency still names what the live instance resumed.
    expect(resolveResumableAdapterSessionId(await loadAgentCurrency(agentId))).toBe('resumed-id');
  });
});
