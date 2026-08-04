/**
 * Path D — what happens *after* a reserved attach has dispatched.
 *
 * The settlement, the currency write and the `starting → idle` commit all run
 * with a live connector behind them, and every one of them is a round trip that
 * can throw. Unguarded, a throw there leaves `startReservedAttachAgent` without
 * a handle: the row stays `starting`, the generation stays `held`, the
 * designation stands and the connector keeps running, and the caller has nothing
 * left to retire it with. These cases pin that each failure retires exactly what
 * the attempt took, once — and that a removal landing under the commit is
 * reported as unavailable rather than silently committed.
 *
 * Separate from `reserved-attach.test.ts` only because that file's line cap is a
 * reviewed constant; both drive the same attach through the same fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '../../storage/agent-namespace.js';
import { getSessionAgentAttachError } from '../attach-error.js';
import { ATTACH_TEST_IDS, holdProviderSession, type StartAgentRequestPayload } from './shared.js';
import {
  ADAPTER_ID,
  createReservedAttachContext,
  FIRST,
  MACHINE,
  PROVIDER,
  type ReservedAttachContext,
} from './reserved-attach-fixture.js';

describe('completing a reserved attach', () => {
  let fixture: ReservedAttachContext;
  let ctx: ReservedAttachContext['ctx'];
  let dispatched: StartAgentRequestPayload[];
  let stopped: string[];

  beforeEach(() => {
    fixture = createReservedAttachContext();
    ({ ctx, dispatched, stopped } = fixture);
  });

  afterEach(() => {
    fixture.destroy();
  });

  const seedSession: ReservedAttachContext['seedSession'] = () => fixture.seedSession();
  const registerAdapter: ReservedAttachContext['registerAdapter'] = (respond) => fixture.registerAdapter(respond);
  const attach: ReservedAttachContext['attach'] = (overrides) => fixture.attach(overrides);
  const tryClaim: ReservedAttachContext['tryClaim'] = (providerSessionId) => fixture.tryClaim(providerSessionId);

  it.each([
    {
      label: 'the runtime write',
      inject: () =>
        MakaioBus.on(
          AgentStorageSubjects.updateRuntime,
          () => {
            throw new Error('runtime write transport failed');
          },
          FIRST,
        ),
    },
    {
      label: 'the settlement',
      inject: () =>
        MakaioBus.on(
          SessionSubjects.ownership.settleMovement,
          () => {
            throw new Error('settlement transport failed');
          },
          FIRST,
        ),
    },
    {
      label: 'the commit',
      inject: () =>
        MakaioBus.on(
          AgentStorageSubjects.updateStatus,
          (context) => {
            if (context.payload.status === 'idle') throw new Error('commit transport failed');
            return context.next();
          },
          FIRST,
        ),
    },
  ])('case 97, Path D: a throw from $label retires the dispatched attach exactly once', async ({ inject }) => {
    seedSession();
    ctx.trackUnsubscribe(inject());
    registerAdapter();

    const error = await attach({ role: 'lead' }).catch((value: unknown) => value);

    expect(getSessionAgentAttachError(error)?.cause).toMatchObject({ code: 'settlement-unresolved' });
    const agentId = dispatched[0]?.agentId ?? '';
    // Exactly one teardown, and the row is never left `starting`: the connector
    // is stopped once, the generation is retired rather than freed, and the
    // designation this attach made is put back.
    expect(stopped).toEqual([agentId]);
    expect(ctx.getStoredAgent(agentId)?.status).toBe('dead');
    expect(ctx.getAgentClaims(agentId).every((claim) => claim.status !== 'held')).toBe(true);
    // `abandoned`, not `released`: nothing here proved the provider session is
    // closed, so the key stays blocked for the next claimant (I15).
    await expect(tryClaim(PROVIDER)).resolves.toMatchObject({ outcome: 'occupied' });
  });

  it('claims the confirmed key before the session is revalidated', async () => {
    // A degraded attach lands on a key the reservation never named, and the
    // revalidation that follows is a storage round trip. Run before the
    // settlement, it is a window in which nothing holds the key the connector is
    // already speaking to — and a failure in it retires a reservation that never
    // named that key at all.
    seedSession();
    // Degraded: the session's key is held elsewhere, so the connector comes up
    // on one of its own.
    await holdProviderSession({
      sessionId: ATTACH_TEST_IDS.sessionId,
      agentId: 'foreign-agent',
      adapterId: ADAPTER_ID,
      adapterName: ATTACH_TEST_IDS.adapterName,
      machineId: MACHINE,
      providerSessionId: PROVIDER,
    });
    let claimedKeysAtRevalidation: string[] | undefined;
    ctx.trackUnsubscribe(
      MakaioBus.on(
        SessionSubjects.get,
        (context) => {
          const agentId = dispatched[0]?.agentId;
          // Only the FIRST post-dispatch lookup counts: a later successful
          // lookup must not paper over a claim that was missing earlier.
          if (agentId !== undefined && claimedKeysAtRevalidation === undefined) {
            claimedKeysAtRevalidation = ctx
              .getAgentClaims(agentId)
              .filter((claim) => claim.status === 'held')
              .map((claim) => claim.providerSessionId);
          }
          return context.next();
        },
        FIRST,
      ),
    );
    registerAdapter();

    const result = await attach({ role: 'member' });

    // The connector landed on a fresh key, and that key was already claimed by
    // the time anything looked at the session again.
    const landed = dispatched[0]?.mode === 'resume' ? PROVIDER : `fresh-${dispatched.length}`;
    expect(claimedKeysAtRevalidation).toEqual([landed]);
    expect(ctx.getStoredAgent(result.agentId)?.status).toBe('idle');
  });

  it.each([
    { label: 'disposed', dispose: true },
    { label: 'deleted', dispose: false },
  ])('case 98c, Path D: a row $label under the commit is reported as unavailable', async ({ dispose }) => {
    seedSession();
    registerAdapter(async (payload) => {
      // A removal landing between the dispatch and the commit — terminal,
      // owner-independent, and the one refusal that means this attach's
      // connector has no generation left behind it.
      const agentId = payload.agentId ?? '';
      if (dispose) {
        await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });
        return;
      }
      await MakaioBus.request(AgentStorageSubjects.delete, { agentId });
    });

    const error = await attach({ role: 'lead' }).catch((value: unknown) => value);

    expect(getSessionAgentAttachError(error)?.cause).toMatchObject({ code: 'agent-unavailable' });
    const agentId = dispatched[0]?.agentId ?? '';
    expect(stopped).toEqual([agentId]);
    expect(ctx.getAgentClaims(agentId).every((claim) => claim.status !== 'held')).toBe(true);
  });
});
