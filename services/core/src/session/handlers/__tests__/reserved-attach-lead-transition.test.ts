import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  AgentSubjects,
  SessionSubjects,
  type IMakaioSession,
  type MakaioSessionAgent,
} from '@makaio/contracts';
import { AgentStorageSubjects } from '../../storage/agent-namespace.js';
import { designateSessionLead } from '../../ownership/index.js';
import { FRESH_WITH_HISTORY_RECOVERY_PLAN } from '../../recovery-plan.js';
import { verifyAndRecoverAgents } from '../../utils/agent-recovery.js';
import { getSessionAgentAttachError } from '../attach-error.js';
import { ATTACH_TEST_IDS, holdProviderSession, registerSuccessfulMessageAppendHandler } from './shared.js';
import {
  ADAPTER_ID,
  createReservedAttachContext,
  FIRST,
  MACHINE,
  PROVIDER,
  type ReservedAttachContext,
} from './reserved-attach-fixture.js';

/** Existing lead used by replacement and member cases. */
const PREVIOUS_LEAD_ID = 'previous-lead';

describe('reserved attach lead transitions', () => {
  let fixture: ReservedAttachContext;

  beforeEach(() => {
    fixture = createReservedAttachContext();
  });

  afterEach(() => {
    fixture.destroy();
  });

  /** Seed a materialized prior lead for replacement and member transitions. */
  async function seedPreviousLead(): Promise<IMakaioSession> {
    const now = Date.now();
    const previous: MakaioSessionAgent = {
      agentId: PREVIOUS_LEAD_ID,
      adapterId: ADAPTER_ID,
      adapterName: ATTACH_TEST_IDS.adapterName,
      sessionId: ATTACH_TEST_IDS.sessionId,
      role: 'lead',
      status: 'idle',
      createdAt: now,
      lastActivityAt: now,
    };
    const session = fixture.seedSession({ agents: [previous], leadAgentId: PREVIOUS_LEAD_ID });
    await MakaioBus.request(AgentStorageSubjects.set, { agentId: previous.agentId, agent: previous });
    return session;
  }

  /**
   * Recover one failed attach through the production liveness/recovery seam.
   * @param agentId - Failed lead identity retained by the session.
   */
  async function recoverDeadLead(agentId: string): Promise<void> {
    fixture.ctx.trackUnsubscribe(
      MakaioBus.on(AdapterSubjects.getAgent, (context) => {
        context.setResult({ agent: null });
      }),
    );
    fixture.ctx.trackUnsubscribe(
      MakaioBus.on(AdapterSubjects.rehydrateAgent, (context) => {
        context.setResult({
          success: true,
          ownerInstanceId: context.payload.ownerInstanceId,
          settlementAckToken: `recovery-ack-${context.payload.agentId}`,
        });
      }),
    );
    const deadLead = fixture.ctx.getStoredAgent(agentId);
    if (deadLead === undefined) throw new Error('expected failed lead to remain materialized');

    const recovered = await verifyAndRecoverAgents(MakaioBus, [deadLead], {
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
      machineId: 'local-machine',
    });

    expect(recovered.recoveredAgentIds).toEqual(new Set([agentId]));
    expect(fixture.ctx.getStoredAgent(agentId)?.status).toBe('idle');
  }

  it('keeps a failed first lead designated when a stale designation had no materialized agent', async () => {
    const session = fixture.seedSession({ agents: [], leadAgentId: 'stale-unmaterialized-lead' });
    fixture.registerAdapter(() => {
      throw new Error('provider start exploded');
    });

    const error = await fixture.attach({ role: 'lead' }).catch((value: unknown) => value);
    const agentId = fixture.dispatched[0]?.agentId ?? '';

    expect((getSessionAgentAttachError(error)?.cause as Error).message).toContain('provider start exploded');
    expect(fixture.ctx.getStoredAgent(agentId)?.status).toBe('dead');
    expect(session.leadAgentId).toBe(agentId);
    expect(fixture.stoppedTargets).toEqual([
      { agentId, ownerInstanceId: ATTACH_TEST_IDS.ownerInstanceId, teardown: 'connector-only' },
    ]);

    await recoverDeadLead(agentId);
    expect(session.leadAgentId).toBe(agentId);
  });

  it('keeps and recovers the first explicit lead added after members', async () => {
    const now = Date.now();
    const member: MakaioSessionAgent = {
      agentId: 'existing-member',
      adapterId: ADAPTER_ID,
      adapterName: ATTACH_TEST_IDS.adapterName,
      sessionId: ATTACH_TEST_IDS.sessionId,
      role: 'member',
      status: 'idle',
      createdAt: now,
      lastActivityAt: now,
    };
    const session = fixture.seedSession({ agents: [member] });
    await MakaioBus.request(AgentStorageSubjects.set, { agentId: member.agentId, agent: member });
    fixture.registerAdapter(() => {
      throw new Error('first lead start exploded');
    });

    await fixture.attach({ role: 'lead' }).catch(() => undefined);
    const agentId = fixture.dispatched[0]?.agentId ?? '';

    expect(fixture.ctx.getStoredAgent(agentId)?.status).toBe('dead');
    expect(session.leadAgentId).toBe(agentId);
    await recoverDeadLead(agentId);
    expect(session.leadAgentId).toBe(agentId);
  });

  it('restores the transaction-read previous lead when a replacement dispatch throws', async () => {
    const session = await seedPreviousLead();
    fixture.registerAdapter(() => {
      throw new Error('replacement start exploded');
    });

    await fixture.attach({ role: 'lead' }).catch(() => undefined);
    const agentId = fixture.dispatched[0]?.agentId ?? '';

    expect(fixture.ctx.getStoredAgent(agentId)?.status).toBe('dead');
    expect(session.leadAgentId).toBe(PREVIOUS_LEAD_ID);
    expect(fixture.stopped).toEqual([agentId]);
  });

  it.each([
    { label: 'fresh lead', seed: async () => fixture.seedSession(), expectedLeadAgentId: undefined },
    { label: 'replacement lead', seed: seedPreviousLead, expectedLeadAgentId: PREVIOUS_LEAD_ID },
  ])('reverses a committed keyless $label reservation when its response is lost', async ({
    seed,
    expectedLeadAgentId,
  }) => {
    const session = await seed();
    await holdProviderSession({
      sessionId: ATTACH_TEST_IDS.sessionId,
      agentId: 'foreign-key-holder',
      adapterId: ADAPTER_ID,
      adapterName: ATTACH_TEST_IDS.adapterName,
      machineId: MACHINE,
      providerSessionId: PROVIDER,
    });
    let reservations = 0;
    fixture.ctx.trackUnsubscribe(
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,
        async (context) => {
          reservations += 1;
          await context.next();
          if (reservations === 2) throw new Error('keyless reservation response was lost');
        },
        FIRST,
      ),
    );
    fixture.registerAdapter();

    const error = await fixture.attach({ role: 'lead' }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect(session.leadAgentId).toBe(expectedLeadAgentId);
    expect(fixture.dispatched).toEqual([]);
  });

  it('does not overwrite a newer lead while reversing a response-lost keyless attach reservation', async () => {
    const session = fixture.seedSession();
    await holdProviderSession({
      sessionId: ATTACH_TEST_IDS.sessionId,
      agentId: 'foreign-key-holder',
      adapterId: ADAPTER_ID,
      adapterName: ATTACH_TEST_IDS.adapterName,
      machineId: MACHINE,
      providerSessionId: PROVIDER,
    });
    let reservations = 0;
    fixture.ctx.trackUnsubscribe(
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,
        async (context) => {
          reservations += 1;
          await context.next();
          if (reservations === 2) {
            await MakaioBus.request(AgentStorageSubjects.set, {
              agentId: 'newer-lead',
              agent: {
                agentId: 'newer-lead',
                adapterId: ADAPTER_ID,
                adapterName: ATTACH_TEST_IDS.adapterName,
                sessionId: ATTACH_TEST_IDS.sessionId,
                role: 'lead',
                status: 'idle',
                createdAt: 1,
                lastActivityAt: 1,
              },
            });
            await designateSessionLead(MakaioBus, {
              sessionId: ATTACH_TEST_IDS.sessionId,
              agentId: 'newer-lead',
              expectedLeadAgentId: context.payload.agentId,
            });
            throw new Error('keyless reservation response was lost');
          }
        },
        FIRST,
      ),
    );
    fixture.registerAdapter();

    const error = await fixture.attach({ role: 'lead' }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect(session.leadAgentId).toBe('newer-lead');
  });

  it('clears a response-lost fresh attach instead of restoring a stale unmaterialized designation', async () => {
    const session = fixture.seedSession({ agents: [], leadAgentId: 'stale-unmaterialized-lead' });
    await holdProviderSession({
      sessionId: ATTACH_TEST_IDS.sessionId,
      agentId: 'foreign-key-holder',
      adapterId: ADAPTER_ID,
      adapterName: ATTACH_TEST_IDS.adapterName,
      machineId: MACHINE,
      providerSessionId: PROVIDER,
    });
    let reservations = 0;
    fixture.ctx.trackUnsubscribe(
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,
        async (context) => {
          reservations += 1;
          await context.next();
          if (reservations === 2) throw new Error('keyless reservation response was lost');
        },
        FIRST,
      ),
    );
    fixture.registerAdapter();

    await fixture.attach({ role: 'lead' }).catch(() => undefined);

    expect(session.leadAgentId).toBeUndefined();
  });

  it.each([
    { label: 'a fresh lead', seed: async () => fixture.seedSession(), expected: 'started' },
    { label: 'a replacement lead', seed: seedPreviousLead, expected: PREVIOUS_LEAD_ID },
  ])('applies $label semantics when the adapter returns malformed identity', async ({ seed, expected }) => {
    const session = await seed();
    fixture.registerAdapter(() => ({
      success: true,
      agentId: 'unrelated-agent',
      adapterId: ADAPTER_ID,
      adapterSessionId: 'malformed-provider-session',
      sessionId: ATTACH_TEST_IDS.sessionId,
      messageId: 'malformed-message',
      ownerInstanceId: ATTACH_TEST_IDS.ownerInstanceId,
      settlementAckToken: 'malformed-ack',
    }));

    const error = await fixture.attach({ role: 'lead' }).catch((value: unknown) => value);
    const agentId = fixture.dispatched[0]?.agentId ?? '';

    expect(getSessionAgentAttachError(error)?.cause).toMatchObject({ dispatch: 'dispatch-uncertain' });
    expect(fixture.ctx.getStoredAgent(agentId)?.status).toBe('dead');
    expect(session.leadAgentId).toBe(expected === 'started' ? agentId : expected);
    expect(fixture.stopped).toEqual([agentId]);
  });

  it.each([
    { label: 'a fresh lead', seed: async () => fixture.seedSession(), expected: 'started' },
    { label: 'a replacement lead', seed: seedPreviousLead, expected: PREVIOUS_LEAD_ID },
  ])('applies $label semantics when completion throws after dispatch', async ({ seed, expected }) => {
    const session = await seed();
    fixture.ctx.trackUnsubscribe(
      MakaioBus.on(
        AgentStorageSubjects.updateRuntime,
        () => {
          throw new Error('runtime adoption failed');
        },
        FIRST,
      ),
    );
    fixture.registerAdapter();

    const error = await fixture.attach({ role: 'lead' }).catch((value: unknown) => value);
    const agentId = fixture.dispatched[0]?.agentId ?? '';

    expect(getSessionAgentAttachError(error)?.cause).toMatchObject({ code: 'settlement-unresolved' });
    expect(fixture.ctx.getStoredAgent(agentId)?.status).toBe('dead');
    expect(session.leadAgentId).toBe(expected === 'started' ? agentId : expected);
    expect(fixture.stopped).toEqual([agentId]);
  });

  it.each([
    { label: 'a fresh lead', seed: async () => fixture.seedSession(), expected: 'started' },
    { label: 'a replacement lead', seed: seedPreviousLead, expected: PREVIOUS_LEAD_ID },
  ])('applies $label semantics when the initial message fails', async ({ seed, expected }) => {
    const session = await seed();
    fixture.ctx.trackUnsubscribe(registerSuccessfulMessageAppendHandler());
    fixture.ctx.trackUnsubscribe(
      MakaioBus.on(AgentSubjects.sendMessage, () => {
        throw new Error('initial provider dispatch failed');
      }),
    );
    fixture.registerAdapter();

    const error = await fixture
      .attach({ role: 'lead', initialMessage: 'start the session' })
      .catch((value: unknown) => value);
    const agentId = fixture.dispatched[0]?.agentId ?? '';

    expect((getSessionAgentAttachError(error)?.cause as Error).message).toContain('initial provider dispatch failed');
    expect(fixture.ctx.getStoredAgent(agentId)?.status).toBe('dead');
    expect(session.leadAgentId).toBe(expected === 'started' ? agentId : expected);
    expect(fixture.stopped).toEqual([agentId]);
  });

  it('never changes designation for a failed member attach', async () => {
    const session = await seedPreviousLead();
    fixture.registerAdapter(() => {
      throw new Error('member start exploded');
    });

    await fixture.attach({ role: 'member' }).catch(() => undefined);
    const agentId = fixture.dispatched[0]?.agentId ?? '';

    expect(fixture.ctx.getStoredAgent(agentId)?.status).toBe('dead');
    expect(session.leadAgentId).toBe(PREVIOUS_LEAD_ID);
  });

  it.each([
    { label: 'fresh', seed: async () => fixture.seedSession(), expected: undefined },
    { label: 'replacement', seed: seedPreviousLead, expected: PREVIOUS_LEAD_ID },
  ])('fully rolls back a not-dispatched $label lead before deleting its row', async ({ seed, expected }) => {
    const session = await seed();
    fixture.registerAdapter(() => ({ success: false, message: 'not sent', dispatch: 'not-dispatched' }));

    await fixture.attach({ role: 'lead' }).catch(() => undefined);
    const agentId = fixture.dispatched[0]?.agentId ?? '';

    expect(fixture.ctx.getStoredAgent(agentId)).toBeUndefined();
    expect(session.leadAgentId).toBe(expected);
  });
});
