/**
 * Tests for adapter-session-ID reconciliation on agent.started.
 *
 * When a fork child is started idle, adapterSessionId is persisted as undefined.
 * On first message dispatch the enriched agent.started event carries the
 * provider-confirmed ID. The reconciliation handler back-fills agent storage
 * and session storage.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, type AgentRole } from '@makaio/contracts';
import { MakaioSessionService } from '../session-service.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { designateSessionLead } from '../ownership/index.js';
import { registerMemorySessionBackends, resetBusHandlers, waitForAsync } from './shared.js';

describe('adapter-session-ID reconciliation', () => {
  let sessionService: MakaioSessionService;
  let storageCleanups: Array<() => void> = [];

  beforeEach(() => {
    resetBusHandlers();
    // **A designated composition**, because that is the only one this handler's
    // rule can be stated in: the session-level backfill follows the lead, and a
    // host without the ownership backend designates none. Session, agent and
    // ownership rows share one state, as they do in every host that owns
    // sessions.
    storageCleanups = [...registerMemorySessionBackends(MakaioBus), registerMemorySessionEventStorage(MakaioBus)];
    sessionService = new MakaioSessionService(MakaioBus);
  });

  afterEach(() => {
    sessionService?.destroy();
    for (let index = storageCleanups.length - 1; index >= 0; index -= 1) storageCleanups[index]?.();
    storageCleanups = [];
  });

  // ===========================================================================
  // Shared scaffolding helpers
  // ===========================================================================

  /**
   * Persist an agent record in storage and optionally emit `session.agent.added`.
   *
   * The agent is seeded with `adapterSessionId` set to the given value (defaults
   * to `undefined`, simulating a fork idle-start).  Pass `emitAdded: false` for
   * secondary / foreign agents that should not influence session-level metadata.
   * @param sessionId - Makaio session ID the agent belongs to
   * @param agentId - Unique agent identifier
   * @param adapterId - Adapter instance identifier
   * @param adapterName - Adapter type name (e.g. `'claude-code'`)
   * @param role - Agent role within the session (`'lead'` or `'member'`)
   * @param opts - Optional overrides: `adapterSessionId` sets a pre-confirmed adapter session ID
   *   (default: `undefined`); `emitAdded` controls whether `SessionSubjects.agent.added` is
   *   emitted (default: `true`)
   */
  async function seedAgent(
    sessionId: string,
    agentId: string,
    adapterId: string,
    adapterName: string,
    role: AgentRole,
    opts?: { adapterSessionId?: string; emitAdded?: boolean },
  ): Promise<void> {
    const adapterSessionId = opts?.adapterSessionId;
    const emitAdded = opts?.emitAdded ?? true;
    const now = Date.now();

    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: {
        agentId,
        adapterId,
        adapterName,
        sessionId,
        adapterSessionId,
        role,
        status: 'idle',
        createdAt: now,
        lastActivityAt: now,
      },
    });

    if (emitAdded) {
      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId,
        agentId,
        adapterId,
        adapterName,
        adapterSessionId,
        role,
      });
    }

    await waitForAsync();
  }

  /**
   * Emit `agent.started` with a provider-confirmed session ID and wait for
   * async handlers to settle.
   * @param agentId - Agent identifier
   * @param adapterId - Adapter instance identifier
   * @param adapterName - Adapter type name (e.g. `'claude-code'`)
   * @param adapterSessionId - Provider-confirmed native session ID
   * @param sessionId - Makaio session ID
   * @param opts - Optional overrides: `model` sets the model identifier (default: `'test-model'`);
   *   `cwd` sets the working directory (default: `'/tmp'`)
   */
  async function emitAgentStarted(
    agentId: string,
    adapterId: string,
    adapterName: string,
    adapterSessionId: string,
    sessionId: string,
    opts?: { model?: string; cwd?: string },
  ): Promise<void> {
    await MakaioBus.emit(AgentSubjects.started, {
      agentId,
      adapterId,
      adapterName,
      adapterSessionId,
      sessionId,
      model: opts?.model ?? 'test-model',
      cwd: opts?.cwd ?? '/tmp',
      startMode: 'fresh',
    });
    await waitForAsync();
  }

  /**
   * Seed a session and an agent with undefined adapterSessionId,
   * simulating the fork idle-start state.
   * @param sessionId - Makaio session ID
   * @param agentId - Agent identifier
   * @param adapterId - Adapter identifier
   */
  async function seedIdleForkState(sessionId: string, agentId: string, adapterId: string): Promise<void> {
    await sessionService.init();

    // Create session
    await MakaioBus.request(SessionSubjects.create, { sessionId });

    // Persist agent with undefined adapterSessionId (fork idle start) and emit agent.added
    await seedAgent(sessionId, agentId, adapterId, 'test-adapter', 'lead');
  }

  // ===========================================================================
  // Tests
  // ===========================================================================

  it('back-fills agent storage on first confirmed agent.started', async () => {
    const sessionId = 'session-recon-1';
    const agentId = 'agent-recon-1';
    const adapterId = 'adapter-recon-1';
    const confirmedId = 'provider-confirmed-session-id';

    await seedIdleForkState(sessionId, agentId, adapterId);

    // Verify agent has no adapterSessionId yet
    const before = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
    expect(before.agent?.adapterSessionId).toBeUndefined();

    // Simulate first agent.started with confirmed ID (emitted by enrichPayload)
    await emitAgentStarted(agentId, adapterId, 'test-adapter', confirmedId, sessionId);

    // Agent storage must now hold the confirmed ID
    const after = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
    expect(after.agent?.adapterSessionId).toBe(confirmedId);
  });

  it('back-fills session storage for the lead agent', async () => {
    const sessionId = 'session-recon-2';
    const agentId = 'agent-recon-2';
    const adapterId = 'adapter-recon-2';
    const confirmedId = 'provider-confirmed-session-id-2';

    await seedIdleForkState(sessionId, agentId, adapterId);

    // Verify session has no adapterSessionId
    const sessionBefore = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(sessionBefore.session?.adapterSessionId).toBeUndefined();

    await emitAgentStarted(agentId, adapterId, 'test-adapter', confirmedId, sessionId);

    // Session storage must now hold the confirmed ID
    const sessionAfter = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(sessionAfter.session?.adapterSessionId).toBe(confirmedId);
  });

  it('is idempotent — second agent.started does not overwrite', async () => {
    const sessionId = 'session-recon-3';
    const agentId = 'agent-recon-3';
    const adapterId = 'adapter-recon-3';
    const confirmedId = 'first-confirmed-id';

    await seedIdleForkState(sessionId, agentId, adapterId);

    // First confirmation
    await emitAgentStarted(agentId, adapterId, 'test-adapter', confirmedId, sessionId);

    // Second agent.started with a different ID (e.g. turn 2)
    await emitAgentStarted(agentId, adapterId, 'test-adapter', 'different-id', sessionId);

    // Agent storage retains the first confirmed ID (idempotent)
    const agent = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
    expect(agent.agent?.adapterSessionId).toBe(confirmedId);

    // Session storage also retains the first confirmed ID
    const session = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(session.session?.adapterSessionId).toBe(confirmedId);
  });

  it('does not overwrite session adapterSessionId once it is already set', async () => {
    const sessionId = 'session-recon-4';
    const leadAgentId = 'lead-agent';
    const memberAgentId = 'member-agent';
    const adapterId = 'adapter-recon-4';

    await sessionService.init();

    // Create session
    await MakaioBus.request(SessionSubjects.create, { sessionId });

    // Lead agent with confirmed ID
    await seedAgent(sessionId, leadAgentId, adapterId, 'test-adapter', 'lead', {
      adapterSessionId: 'lead-confirmed-id',
    });

    // Member agent with undefined adapterSessionId (fork child)
    await seedAgent(sessionId, memberAgentId, adapterId, 'test-adapter', 'member');

    // Session should have lead's adapterSessionId already set
    const sessionBefore = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(sessionBefore.session?.adapterSessionId).toBe('lead-confirmed-id');

    // Member agent gets confirmed — session already has an ID, so it must not change
    await emitAgentStarted(memberAgentId, adapterId, 'test-adapter', 'member-confirmed-id', sessionId);

    // Member agent storage is updated
    const memberAgent = await MakaioBus.request(AgentStorageSubjects.get, { agentId: memberAgentId });
    expect(memberAgent.agent?.adapterSessionId).toBe('member-confirmed-id');

    // Session adapterSessionId must NOT change (write-once: first writer wins)
    const sessionAfter = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(sessionAfter.session?.adapterSessionId).toBe('lead-confirmed-id');
  });

  it('refuses a member as first writer, and takes the lead that follows it', async () => {
    // The exception this used to pin — "no lead named yet, so whoever confirms
    // first speaks for the session" — is unreachable as a *signal*: a start that
    // carries an initial message emits `agent.started` from inside its own start
    // call, before that start's `agent.added` names anyone lead. So an absent
    // lead is the ordinary state of an ordinary start, and reading it as "this
    // host cannot designate" hands the session's resume target to whichever
    // agent's first turn happens to land first.
    const sessionId = 'session-recon-5';
    const memberAgentId = 'member-first-agent';
    const leadAgentId = 'lead-after-member';
    const adapterId = 'adapter-recon-5';

    await sessionService.init();
    await MakaioBus.request(SessionSubjects.create, { sessionId });

    // A member on the session's adapter, confirming before any lead exists.
    await seedAgent(sessionId, memberAgentId, adapterId, 'test-adapter', 'member');
    await emitAgentStarted(memberAgentId, adapterId, 'test-adapter', 'member-first-confirmed-id', sessionId);

    // Its own row is reconciled — each agent owns its provider session.
    const memberAgent = await MakaioBus.request(AgentStorageSubjects.get, { agentId: memberAgentId });
    expect(memberAgent.agent?.adapterSessionId).toBe('member-first-confirmed-id');
    // The session's is not: that column is the lead's.
    const afterMember = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(afterMember.session?.adapterSessionId).toBeUndefined();

    // The lead arrives and confirms — and the session takes its key.
    await seedAgent(sessionId, leadAgentId, adapterId, 'test-adapter', 'lead');
    await emitAgentStarted(leadAgentId, adapterId, 'test-adapter', 'lead-confirmed-id', sessionId);

    const afterLead = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(afterLead.session?.adapterSessionId).toBe('lead-confirmed-id');
  });

  it('skips session-level backfill when the emitting agent belongs to a different adapter', async () => {
    const sessionId = 'session-recon-6';
    const leadAgentId = 'lead-agent-6';
    const foreignAgentId = 'foreign-agent-6';
    const leadAdapterId = 'adapter-lead-6';
    const foreignAdapterId = 'adapter-foreign-6';

    await sessionService.init();
    await MakaioBus.request(SessionSubjects.create, { sessionId });

    // Lead agent added with adapterSessionId: undefined (idle fork)
    // This sets session.adapterName = 'claude-code' via registerAgentAddedHandler.
    await seedAgent(sessionId, leadAgentId, leadAdapterId, 'claude-code', 'lead');

    // Foreign member agent on a different adapter — no agent.added to avoid
    // overwriting session-level adapterName already set by the lead.
    await seedAgent(sessionId, foreignAgentId, foreignAdapterId, 'codex-mcp', 'member', {
      emitAdded: false,
    });

    // Verify session has adapterName set but no adapterSessionId
    const sessionBefore = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(sessionBefore.session?.adapterName).toBe('claude-code');
    expect(sessionBefore.session?.adapterSessionId).toBeUndefined();

    // Foreign agent confirms first — its provider session ID belongs to codex-mcp,
    // NOT to the session's claude-code adapter. Must NOT backfill session.
    await emitAgentStarted(foreignAgentId, foreignAdapterId, 'codex-mcp', 'codex-provider-session-42', sessionId, {
      model: 'gpt-4.1',
    });

    // Agent-level backfill IS applied (each agent owns its own ID)
    const foreignAgent = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: foreignAgentId,
    });
    expect(foreignAgent.agent?.adapterSessionId).toBe('codex-provider-session-42');

    // Session-level adapterSessionId must remain unset — foreign adapter skipped
    const sessionAfter = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(sessionAfter.session?.adapterSessionId).toBeUndefined();
    expect(sessionAfter.session?.adapterName).toBe('claude-code');
  });

  it('skips a lead that runs on a sibling instance of the session’s own adapter', async () => {
    // The instance half of the same rule, and it needs the *lead* to be the one
    // mismatching — a member is refused for being a member. A replacement lead
    // is exactly that: the designation moves to it, while the session's adapter
    // identity stays where the first lead established it. Its provider session
    // is minted inside its own instance, and two instances of one adapter name
    // are two machines, so it names a conversation this session's identity does
    // not resolve to.
    const sessionId = 'session-recon-sibling';
    const firstLeadId = 'lead-instance-a';
    const replacementLeadId = 'lead-instance-b';
    const sessionAdapterId = 'adapter-instance-a';
    const siblingAdapterId = 'adapter-instance-b';

    await sessionService.init();
    await MakaioBus.request(SessionSubjects.create, { sessionId });

    // The session's identity: one adapter name, on instance A.
    await seedAgent(sessionId, firstLeadId, sessionAdapterId, 'claude-code', 'lead');
    // The replacement takes the designation; the identity stays put.
    await seedAgent(sessionId, replacementLeadId, siblingAdapterId, 'claude-code', 'lead');
    const before = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(before.session?.leadAgentId).toBe(replacementLeadId);
    expect(before.session?.adapterId).toBe(sessionAdapterId);

    await emitAgentStarted(replacementLeadId, siblingAdapterId, 'claude-code', 'sibling-provider-session', sessionId);

    const afterSibling = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(afterSibling.session?.adapterSessionId).toBeUndefined();
    expect(afterSibling.session?.adapterId).toBe(sessionAdapterId);
  });

  it('backfills session-level ID when matching-adapter agent confirms', async () => {
    const sessionId = 'session-recon-7';
    const foreignAgentId = 'foreign-agent-7';
    const matchingAgentId = 'matching-agent-7';
    const adapterId = 'adapter-match-7';
    const foreignAdapterId = 'adapter-foreign-7';

    await sessionService.init();
    await MakaioBus.request(SessionSubjects.create, { sessionId });

    // First agent.added sets session.adapterName = 'claude-code'
    await seedAgent(sessionId, matchingAgentId, adapterId, 'claude-code', 'lead');

    // Foreign member agent added (different adapter) — no agent.added to preserve
    // session-level adapterName already set by the matching agent.
    await seedAgent(sessionId, foreignAgentId, foreignAdapterId, 'codex-mcp', 'member', {
      emitAdded: false,
    });

    // Foreign agent confirms first — skipped by ownership guard
    await emitAgentStarted(foreignAgentId, foreignAdapterId, 'codex-mcp', 'codex-session-ignored', sessionId, {
      model: 'gpt-4.1',
    });

    expect((await MakaioBus.request(SessionSubjects.get, { sessionId })).session?.adapterSessionId).toBeUndefined();

    // Matching-adapter agent confirms — should succeed
    await emitAgentStarted(matchingAgentId, adapterId, 'claude-code', 'claude-provider-session-99', sessionId, {
      model: 'claude-sonnet-4-20250514',
    });

    const sessionAfter = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(sessionAfter.session?.adapterSessionId).toBe('claude-provider-session-99');
    expect(sessionAfter.session?.adapterName).toBe('claude-code');
  });

  it('sets the atomic adapter identity triplet when session.adapterName is unset', async () => {
    const sessionId = 'session-recon-8';
    const agentId = 'agent-recon-8';
    const adapterId = 'adapter-recon-8';
    const confirmedId = 'provider-confirmed-session-id-8';

    await sessionService.init();

    // Create a bare session — no agent.added, so adapterName is unset (legacy path)
    await MakaioBus.request(SessionSubjects.create, { sessionId });

    // Seed agent storage directly (bypass agent.added to keep session bare) and
    // name the agent as the session's lead on the row itself — which is what a
    // legacy session is: one whose designation exists without the announcement
    // that would have established its identity.
    await seedAgent(sessionId, agentId, adapterId, 'claude-code', 'lead', { emitAdded: false });
    // Through the reserving transaction, which is the designation's one writer —
    // a whole-record `set` deliberately preserves the stored lead instead of
    // carrying one in.
    const designated = await designateSessionLead(MakaioBus, {
      sessionId,
      agentId,
      expectedLeadAgentId: null,
    });
    expect(designated?.outcome).toBe('claimed');

    // Verify session has no adapter identity at all
    const sessionBefore = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(sessionBefore.session?.adapterName).toBeUndefined();
    expect(sessionBefore.session?.adapterId).toBeUndefined();
    expect(sessionBefore.session?.adapterSessionId).toBeUndefined();

    // Agent confirms — should set the full triplet atomically
    await emitAgentStarted(agentId, adapterId, 'claude-code', confirmedId, sessionId, {
      model: 'claude-sonnet-4-20250514',
    });

    const sessionAfter = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(sessionAfter.session?.adapterSessionId).toBe(confirmedId);
    expect(sessionAfter.session?.adapterName).toBe('claude-code');
    expect(sessionAfter.session?.adapterId).toBe(adapterId);
  });
});
