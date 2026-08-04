/**
 * Tests for session-row adapter-session currency tracking.
 *
 * The session row splits provider-session provenance from resume currency:
 * `adapterSessionId` is the write-once origin identity, while
 * `currentAdapterSessionId` + `currentAdapterSessionIdState` track where the
 * provider session actually is. The currency handler consumes the
 * `agent.adapterSession.moved` seam and maintains that pair.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, type AgentRole, type IMakaioSession } from '@makaio/contracts';
import { MakaioSessionService } from '../session-service.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { registerMemoryAgentStorage } from '../storage/agent-memory-handler.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { resolveSessionResumeIdentity } from '../session-resume-identity.js';
import { resetBusHandlers, waitForAsync } from './shared.js';

const ADAPTER_NAME = 'claude-code';

describe('session adapter-session currency', () => {
  let sessionService: MakaioSessionService;
  let sessionStorageCleanup: () => void;
  let agentStorageCleanup: () => void;
  let eventStorageCleanup: () => void;

  beforeEach(async () => {
    resetBusHandlers();
    sessionStorageCleanup = registerMemorySessionStorage(MakaioBus);
    agentStorageCleanup = registerMemoryAgentStorage(MakaioBus);
    eventStorageCleanup = registerMemorySessionEventStorage(MakaioBus);
    sessionService = new MakaioSessionService(MakaioBus);
    await sessionService.init();
  });

  afterEach(() => {
    sessionService?.destroy();
    eventStorageCleanup();
    agentStorageCleanup();
    sessionStorageCleanup();
  });

  /**
   * Create a session with one agent in the given role, establishing the
   * session's adapter identity (and `leadAgentId` for lead agents) through the
   * real `session.agent.added` handler.
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
    const adapterSessionId = options?.adapterSessionId;
    const now = Date.now();

    await MakaioBus.request(SessionSubjects.create, { sessionId });
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: {
        agentId,
        adapterId: `${adapterName}-instance`,
        adapterName,
        sessionId,
        adapterSessionId,
        role,
        status: 'idle',
        createdAt: now,
        lastActivityAt: now,
      },
    });
    await MakaioBus.emit(SessionSubjects.agent.added, {
      sessionId,
      agentId,
      adapterId: `${adapterName}-instance`,
      adapterName,
      adapterSessionId,
      role,
    });
    await waitForAsync();
  }

  /**
   * Emit a provider-session movement on the seam and let handlers settle.
   * @param sessionId - Makaio session ID
   * @param agentId - Emitting agent identifier
   * @param movement - Confirmation flag, optional confirmed ID, optional adapter name
   */
  async function emitMovement(
    sessionId: string,
    agentId: string,
    movement: { confirmed: boolean; adapterSessionId?: string; adapterName?: string },
  ): Promise<void> {
    const adapterName = movement.adapterName ?? ADAPTER_NAME;
    await MakaioBus.emit(AgentSubjects.adapterSession.moved, {
      agentId,
      adapterId: `${adapterName}-instance`,
      adapterName,
      sessionId,
      confirmed: movement.confirmed,
      ...(movement.adapterSessionId !== undefined && { adapterSessionId: movement.adapterSessionId }),
    });
    await waitForAsync();
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

  it('walks inherited → moved → confirmed', async () => {
    const sessionId = 'currency-transitions';
    const agentId = 'agent-transitions';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    await emitMovement(sessionId, agentId, { confirmed: false });
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
    const confirmed = await loadSession(sessionId);
    expect(confirmed.currentAdapterSessionIdState).toBe('confirmed');
    expect(confirmed.currentAdapterSessionId).toBe('rotated-id');
    expect(confirmed.adapterSessionId).toBe('origin-id');
    expect(resolveSessionResumeIdentity(confirmed)).toEqual({
      adapterSessionId: 'rotated-id',
      movedUnconfirmed: false,
    });
  });

  it('re-confirms a later movement over an earlier confirmation', async () => {
    const sessionId = 'currency-reconfirm';
    const agentId = 'agent-reconfirm';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'first-id' });
    await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'second-id' });

    const session = await loadSession(sessionId);
    expect(session.currentAdapterSessionId).toBe('second-id');
    expect(session.currentAdapterSessionIdState).toBe('confirmed');
  });

  it('ignores movements from a non-lead agent', async () => {
    const sessionId = 'currency-non-lead';
    await seedSessionWithAgent(sessionId, 'lead-agent', { adapterSessionId: 'origin-id' });
    await seedMemberAgent(sessionId, 'member-agent');

    await emitMovement(sessionId, 'member-agent', { confirmed: true, adapterSessionId: 'member-id' });

    const session = await loadSession(sessionId);
    expect(session.currentAdapterSessionIdState ?? 'inherited').toBe('inherited');
    expect(session.currentAdapterSessionId).toBeUndefined();
  });

  it('ignores movements whose adapterName does not match the session identity', async () => {
    const sessionId = 'currency-foreign-adapter';
    const agentId = 'agent-foreign-adapter';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    await emitMovement(sessionId, agentId, {
      confirmed: true,
      adapterSessionId: 'codex-id',
      adapterName: 'codex-mcp',
    });

    const session = await loadSession(sessionId);
    expect(session.currentAdapterSessionIdState ?? 'inherited').toBe('inherited');
  });

  it('ignores a confirmed movement that carries no session ID', async () => {
    const sessionId = 'currency-confirmed-without-id';
    const agentId = 'agent-confirmed-without-id';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    await emitMovement(sessionId, agentId, { confirmed: true });

    const session = await loadSession(sessionId);
    expect(session.currentAdapterSessionIdState ?? 'inherited').toBe('inherited');
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
    // not be reinterpreted as a plain unconfirmed move: that would clear the
    // session's resume currency on a payload whose intent is undefined.
    await emitMovement(sessionId, agentId, { confirmed: false, adapterSessionId: 'unacknowledged-successor' });

    const session = await loadSession(sessionId);
    expect(session.currentAdapterSessionIdState).toBe('confirmed');
    expect(session.currentAdapterSessionId).toBe('rotated-id');
  });

  it('does not write when the currency is already at the announced value', async () => {
    const sessionId = 'currency-change-guard';
    const agentId = 'agent-change-guard';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });
    await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'rotated-id' });

    let updateCount = 0;
    const spy = MakaioBus.on(
      SessionStorageSubjects.update,
      () => {
        updateCount += 1;
      },
      { priority: 100 },
    );
    try {
      await emitMovement(sessionId, agentId, { confirmed: true, adapterSessionId: 'rotated-id' });
      expect(updateCount).toBe(0);

      await emitMovement(sessionId, agentId, { confirmed: false });
      expect(updateCount).toBe(1);

      // Repeated unconfirmed announcements are the normal case while the
      // provider has not confirmed yet — they must stay no-ops.
      await emitMovement(sessionId, agentId, { confirmed: false });
      expect(updateCount).toBe(1);
    } finally {
      spy();
    }
  });

  it('ignores movements without a session ID', async () => {
    const sessionId = 'currency-no-session';
    const agentId = 'agent-no-session';
    await seedSessionWithAgent(sessionId, agentId, { adapterSessionId: 'origin-id' });

    await MakaioBus.emit(AgentSubjects.adapterSession.moved, {
      agentId,
      adapterId: `${ADAPTER_NAME}-instance`,
      adapterName: ADAPTER_NAME,
      adapterSessionId: 'orphan-id',
      confirmed: true,
    });
    await waitForAsync();

    const session = await loadSession(sessionId);
    expect(session.currentAdapterSessionIdState ?? 'inherited').toBe('inherited');
  });

  /**
   * Persist a member agent without emitting `session.agent.added`, so the
   * session's lead agent and adapter identity stay owned by the lead.
   * @param sessionId - Makaio session ID
   * @param agentId - Member agent identifier
   */
  async function seedMemberAgent(sessionId: string, agentId: string): Promise<void> {
    const now = Date.now();
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: {
        agentId,
        adapterId: `${ADAPTER_NAME}-instance`,
        adapterName: ADAPTER_NAME,
        sessionId,
        role: 'member',
        status: 'idle',
        createdAt: now,
        lastActivityAt: now,
      },
    });
    await waitForAsync();
  }
});
