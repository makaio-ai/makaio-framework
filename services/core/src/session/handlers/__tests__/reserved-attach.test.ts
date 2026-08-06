// NOTE: do NOT change the eslint override on the next line without explicit human approval
/* eslint max-lines: ["error", { "max": 470 }] */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionOwnershipStorageSubjects, SessionSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '../../storage/agent-namespace.js';
import { SessionStorageSubjects } from '../../storage/namespace.js';
import { getSessionAgentAttachError } from '../attach-error.js';
import { ATTACH_TEST_IDS, holdProviderSession, type StartAgentRequestPayload } from './shared.js';
import {
  ADAPTER_ID as adapterId,
  createReservedAttachContext,
  MACHINE,
  PROVIDER,
  type ReservedAttachContext,
} from './reserved-attach-fixture.js';

/**
 * Path D — what a reserved attach takes before it dispatches.
 *
 * The composition lives in the fixture beside this file; what follows is only
 * what each case does and asserts.
 */
describe('reserved attach', () => {
  const { sessionId, adapterName } = ATTACH_TEST_IDS;

  let fixture: ReservedAttachContext;
  let ctx: ReservedAttachContext['ctx'];
  let dispatched: StartAgentRequestPayload[];
  let claimsAtDispatch: number[];
  let stopped: string[];
  /** Ownership and row acts, in the order storage saw them. */
  let storageOrder: string[];

  beforeEach(() => {
    fixture = createReservedAttachContext();
    ({ ctx, dispatched, claimsAtDispatch, stopped } = fixture);
    storageOrder = [];
  });

  afterEach(() => {
    fixture.destroy();
  });

  const seedSession: ReservedAttachContext['seedSession'] = (overrides) => fixture.seedSession(overrides);
  const registerAdapter: ReservedAttachContext['registerAdapter'] = (respond) => fixture.registerAdapter(respond);
  const attach: ReservedAttachContext['attach'] = (overrides) => fixture.attach(overrides);
  const tryClaim: ReservedAttachContext['tryClaim'] = (providerSessionId) => fixture.tryClaim(providerSessionId);

  /** Record the ownership and row acts a rollback performs, in order. */
  function recordStorageOrder(): void {
    ctx.trackUnsubscribe(
      MakaioBus.on(
        SessionSubjects.ownership.release,
        (context) => {
          storageOrder.push(`release:${context.payload.disposition}`);
          return context.next();
        },
        { priority: 1000 },
      ),
    );
    ctx.trackUnsubscribe(
      MakaioBus.on(
        SessionOwnershipStorageSubjects.claim,
        (context) => {
          if (context.payload.designateLead?.clear === true) storageOrder.push('designation-clear');
          return context.next();
        },
        { priority: 1000 },
      ),
    );
    ctx.trackUnsubscribe(
      MakaioBus.on(
        AgentStorageSubjects.delete,
        (context) => {
          storageOrder.push('row-delete');
          return context.next();
        },
        { priority: 1000 },
      ),
    );
  }

  it('case 76: reserves before the start is dispatched, under the identity it minted', async () => {
    seedSession();
    registerAdapter();

    const result = await attach();

    expect(dispatched).toHaveLength(1);
    // The claim exists by the time the adapter is spoken to — that ordering is
    // the whole guarantee, and it is asserted from inside the dispatch.
    expect(claimsAtDispatch).toEqual([1]);
    expect(dispatched[0].agentId).toBe(result.agentId);
    expect(ctx.getStoredAgent(result.agentId)?.status).toBe('idle');
  });

  it('refuses to start at all on an instance the caller named without its machine', async () => {
    // An instance ID is a one-way hash of `(machineId, adapterName)`, so a
    // caller handing one over hands over an instance without its owner. Claiming
    // the provider session under *this* runtime's identity against another
    // machine's instance writes a key that machine's runtime never computes —
    // it protects nothing while looking like it does.
    //
    // This used to be answered with a locality degrade: the attach started fresh
    // and reserved keylessly. But a fresh start still *settles*, on the provider
    // session its connector confirms, and that settlement is keyed — so the
    // mis-key arrived one step later instead of not at all. The protected fact,
    // that no key of that shape is ever taken, now holds because nothing starts.
    seedSession();
    // The reverse lookup would have to answer, so the instance is one this
    // runtime knows by name — the case is about the *machine* being unrecoverable
    // from the ID, not about the ID being unknown.
    await ctx.registerKnownAdapter(adapterName, adapterId);
    registerAdapter();

    const failure = await attach({ agent: { kind: 'adapter', adapterName, adapterId }, role: 'member' }).catch(
      (error: unknown) => error,
    );

    expect(String(failure)).toContain(`named adapter instance ${adapterId} without its machine`);
    expect(dispatched).toEqual([]);
    // And the session's key is still free for the runtime that really owns it.
    await expect(tryClaim(PROVIDER)).resolves.toMatchObject({ outcome: 'reserved' });
  });

  it('case 79: never asks the adapter who is live', async () => {
    let probes = 0;
    ctx.trackUnsubscribe(
      MakaioBus.on(AdapterSubjects.listAgents, (context) => {
        probes += 1;
        context.setResult({ agents: [{ agentId: 'other', sessionId, adapterSessionId: PROVIDER }] });
      }),
    );
    seedSession();
    registerAdapter();

    await attach();
    await attach({ role: 'member' });

    expect(probes).toBe(0);
  });

  it('cases 77 and 95: a held key degrades to fresh-with-history, once, taking no claim of its own', async () => {
    seedSession();
    await holdProviderSession({
      sessionId,
      agentId: 'foreign-agent',
      adapterId,
      adapterName,
      machineId: MACHINE,
      providerSessionId: PROVIDER,
    });
    const degrades: string[] = [];
    ctx.trackUnsubscribe(
      MakaioBus.on(SessionSubjects.locality.degraded, ({ payload }) => {
        degrades.push(payload.verdictKind === 'degrade' ? payload.reason : payload.verdictKind);
      }),
    );
    registerAdapter();

    const result = await attach({ role: 'member' });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).not.toHaveProperty('adapterSessionId');
    // Not an empty provider context: the conversation continues, without native
    // resume. Asserted on the dispatched payload, not on the verdict.
    expect(dispatched[0].sessionContext?.nativeLocality).toEqual({
      kind: 'degrade',
      reason: 'agent-already-started',
    });
    expect(claimsAtDispatch).toEqual([0]);
    // A degraded member reserves nothing at all: no key, and no designation.
    const held = ctx.getAgentClaims(result.agentId).filter((claim) => claim.status === 'held');
    expect(held.map((claim) => claim.providerSessionId)).toEqual([`fresh-1`]);
    expect(degrades).toEqual(['agent-already-started']);
  });

  it('case 78: a degraded lead still designates through the keyless second reservation', async () => {
    const session = seedSession();
    await holdProviderSession({
      sessionId,
      agentId: 'foreign-agent',
      adapterId,
      adapterName,
      machineId: MACHINE,
      providerSessionId: PROVIDER,
    });
    registerAdapter();

    const result = await attach({ role: 'lead' });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).not.toHaveProperty('adapterSessionId');
    expect(session.leadAgentId).toBe(result.agentId);
  });

  it('case 78: a designation that moves between the two reservations is a conflict, not an overwrite', async () => {
    const session = seedSession();
    await holdProviderSession({
      sessionId,
      agentId: 'foreign-agent',
      adapterId,
      adapterName,
      machineId: MACHINE,
      providerSessionId: PROVIDER,
    });
    // Two RPCs are two transactions. The designation moves in between, and the
    // keyless compare-and-swap is what refuses the stale expectation.
    let reservations = 0;
    ctx.trackUnsubscribe(
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,
        (context) => {
          reservations += 1;
          if (reservations === 2) session.leadAgentId = 'winner-agent';
          return context.next();
        },
        { priority: 1000 },
      ),
    );
    registerAdapter();

    const error = await attach({ role: 'lead' }).catch((value: unknown) => value);

    expect(getSessionAgentAttachError(error)?.cause).toMatchObject({ code: 'lead-conflict' });
    expect(dispatched).toHaveLength(0);
    expect(session.leadAgentId).toBe('winner-agent');
  });

  it.each([
    ['no other agent', undefined],
    ['a real non-self winner', 'winner-agent'],
  ])('case 111: lead-conflict is a full pre-dispatch rollback, with %s', async (_label, winner) => {
    const session = seedSession();
    if (winner !== undefined) {
      const now = Date.now();
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: winner,
        agent: {
          agentId: winner,
          adapterId,
          adapterName,
          sessionId,
          role: 'lead',
          status: 'idle',
          createdAt: now,
          lastActivityAt: now,
        },
      });
    }
    ctx.trackUnsubscribe(
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,
        (context) => {
          session.leadAgentId = winner ?? 'phantom-lead';
          return context.next();
        },
        { priority: 1000 },
      ),
    );
    recordStorageOrder();
    registerAdapter();

    const error = await attach({ role: 'lead' }).catch((value: unknown) => value);

    // Both arms, identically: attach never adopts the winner.
    const attachError = getSessionAgentAttachError(error)?.cause;
    expect(attachError).toMatchObject({ code: 'lead-conflict', dispatch: 'not-dispatched' });
    expect(dispatched).toHaveLength(0);
    expect(storageOrder).toEqual(['row-delete']);
    // Probed by actually reserving, not by reading the claims of an agent id
    // that was never minted: the rollback's claim is that the **key** is free
    // again, and an empty list for an empty id would say that whatever happened.
    await expect(tryClaim(PROVIDER)).resolves.toMatchObject({ outcome: 'reserved' });
  });

  it('cases 80 and 91: a not-dispatched refusal clears, releases and deletes — deletion last', async () => {
    seedSession();
    recordStorageOrder();
    registerAdapter(() => ({
      success: false,
      message: 'provider session is already claimed',
      dispatch: 'not-dispatched',
    }));

    const error = await attach({ role: 'lead' }).catch((value: unknown) => value);

    expect(getSessionAgentAttachError(error)?.cause).toMatchObject({
      code: 'start-failed',
      dispatch: 'not-dispatched',
    });
    const agentId = dispatched[0].agentId!;
    expect(ctx.getStoredAgent(agentId)).toBeUndefined();
    // The relative order of the clear and the release is deliberately not
    // asserted — they are independent. The deletion is last, because a keyless
    // clear demands the row still be a member of the session.
    expect(storageOrder.at(-1)).toBe('row-delete');
    expect(storageOrder).toContain('release:released');
    expect(storageOrder).toContain('designation-clear');
    // Nothing reached the provider, so the key is free again.
    await expect(tryClaim(PROVIDER)).resolves.toMatchObject({ outcome: 'reserved' });
  });

  it('case 80: a throwing history seed rolls the whole pre-dispatch state back', async () => {
    seedSession();
    recordStorageOrder();
    await holdProviderSession({
      sessionId,
      agentId: 'foreign-agent',
      adapterId,
      adapterName,
      machineId: MACHINE,
      providerSessionId: PROVIDER,
    });
    // A degraded attach seeds the conversation it will inject, and that read can
    // fail. By then the row exists and the keyless reservation holds the
    // designation, with nothing yet dispatched — the caller has no handle to
    // take them back with, so this step has to unwind for itself.
    ctx.trackUnsubscribe(
      MakaioBus.on(
        SessionStorageSubjects.get,
        () => {
          throw new Error('conversation storage is down');
        },
        { priority: 1001 },
      ),
    );
    registerAdapter();

    const error = await attach({ role: 'lead' }).catch((value: unknown) => value);

    expect(getSessionAgentAttachError(error)?.cause).toMatchObject({ dispatch: 'not-dispatched' });
    expect(dispatched).toHaveLength(0);
    expect(storageOrder).toContain('row-delete');
    expect(storageOrder).toContain('designation-clear');
  });

  it('case 80: a throwing designation restore still deletes the row', async () => {
    seedSession();
    recordStorageOrder();
    // The designation clear is a round trip like any other, and this one fails.
    // Unguarded, it would take the row deletion down with it and strand a
    // `starting` row that every later send has to arbitrate over.
    ctx.trackUnsubscribe(
      MakaioBus.on(
        SessionOwnershipStorageSubjects.claim,
        (context) => {
          if (context.payload.designateLead?.clear === true) throw new Error('designation transport failed');
          return context.next();
        },
        { priority: 1001 },
      ),
    );
    registerAdapter(() => ({
      success: false,
      message: 'provider session is already claimed',
      dispatch: 'not-dispatched',
    }));

    const error = await attach({ role: 'lead' }).catch((value: unknown) => value);

    expect(getSessionAgentAttachError(error)?.cause).toMatchObject({ dispatch: 'not-dispatched' });
    const agentId = dispatched[0].agentId!;
    expect(ctx.getStoredAgent(agentId)).toBeUndefined();
    await expect(tryClaim(PROVIDER)).resolves.toMatchObject({ outcome: 'reserved' });
  });

  it('cases 81 and 91: a throwing start keeps the row as dead and retires the key', async () => {
    seedSession();
    recordStorageOrder();
    registerAdapter(() => {
      throw new Error('provider start exploded');
    });

    const error = await attach({ role: 'lead' }).catch((value: unknown) => value);

    expect((getSessionAgentAttachError(error)?.cause as Error).message).toContain('provider start exploded');
    const agentId = dispatched[0].agentId!;
    expect(ctx.getStoredAgent(agentId)?.status).toBe('dead');
    expect(storageOrder).not.toContain('row-delete');
    expect(storageOrder).toContain('release:abandoned');
    expect(ctx.getAgentClaims(agentId).map((claim) => claim.status)).toEqual(['abandoned']);
    // The key stays blocked for the next claimant: nothing proved the provider
    // session is closed, and `stopAgent` answering `true` proves nothing — so
    // it is never asked. Asserted against the fixture's own recorder, which is
    // the one registration this composition routes to.
    expect(stopped).toEqual([]);
    await expect(tryClaim(PROVIDER)).resolves.toMatchObject({ outcome: 'occupied' });
  });

  it('case 82: a post-dispatch failure leaves a concurrently allocated generation alone', async () => {
    seedSession();
    let concurrentToken: string | undefined;
    registerAdapter(async (payload) => {
      // A generation this attempt never took, allocated for the same agent while
      // its start was in flight — the case a fan-out release would have destroyed.
      const reserved = await MakaioBus.request(SessionSubjects.ownership.reserveStart, {
        sessionId,
        agentId: payload.agentId!,
        adapterId,
        adapterName,
        role: 'member',
        resumeProviderSessionId: 'concurrent-provider-session',
        machineId: MACHINE,
      });
      if (reserved.outcome === 'reserved') concurrentToken = reserved.reservation.claim?.claimToken;
      throw new Error('provider start exploded');
    });

    await attach({ role: 'member' }).catch(() => undefined);

    const agentId = dispatched[0].agentId!;
    const survivor = ctx.getAgentClaims(agentId).find((claim) => claim.claimToken === concurrentToken);
    expect(survivor?.status).toBe('held');
  });

  it('case 83: the caller-owned row carries the full field set the adapter no longer writes', async () => {
    seedSession();
    let adapterWroteRow = false;
    ctx.trackUnsubscribe(
      MakaioBus.on(
        AgentStorageSubjects.set,
        (context) => {
          if (context.payload.agent.status === 'idle') adapterWroteRow = true;
          return context.next();
        },
        { priority: 1000 },
      ),
    );
    registerAdapter();

    const result = await attach({
      agent: {
        kind: 'adapter',
        adapterName,
        model: 'opus',
        cwd: '/work/repo',
        // Asserted by name: with the adapter's row write suppressed, a field the
        // caller omits is written by nobody.
        allowedDirectories: ['/work/repo', '/tmp/scratch'],
      },
      harnessId: 'reviewer',
    });

    const row = ctx.getStoredAgent(result.agentId);
    expect(row).toMatchObject({
      model: 'opus',
      cwd: '/work/repo',
      allowedDirectories: ['/work/repo', '/tmp/scratch'],
      harnessId: 'reviewer',
      role: 'lead',
      sessionId,
      adapterName,
    });
    expect(adapterWroteRow).toBe(false);
  });
});
