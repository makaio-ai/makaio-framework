/**
 * Tests for the session-ownership authority: the five `session.ownership.*`
 * operations, the identity they are composed with, and the boot barrier the
 * diagnostic reconcile runs behind.
 *
 * Everything runs against the real memory backends through the real bus. The
 * authority's whole value is that each operation is one durable transaction, so
 * a test that stubbed storage would assert nothing about it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionOwnershipStorageSubjects, SessionSubjects } from '@makaio/contracts';
import { KernelSubjects } from '@makaio/kernel';
import { MakaioSessionService } from '../session-service.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { createTestAgent, registerMemorySessionBackends } from './shared.js';

const MACHINE_ID = 'ownership-test-machine';
const ADAPTER_NAME = 'test-adapter';
const ADAPTER_ID = 'test-adapter-instance';

describe('session ownership authority', () => {
  let bus: IMakaioBus;
  let service: MakaioSessionService;
  let storageCleanups: Array<() => void> = [];

  /**
   * Compose the session service, optionally without a machine identity.
   * @param options - Identity and topology the authority is composed with
   */
  async function startService(options?: { machineId?: string; topology?: 'machine-exclusive' | 'shared-machine' }) {
    service = new MakaioSessionService(bus, {
      ...(options?.machineId !== undefined && { machineId: options.machineId }),
      ...(options?.topology !== undefined && { topology: options.topology }),
    });
    await service.init();
  }

  /**
   * Seed a session with one agent.
   * @param sessionId - Session to create
   * @param agentId - Agent to attach
   * @returns The seeded identifiers
   */
  async function seed(sessionId: string, agentId: string): Promise<{ sessionId: string; agentId: string }> {
    await bus.request(SessionSubjects.create, { sessionId });
    await bus.request(AgentStorageSubjects.set, {
      agentId,
      agent: createTestAgent(agentId, { sessionId, adapterId: ADAPTER_ID, adapterName: ADAPTER_NAME }),
    });
    return { sessionId, agentId };
  }

  /**
   * Reserve a keyed start for an agent.
   * @param sessionId - Session the agent belongs to
   * @param agentId - Agent to reserve for
   * @param providerSessionId - Provider session to take the key on
   * @param role - Whether the reservation designates the lead
   * @returns The reservation result
   */
  function reserve(sessionId: string, agentId: string, providerSessionId: string | null, role: 'lead' | 'member') {
    return bus.request(SessionSubjects.ownership.reserveStart, {
      sessionId,
      agentId,
      adapterId: ADAPTER_ID,
      adapterName: ADAPTER_NAME,
      role,
      resumeProviderSessionId: providerSessionId,
      ...(role === 'lead' && { expectedLeadAgentId: null }),
    });
  }

  beforeEach(() => {
    bus = createBusInstance();
    storageCleanups = registerMemorySessionBackends(bus);
  });

  afterEach(() => {
    service?.destroy();
    for (let index = storageCleanups.length - 1; index >= 0; index -= 1) storageCleanups[index]?.();
    storageCleanups = [];
  });

  describe('reserveStart', () => {
    it('takes a keyless reservation that designates without writing a claim row', async () => {
      await startService({ machineId: MACHINE_ID });
      const { sessionId, agentId } = await seed('reserve-keyless', 'agent-keyless');

      const result = await reserve(sessionId, agentId, null, 'lead');

      expect(result.outcome).toBe('reserved');
      if (result.outcome !== 'reserved') return;
      expect(result.reservation.claim).toBeNull();
      expect(result.reservation.leadDesignated).toBe(true);
      expect(result.reservation.previousLeadAgentId).toBeNull();
      expect(result.reservation.machineId).toBe(MACHINE_ID);

      const stored = await bus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.leadAgentId).toBe(agentId);
      const { claims } = await bus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: MACHINE_ID });
      expect(claims).toEqual([]);
    });

    it('reports occupied when another agent holds the key, without touching the designation', async () => {
      await startService({ machineId: MACHINE_ID });
      const { sessionId, agentId } = await seed('reserve-occupied', 'agent-first');
      await bus.request(AgentStorageSubjects.set, {
        agentId: 'agent-second',
        agent: createTestAgent('agent-second', { sessionId, adapterId: ADAPTER_ID, adapterName: ADAPTER_NAME }),
      });

      expect((await reserve(sessionId, agentId, 'provider-contended', 'lead')).outcome).toBe('reserved');
      const second = await reserve(sessionId, 'agent-second', 'provider-contended', 'member');

      expect(second.outcome).toBe('occupied');
      if (second.outcome !== 'occupied') return;
      expect(second.holder.agentId).toBe(agentId);
      const stored = await bus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.leadAgentId).toBe(agentId);
    });

    it('reports lead-conflict when the observed lead has moved on', async () => {
      await startService({ machineId: MACHINE_ID });
      const { sessionId, agentId } = await seed('reserve-conflict', 'agent-winner');
      await bus.request(AgentStorageSubjects.set, {
        agentId: 'agent-loser',
        agent: createTestAgent('agent-loser', { sessionId, adapterId: ADAPTER_ID, adapterName: ADAPTER_NAME }),
      });

      expect((await reserve(sessionId, agentId, null, 'lead')).outcome).toBe('reserved');
      const loser = await reserve(sessionId, 'agent-loser', null, 'lead');

      expect(loser.outcome).toBe('lead-conflict');
      if (loser.outcome !== 'lead-conflict') return;
      expect(loser.currentLeadAgentId).toBe(agentId);
    });

    it('refuses a removed agent by predicate', async () => {
      await startService({ machineId: MACHINE_ID });
      const { sessionId, agentId } = await seed('reserve-disposed', 'agent-disposed');
      await bus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });

      expect((await reserve(sessionId, agentId, 'provider-disposed', 'member')).outcome).toBe('agent-disposed');
      const { claims } = await bus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: MACHINE_ID });
      expect(claims).toEqual([]);
    });
  });

  describe('release', () => {
    it('scopes a rollback to the named generation and leaves an unrelated one holding its key', async () => {
      await startService({ machineId: MACHINE_ID });
      const { sessionId, agentId } = await seed('release-scoped', 'agent-scoped');

      const first = await reserve(sessionId, agentId, 'provider-one', 'member');
      expect(first.outcome).toBe('reserved');
      if (first.outcome !== 'reserved' || first.reservation.claim === null) return;
      const second = await reserve(sessionId, agentId, 'provider-two', 'member');
      expect(second.outcome).toBe('reserved');
      if (second.outcome !== 'reserved' || second.reservation.claim === null) return;

      const released = await bus.request(SessionSubjects.ownership.release, {
        agentId,
        claimToken: first.reservation.claim.claimToken,
        disposition: 'released',
      });
      expect(released.releasedProviderSessionIds).toEqual(['provider-one']);
      expect(released.claimTokenNotFound).toBe(false);

      const { claims } = await bus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: MACHINE_ID });
      expect(claims.map((claim) => claim.providerSessionId)).toEqual(['provider-two']);
    });

    it('fans out over every generation the agent holds and stays idempotent', async () => {
      await startService({ machineId: MACHINE_ID });
      const { sessionId, agentId } = await seed('release-fanout', 'agent-fanout');
      expect((await reserve(sessionId, agentId, 'provider-a', 'member')).outcome).toBe('reserved');
      expect((await reserve(sessionId, agentId, 'provider-b', 'member')).outcome).toBe('reserved');

      const first = await bus.request(SessionSubjects.ownership.release, { agentId, disposition: 'released' });
      expect(first.releasedProviderSessionIds.toSorted()).toEqual(['provider-a', 'provider-b']);

      const repeat = await bus.request(SessionSubjects.ownership.release, { agentId, disposition: 'released' });
      expect(repeat.releasedProviderSessionIds).toEqual([]);
      expect(repeat.claimTokenNotFound).toBe(false);
    });

    it('reports a foreign token without revealing who holds it', async () => {
      await startService({ machineId: MACHINE_ID });
      const { sessionId, agentId } = await seed('release-foreign', 'agent-foreign');
      expect((await reserve(sessionId, agentId, 'provider-foreign', 'member')).outcome).toBe('reserved');

      const result = await bus.request(SessionSubjects.ownership.release, {
        agentId,
        claimToken: 'a-token-this-agent-never-took',
        disposition: 'abandoned',
      });
      expect(result).toEqual({ releasedProviderSessionIds: [], markedClaims: [], claimTokenNotFound: true });
    });
  });

  describe('reconcile', () => {
    it('files abandoned for a disposed owner under both topologies and changes nothing on a second run', async () => {
      for (const topology of ['shared-machine', 'machine-exclusive'] as const) {
        const suffix = `-${topology}`;
        await startService({ machineId: MACHINE_ID, topology });
        const { sessionId, agentId } = await seed(`reconcile-disposed${suffix}`, `agent-disposed${suffix}`);
        expect((await reserve(sessionId, agentId, `provider-disposed${suffix}`, 'member')).outcome).toBe('reserved');
        await bus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });
        // The adapter answers, so `adapter-instance-gone` cannot be the reason
        // reported under `machine-exclusive`.
        const adapter = bus.on(AdapterSubjects.listAgents, (ctx) => {
          ctx.setResult({ agents: [] });
        });

        const first = await bus.request(SessionSubjects.ownership.reconcile, {});
        expect(first.outcome).toBe('reconciled');
        if (first.outcome !== 'reconciled') return;
        const marked = first.claims.filter((entry) => entry.claim.agentId === agentId);
        expect(marked).toHaveLength(1);
        expect(marked[0]?.verdict).toBe('abandoned');
        expect(marked[0]?.reason).toBe('agent-disposed');

        // Never deletes: the row keeps blocking its key, marked.
        const listed = await bus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: MACHINE_ID });
        const stored = listed.claims.find((claim) => claim.agentId === agentId);
        expect(stored?.status).toBe('abandoned');

        const second = await bus.request(SessionSubjects.ownership.reconcile, {});
        expect(second.outcome).toBe('reconciled');
        if (second.outcome !== 'reconciled') return;
        expect(second.claims.filter((entry) => entry.claim.agentId === agentId)[0]?.verdict).toBe('abandoned');
        const relisted = await bus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: MACHINE_ID });
        expect(relisted.claims).toHaveLength(listed.claims.length);

        adapter();
        service.destroy();
      }
    });

    it('admits an unanswered adapter only under machine-exclusive', async () => {
      // No `adapter.listAgents` handler at all: the instance the claim names
      // answers nothing.
      await startService({ machineId: MACHINE_ID, topology: 'shared-machine' });
      const { sessionId, agentId } = await seed('reconcile-shared', 'agent-shared');
      expect((await reserve(sessionId, agentId, 'provider-shared', 'member')).outcome).toBe('reserved');

      const shared = await bus.request(SessionSubjects.ownership.reconcile, {});
      expect(shared.outcome).toBe('reconciled');
      if (shared.outcome !== 'reconciled') return;
      // With peers able to host adapters here, "no answer" means "not mine",
      // never "nobody's".
      expect(shared.claims).toEqual([{ claim: expect.objectContaining({ agentId }), verdict: 'retained' }]);
      service.destroy();

      await startService({ machineId: MACHINE_ID, topology: 'machine-exclusive' });
      const exclusive = await bus.request(SessionSubjects.ownership.reconcile, {});
      expect(exclusive.outcome).toBe('reconciled');
      if (exclusive.outcome !== 'reconciled') return;
      expect(exclusive.claims[0]?.verdict).toBe('abandoned');
      expect(exclusive.claims[0]?.reason).toBe('adapter-instance-gone');
    });

    it('retains a claim whose owner could not be read at all', async () => {
      // An unreadable agent row is not a missing one. Filing `abandoned` on a
      // transport failure would hand an operator a claim marked as orphaned
      // whose agent is alive and working — the one mistake a diagnostic must
      // never make, since nothing downstream re-checks it.
      await startService({ machineId: MACHINE_ID });
      const { sessionId, agentId } = await seed('reconcile-unreadable', 'agent-unreadable');
      expect((await reserve(sessionId, agentId, 'provider-unreadable', 'member')).outcome).toBe('reserved');

      const failing = bus.on(
        AgentStorageSubjects.get,
        () => {
          throw new Error('agent store unreachable');
        },
        { priority: 100 },
      );
      try {
        const result = await bus.request(SessionSubjects.ownership.reconcile, {});
        expect(result.outcome).toBe('reconciled');
        if (result.outcome !== 'reconciled') return;
        expect(result.claims).toEqual([{ claim: expect.objectContaining({ agentId }), verdict: 'retained' }]);
      } finally {
        failing();
      }
    });

    it('reports agent-gone when the probe straddles a delete', async () => {
      await startService({ machineId: MACHINE_ID });
      const { sessionId, agentId } = await seed('reconcile-gone', 'agent-gone');
      expect((await reserve(sessionId, agentId, 'provider-gone', 'member')).outcome).toBe('reserved');

      // The claim's foreign keys cascade, so a claim whose agent row is already
      // absent cannot be listed. The only way the diagnostic ever observes this
      // is across a concurrent delete — which is exactly what this stages,
      // through the real delete, between the listing and the assessment.
      const straddle = bus.on(
        AgentStorageSubjects.get,
        async (ctx) => {
          if (ctx.payload.agentId === agentId) await bus.request(AgentStorageSubjects.delete, { agentId });
        },
        { priority: 100 },
      );
      try {
        const result = await bus.request(SessionSubjects.ownership.reconcile, {});
        expect(result.outcome).toBe('reconciled');
        if (result.outcome !== 'reconciled') return;
        // `vanished`, not `abandoned`: the same delete that produced the reason
        // cascaded the claim away, so there was no row left to file it on. A
        // report of `abandoned` would send an operator looking for a marking
        // that was never written — and for a row that no longer exists.
        expect(result.claims[0]?.verdict).toBe('vanished');
        expect(result.claims[0]?.reason).toBe('agent-gone');
      } finally {
        straddle();
      }
    });

    it('confers no authority: an abandoned claim with a live owner is still occupied', async () => {
      await startService({ machineId: MACHINE_ID, topology: 'machine-exclusive' });
      const { sessionId, agentId } = await seed('reconcile-no-authority', 'agent-live');
      expect((await reserve(sessionId, agentId, 'provider-live', 'member')).outcome).toBe('reserved');
      await bus.request(AgentStorageSubjects.set, {
        agentId: 'agent-contender',
        agent: createTestAgent('agent-contender', { sessionId, adapterId: ADAPTER_ID, adapterName: ADAPTER_NAME }),
      });

      // No adapter answers, so reconcile files `abandoned` even though the agent
      // and session rows are live.
      const reconciled = await bus.request(SessionSubjects.ownership.reconcile, {});
      expect(reconciled.outcome).toBe('reconciled');
      if (reconciled.outcome !== 'reconciled') return;
      expect(reconciled.claims[0]?.verdict).toBe('abandoned');

      // Takeover is a predicate over the incumbent's own rows, and never looks
      // at the marking: the key stays blocked.
      const contender = await reserve(sessionId, 'agent-contender', 'provider-live', 'member');
      expect(contender.outcome).toBe('occupied');
      if (contender.outcome !== 'occupied') return;
      expect(contender.holder.agentId).toBe(agentId);
    });
  });

  describe('continuation', () => {
    it('reopens a closed session and announces the status change', async () => {
      await startService({ machineId: MACHINE_ID });
      const sessionId = 'continuation-closed';
      await bus.request(SessionSubjects.create, { sessionId });
      await bus.request(SessionSubjects.close, { sessionId });

      const updates: Array<{ sessionId: string; changedProperties: string[] }> = [];
      const spy = bus.on(SessionSubjects.updated, (ctx) => {
        updates.push({ sessionId: ctx.payload.sessionId, changedProperties: ctx.payload.changedProperties });
      });
      try {
        const result = await bus.request(SessionSubjects.ownership.continuation, { sessionId, startMode: 'resume' });
        expect(result).toEqual({ outcome: 'reopened', sessionId });
      } finally {
        spy();
      }

      expect(updates).toEqual([{ sessionId, changedProperties: ['status'] }]);
      const stored = await bus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.status).toBe('active');
    });

    it('leaves an archived session archived', async () => {
      await startService({ machineId: MACHINE_ID });
      const sessionId = 'continuation-archived';
      await bus.request(SessionSubjects.create, { sessionId });
      await bus.request(SessionSubjects.close, { sessionId });
      await bus.request(SessionSubjects.archive, { sessionId });

      const result = await bus.request(SessionSubjects.ownership.continuation, { sessionId, startMode: 'resume' });

      // Archiving is a deliberate user act with its own restore path; an
      // observation must not undo a decision.
      expect(result).toEqual({ outcome: 'unchanged', sessionId });
      const stored = await bus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.status).toBe('archived');
    });

    it('acts on the lineage root when a compress child is named', async () => {
      await startService({ machineId: MACHINE_ID });
      const rootId = 'continuation-root';
      const childId = 'continuation-compress-child';
      await bus.request(SessionSubjects.create, { sessionId: rootId });
      await bus.request(SessionSubjects.create, {
        sessionId: childId,
        parentSessionId: rootId,
        branchKind: 'compress',
      });
      await bus.request(SessionSubjects.close, { sessionId: rootId });

      const result = await bus.request(SessionSubjects.ownership.continuation, {
        sessionId: childId,
        startMode: 'compact',
      });

      // Compaction is in place: the provider keeps the same session and
      // transcript, so the row that carries the provider identity — the root —
      // is the one a continuation is about.
      expect(result).toEqual({ outcome: 'reopened', sessionId: rootId });
      const storedRoot = await bus.request(SessionStorageSubjects.get, { sessionId: rootId });
      expect(storedRoot.session?.status).toBe('active');
    });

    it('does not overwrite an archive that lands between the read and the write', async () => {
      // The continuation is an observation racing whatever the user is doing.
      // It read `closed`; by the time it writes, the row may have been archived
      // — and archiving is a deliberate act with its own restore path. The
      // compare-and-swap is what keeps the observation from silently undoing it.
      await startService({ machineId: MACHINE_ID });
      const sessionId = 'continuation-archived-mid-write';
      await bus.request(SessionSubjects.create, { sessionId });
      await bus.request(SessionSubjects.close, { sessionId });

      const updates: string[] = [];
      const spy = bus.on(SessionSubjects.updated, (ctx) => {
        updates.push(ctx.payload.sessionId);
      });
      let archived = false;
      const race = bus.on(
        SessionStorageSubjects.get,
        async (ctx) => {
          if (ctx.payload.sessionId === sessionId && !archived) {
            archived = true;
            await bus.request(SessionSubjects.archive, { sessionId });
          }
        },
        { priority: 100 },
      );
      try {
        const result = await bus.request(SessionSubjects.ownership.continuation, { sessionId, startMode: 'resume' });
        expect(result).toEqual({ outcome: 'unchanged', sessionId });
      } finally {
        race();
        spy();
      }

      const stored = await bus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.status).toBe('archived');
      // Nothing changed, so nothing is announced: `session.updated` promises a
      // change this call did not make.
      expect(updates).toEqual([]);
    });

    it('reports not-found when the row is deleted between the read and the write', async () => {
      await startService({ machineId: MACHINE_ID });
      const sessionId = 'continuation-deleted-mid-write';
      await bus.request(SessionSubjects.create, { sessionId });
      await bus.request(SessionSubjects.close, { sessionId });

      let deleted = false;
      const race = bus.on(
        SessionStorageSubjects.get,
        async (ctx) => {
          if (ctx.payload.sessionId === sessionId && !deleted) {
            deleted = true;
            await bus.request(SessionStorageSubjects.delete, { sessionId });
          }
        },
        { priority: 100 },
      );
      try {
        const result = await bus.request(SessionSubjects.ownership.continuation, { sessionId, startMode: 'resume' });
        // Re-read and classified, never inferred from the refused write: the
        // same refusal covers an archive and a deletion.
        expect(result).toEqual({ outcome: 'not-found' });
      } finally {
        race();
      }
    });

    it('leaves a compress child alone when its lineage names no root', async () => {
      // The walk's job is to find the row that carries the provider identity.
      // A lineage that leads nowhere has none, and every row such a walk can
      // reach is a synthesized compress child — reopening one would leave the
      // conversation's real row closed while reporting a session reopened.
      await startService({ machineId: MACHINE_ID });
      const orphanId = 'continuation-orphan-child';
      const lostParentId = 'continuation-lost-parent';
      await bus.request(SessionSubjects.create, { sessionId: lostParentId, branchKind: 'compress' });
      await bus.request(SessionSubjects.create, {
        sessionId: orphanId,
        parentSessionId: lostParentId,
        branchKind: 'compress',
      });
      await bus.request(SessionSubjects.close, { sessionId: orphanId });
      // The parent goes; the child keeps pointing at it. That is the broken
      // lineage the walk has to survive without acting on what it reached.
      await bus.request(SessionStorageSubjects.delete, { sessionId: lostParentId });

      const result = await bus.request(SessionSubjects.ownership.continuation, {
        sessionId: orphanId,
        startMode: 'compact',
      });

      expect(result).toEqual({ outcome: 'unresolved', sessionId: orphanId });
      const stored = await bus.request(SessionStorageSubjects.get, { sessionId: orphanId });
      expect(stored.session?.status).toBe('closed');
    });

    it('leaves a compress lineage alone when it cycles or outruns the walk', async () => {
      await startService({ machineId: MACHINE_ID });
      const first = 'continuation-cycle-a';
      const second = 'continuation-cycle-b';
      await bus.request(SessionSubjects.create, { sessionId: first, branchKind: 'compress' });
      await bus.request(SessionSubjects.create, {
        sessionId: second,
        parentSessionId: first,
        branchKind: 'compress',
      });
      // Close the loop through storage: the service surface has no way to write
      // a cycle, which is precisely why the walk carries its own bound.
      await bus.request(SessionStorageSubjects.update, { sessionId: first, parentSessionId: second });
      await bus.request(SessionSubjects.close, { sessionId: first });
      await bus.request(SessionSubjects.close, { sessionId: second });

      const result = await bus.request(SessionSubjects.ownership.continuation, {
        sessionId: second,
        startMode: 'compact',
      });

      expect(result).toEqual({ outcome: 'unresolved', sessionId: second });
      for (const sessionId of [first, second]) {
        const stored = await bus.request(SessionStorageSubjects.get, { sessionId });
        expect(stored.session?.status).toBe('closed');
      }
    });

    it('reports not-found for a session that does not exist', async () => {
      await startService({ machineId: MACHINE_ID });

      const result = await bus.request(SessionSubjects.ownership.continuation, {
        sessionId: 'continuation-missing',
        startMode: 'resume',
      });

      expect(result).toEqual({ outcome: 'not-found' });
    });
  });

  describe('machine identity', () => {
    it('declines every identity-dependent operation and writes nothing without one', async () => {
      await startService();
      const { sessionId, agentId } = await seed('no-identity', 'agent-no-identity');

      expect((await reserve(sessionId, agentId, 'provider-none', 'member')).outcome).toBe(
        'machine-identity-unavailable',
      );
      const settled = await bus.request(SessionSubjects.ownership.settleMovement, {
        sessionId,
        agentId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        movement: { confirmed: true, providerSessionId: 'provider-none' },
      });
      expect(settled.outcome).toBe('machine-identity-unavailable');
      expect(await bus.request(SessionSubjects.ownership.reconcile, {})).toEqual({
        outcome: 'skipped',
        reason: 'machine-identity-unavailable',
      });

      const { ownership } = await bus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(ownership?.revision).toBe(0);
      expect(ownership?.claims).toEqual([]);
      const stored = await bus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.leadAgentId).toBeUndefined();
    });

    it('still reserves a keyless start without a machine identity', async () => {
      // The ownership key is (machine, adapter instance, provider session), so a
      // keyed reservation without a machine identity reserves in a namespace
      // nothing can be checked against — refused above. A keyless reservation
      // takes no key at all: its whole effect is the lead designation and the
      // membership check, neither of which reads the machine. Refusing it would
      // stop a host composed without an identity from starting a fresh lead at
      // all, which is a start being refused for lacking something it never uses.
      await startService();
      const { sessionId, agentId } = await seed('no-identity-keyless', 'agent-no-identity-keyless');

      const reserved = await bus.request(SessionSubjects.ownership.reserveStart, {
        sessionId,
        agentId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        role: 'lead',
        resumeProviderSessionId: null,
        expectedLeadAgentId: null,
      });

      expect(reserved.outcome).toBe('reserved');
      if (reserved.outcome !== 'reserved') return;
      // No key was taken, so nothing names a machine anywhere.
      expect(reserved.reservation.claim).toBeNull();
      expect(reserved.reservation.leadDesignated).toBe(true);
      const stored = await bus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.leadAgentId).toBe(agentId);
      const { ownership } = await bus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(ownership?.claims).toEqual([]);
    });

    it('lets a payload override act for a named machine', async () => {
      await startService();
      const { sessionId, agentId } = await seed('identity-override', 'agent-override');

      const result = await bus.request(SessionSubjects.ownership.reserveStart, {
        sessionId,
        agentId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        machineId: 'operator-named-machine',
        role: 'member',
        resumeProviderSessionId: 'provider-override',
      });

      expect(result.outcome).toBe('reserved');
      if (result.outcome !== 'reserved') return;
      expect(result.reservation.machineId).toBe('operator-named-machine');
    });
  });

  describe('boot barrier', () => {
    it('reconciles at coordinatorReady and not before', async () => {
      const reconciles: number[] = [];
      const spy = bus.on(
        SessionOwnershipStorageSubjects.listClaims,
        () => {
          reconciles.push(Date.now());
        },
        { priority: 100 },
      );
      try {
        await startService({ machineId: MACHINE_ID });
        // `onInit` must not reconcile: this service starts inside the extension
        // coordinator, and adapter instances register after it — a probe here
        // would report every live claim's instance as gone.
        expect(reconciles).toHaveLength(0);

        await bus.broadcast(KernelSubjects.phase.coordinatorReady, { machineId: MACHINE_ID });
        expect(reconciles).toHaveLength(1);

        // One shot: the barrier unsubscribes itself.
        await bus.broadcast(KernelSubjects.phase.coordinatorReady, { machineId: MACHINE_ID });
        expect(reconciles).toHaveLength(1);
      } finally {
        spy();
      }
    });
  });
});
