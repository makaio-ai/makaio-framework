/**
 * The `storage:sessionOwnership.settleMovement` operation, Drizzle side.
 *
 * One provider-session movement, one transaction: acquire (or recognize) the
 * successor generation, settle the agent's currency under it, retire the
 * predecessors it replaces, and mirror the result onto the session row. Composed
 * from `claim` + `settleCurrency` + `release` by a caller, the same act is three
 * transactions with two windows in which a crash strands an ownership key or
 * leaves the session advertising a currency no generation owns.
 *
 * **Statement order is incarnation counters → `runtime_instances` → `agents`
 * → stable claim keys (complete mutable set) → `agents` (guarded) → `sessions`
 * → `claims` (legacy adoption)**. The movement acquires its target key and
 * every held predecessor key before it can take over or delete either, so
 * crossed movements use the same engine-defined key order.
 *
 * **The effective generation, and why it is keyed on `claim_id`.** An agent that
 * already holds the target key is settled under the generation it already has,
 * and the token the request carries names no row at all. Retiring predecessors
 * by *token* would therefore delete the very generation being settled and
 * destroy the idempotency the movement seam depends on — it re-announces on
 * every unconfirmed dispatch and every confirmation. The predecessors are keyed
 * on `claim_id <> :effectiveClaimId` for that reason, and the response reports
 * the generation the settle actually wrote through rather than the token the
 * caller sent.
 * @packageDocumentation
 */
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import {
  acquireTransactionLocks,
  executeTransaction,
  resolveSchema,
  type MakaioDatabase,
} from '@makaio/storage-drizzle';
import {
  resolveResumableAdapterSessionId,
  type AdapterSessionCurrencyTarget,
  type OwnershipMovement,
  type SessionOwnershipSettleMovementRequest,
  type SessionOwnershipSettleMovementResult,
} from '@makaio/contracts';
import { sessionStorageSchema } from './schema.variants.js';
import { readClaimByKey } from './ownership-drizzle-reads.js';
import {
  acquisitionOwnershipClaimTransactionLock,
  readHeldOwnershipClaimTransactionLocks,
} from './ownership-drizzle-claim-keys.js';
import { runSettleStatements } from './ownership-drizzle-settle.js';
import {
  insertClaimGeneration,
  resolveClaimTargets,
  resolveTakeoverAuthorization,
  takeOverClaimRow,
} from './ownership-drizzle-acquire.js';
import {
  ensureRuntimeInstance,
  lockAgentAllocation,
  mapClaim,
  mapCurrency,
  type AgentRow,
  type ClaimAcquisition,
  type ClaimRow,
  type OwnershipTables,
  type OwnershipTransaction,
} from './ownership-drizzle-rows.js';

/**
 * Rollback signal for a movement that must leave nothing written at all.
 *
 * Every refusal reached after the claims phase — a successor key another
 * generation holds, and every refusal the guarded settle can produce — is
 * decided once rows have already been written inside the transaction. Throwing
 * is how "none of it happened" is expressed: `executeTransaction` rolls back,
 * and the handler maps the sentinel to the modeled response outside it. The
 * class is module-private so the sentinel can never escape as an error.
 */
class MovementRollbackSignal extends Error {
  /** Modeled outcome to report once the transaction has rolled back. */
  public readonly result: SessionOwnershipSettleMovementResult;

  /**
   * Create the rollback signal.
   * @param result - Modeled movement outcome to report after the rollback.
   */
  public constructor(result: SessionOwnershipSettleMovementResult) {
    super(`session ownership movement rolled back: ${result.outcome}`);
    this.name = 'MovementRollbackSignal';
    this.result = result;
  }
}

/**
 * The provider session the movement resolves to, and the currency it writes.
 *
 * A `confirmed` movement names its successor outright. A `demote` names none —
 * it says only that the conversation left — so the key it voids is whatever the
 * agent's *current* currency resolves to, and the currency becomes `moved`:
 * nothing is resumable until a provider confirms a successor.
 * @param movement - What the provider did.
 * @param agent - The locked agent row.
 * @returns The key and currency target, or `null` when a demotion resolves no key.
 */
function resolveMovementTarget(
  movement: OwnershipMovement,
  agent: AgentRow,
): { readonly providerSessionId: string; readonly currency: AdapterSessionCurrencyTarget } | null {
  if (movement.kind === 'confirmed') {
    return {
      providerSessionId: movement.providerSessionId,
      currency: { currentAdapterSessionId: movement.providerSessionId, currentAdapterSessionIdState: 'confirmed' },
    };
  }
  const providerSessionId = resolveResumableAdapterSessionId(mapCurrency(agent));
  if (providerSessionId === null) return null;
  return {
    providerSessionId,
    currency: { currentAdapterSessionId: null, currentAdapterSessionIdState: 'moved' },
  };
}

/**
 * Take the generation the agent already holds on the target key, if it has one.
 *
 * The movement acquired the target's stable key before this lookup, so this is
 * deliberately a non-locking read. Reacquiring a row-specific lock here would
 * reintroduce the target-churn race the stable key closes.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param acquisition - The key and agent the movement resolves to.
 * @returns The agent's own live generation on that key, or `undefined`.
 */
async function readOwnGeneration(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  acquisition: ClaimAcquisition,
): Promise<ClaimRow | undefined> {
  const { adapterSessionClaims } = tables;
  const [generation] = await tx
    .select()
    .from(adapterSessionClaims)
    .where(
      and(
        eq(adapterSessionClaims.machineId, acquisition.machineId),
        eq(adapterSessionClaims.adapterId, acquisition.adapterId),
        eq(adapterSessionClaims.providerSessionId, acquisition.providerSessionId),
        eq(adapterSessionClaims.agentId, acquisition.agentId),
        eq(adapterSessionClaims.status, 'held'),
        or(
          eq(adapterSessionClaims.ownerInstanceId, acquisition.ownerInstanceId),
          isNull(adapterSessionClaims.ownerInstanceId),
        ),
      ),
    )
    .limit(1);
  return generation;
}

/**
 * Adopt the legacy generation only after its movement has settled.
 *
 * The movement's stable key locked this row's ownership identity for the transaction,
 * so this write cannot lose a concurrent takeover. Deferring it until after the
 * guarded settle also keeps every refusal's response and persisted state on the
 * same pre-adoption generation.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param generation - Generation that successfully settled the movement.
 * @param ownerInstanceId - Runtime instance that settled the movement.
 * @returns The persisted generation, adopted when it was legacy.
 */
async function adoptSettledLegacyGeneration(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  generation: ClaimRow,
  ownerInstanceId: string,
): Promise<ClaimRow> {
  if (generation.ownerInstanceId !== null) return generation;
  const { adapterSessionClaims } = tables;
  const [adopted] = await tx
    .update(adapterSessionClaims)
    .set({ ownerInstanceId })
    .where(and(eq(adapterSessionClaims.claimId, generation.claimId), isNull(adapterSessionClaims.ownerInstanceId)))
    .returning();
  if (adopted === undefined) throw new Error('locked legacy movement generation disappeared before adoption');
  return adopted;
}

/**
 * Allocate the successor generation on a key the agent does not yet hold.
 *
 * The same acquisition `claim` performs. Disposing an incumbent agent alone is
 * not liveness evidence for its runtime connector, so takeover requires an
 * owner-identity authorization. Still refused ⇒ `already-claimed`, and the whole
 * movement rolls back.
 *
 * The retry loop exists for the one case that is neither success nor a holder to
 * report: a competitor took the key and released it again between the insert and
 * the classifying read, reachable across processes on Postgres.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param acquisition - The generation being taken.
 * @param now - Acquisition timestamp.
 * @returns The allocated generation.
 * @throws {@link MovementRollbackSignal} when the key belongs to somebody else,
 *   or when contention makes the outcome unclassifiable.
 */
async function allocateSuccessor(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  acquisition: ClaimAcquisition,
  now: number,
): Promise<ClaimRow> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inserted = await insertClaimGeneration(tx, tables, acquisition, now);
    if (inserted !== undefined) return inserted;

    const incumbent = await readClaimByKey(tx, tables, acquisition);
    if (incumbent === undefined) {
      // Either a guard in the acquiring SELECT did not hold, or the key was
      // taken and freed again. The membership and liveness guards were already
      // established against the locked agent row, so only the second is
      // reachable here — but it is classified rather than assumed.
      const targets = await resolveClaimTargets(tx, tables, acquisition);
      if (targets.kind === 'refused') {
        throw new MovementRollbackSignal(
          targets.result.outcome === 'agent-disposed' ? { outcome: 'agent-disposed' } : { outcome: 'not-found' },
        );
      }
      continue;
    }

    const authorization = await resolveTakeoverAuthorization(tx, tables, acquisition, incumbent, false);
    if (authorization !== undefined) {
      const taken = await takeOverClaimRow(tx, tables, acquisition, incumbent, authorization, now);
      if (taken !== undefined) return taken;
      // The takeover matched nothing, so the key is no longer what the read
      // above described. Classify against the key as it stands *now*, never
      // against the pre-read row: the same rule the claim path's takeover
      // follows, and for the same reason — a holder reported from a stale read
      // names a generation that may already be gone.
      const current = await readClaimByKey(tx, tables, acquisition);
      // Freed while this transaction ran: the key is acquirable again, so the
      // loop retries as the plain acquisition it now is rather than inventing a
      // holder from the row that vanished.
      if (current === undefined) continue;
      throw new MovementRollbackSignal({ outcome: 'already-claimed', holder: mapClaim(current) });
    }
    throw new MovementRollbackSignal({ outcome: 'already-claimed', holder: mapClaim(incumbent) });
  }

  throw new Error(
    `session ownership movement could not acquire the key ${acquisition.machineId}/${acquisition.adapterId}/${acquisition.providerSessionId}: it was taken and freed by a competitor on every attempt`,
  );
}

/**
 * Retire every other generation the agent still holds.
 *
 * Only a `confirmed` movement retires anything: it names the successor the
 * provider acknowledged, which is what makes the generations it replaces
 * genuinely dead. A `demote` deletes nothing — only a clean release frees a key,
 * and the provider may still be live under the ID being voided.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param agentId - Agent whose predecessors are being retired.
 * @param effectiveClaimId - The generation the settle writes through, which stays.
 * @returns Provider sessions whose keys are now free.
 */
async function retirePredecessors(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  agentId: string,
  effectiveClaimId: string,
): Promise<string[]> {
  const { adapterSessionClaims } = tables;
  const deleted = await tx
    .delete(adapterSessionClaims)
    .where(
      and(
        eq(adapterSessionClaims.agentId, agentId),
        eq(adapterSessionClaims.status, 'held'),
        ne(adapterSessionClaims.claimId, effectiveClaimId),
      ),
    )
    .returning({ providerSessionId: adapterSessionClaims.providerSessionId });
  return deleted.map((row) => row.providerSessionId);
}

/**
 * Re-express a refused settle as the movement's own outcome.
 *
 * `idempotent` is the only one that gains anything: it names the effective
 * generation, so a caller that repeated an already-recorded movement still
 * learns which generation the currency stands under. The rest carry across
 * verbatim — the movement adds no information a settle refusal does not already
 * have.
 * @param refusal - What the guarded settle reported.
 * @param generation - The effective generation the settle was attempted under.
 * @returns The movement outcome to report after the rollback.
 */
function asMovementRefusal(
  refusal: Exclude<Awaited<ReturnType<typeof runSettleStatements>>, { outcome: 'settled' }>,
  generation: ClaimRow,
): SessionOwnershipSettleMovementResult {
  if (refusal.outcome === 'idempotent') {
    return {
      outcome: 'idempotent',
      revision: refusal.revision,
      currency: refusal.currency,
      sessionSnapshotUpdated: false,
      claim: mapClaim(generation),
    };
  }
  return refusal;
}

/**
 * Return a pre-generation outcome without retaining a newly allocated runtime row.
 * @param result - Outcome reached before any generation was usable.
 * @param ownerInserted - Whether this transaction allocated the runtime row.
 * @returns The outcome when no rollback is necessary.
 * @throws {@link MovementRollbackSignal} when the runtime allocation must roll back.
 */
function refuseBeforeGeneration(
  result: SessionOwnershipSettleMovementResult,
  ownerInserted: boolean,
): SessionOwnershipSettleMovementResult {
  if (ownerInserted) throw new MovementRollbackSignal(result);
  return result;
}

/**
 * Build the claim identity allocated by a provider-session movement.
 * @param payload - Movement whose successor is being allocated.
 * @param ownerInstanceId - Runtime instance allocating the generation.
 * @param providerSessionId - Successor provider key.
 * @returns Claim identity used by the acquisition statements.
 */
function movementAcquisition(
  payload: SessionOwnershipSettleMovementRequest,
  ownerInstanceId: string,
  providerSessionId: string,
): ClaimAcquisition {
  return {
    machineId: payload.machineId,
    adapterId: payload.adapterId,
    adapterName: payload.adapterName,
    providerSessionId,
    sessionId: payload.sessionId,
    agentId: payload.agentId,
    ownerInstanceId,
    topology: payload.topology,
    claimToken: payload.movement.claimToken,
  };
}

/**
 * Record a provider-session movement in full.
 * @param db - Database handle.
 * @param payload - Movement request.
 * @returns The modeled movement outcome.
 */
export async function runSettleMovement(
  db: MakaioDatabase,
  payload: SessionOwnershipSettleMovementRequest,
): Promise<SessionOwnershipSettleMovementResult> {
  const tables = resolveSchema(db, sessionStorageSchema);
  const now = Date.now();
  const ownerInstance = payload.ownerInstance;
  if (ownerInstance === undefined) throw new Error('session ownership movement requires ownerInstance');

  try {
    return await executeTransaction(db, async (tx): Promise<SessionOwnershipSettleMovementResult> => {
      const owner = await ensureRuntimeInstance(
        tx,
        tables,
        { instanceId: ownerInstance.instanceId, machineId: payload.machineId },
        now,
      );

      // The agent row is locked for the whole transaction, so the membership and
      // liveness guards below are stated against a row no other transaction can
      // change until this one ends. The claim-table statements still carry their
      // own guards — those rows are not locked here.
      const agent = await lockAgentAllocation(tx, tables, payload.agentId);
      if (agent === undefined || agent.sessionId !== payload.sessionId) {
        return refuseBeforeGeneration({ outcome: 'not-found' }, owner.inserted);
      }
      if (agent.status === 'disposed') {
        return refuseBeforeGeneration({ outcome: 'agent-disposed' }, owner.inserted);
      }

      const target = resolveMovementTarget(payload.movement, agent);
      if (target === null) {
        // A demotion of an agent with nothing resumable resolves no key, so it
        // names no generation and there is nothing to write.
        return refuseBeforeGeneration(
          {
            outcome: 'idempotent',
            revision: agent.revision,
            currency: mapCurrency(agent),
            sessionSnapshotUpdated: false,
            claim: null,
          },
          owner.inserted,
        );
      }

      const acquisition = movementAcquisition(payload, ownerInstance.instanceId, target.providerSessionId);

      await acquireTransactionLocks(db, tx, [
        acquisitionOwnershipClaimTransactionLock(acquisition),
        ...(await readHeldOwnershipClaimTransactionLocks(tx, tables, payload.agentId)),
      ]);

      const generation =
        (await readOwnGeneration(tx, tables, acquisition)) ?? (await allocateSuccessor(tx, tables, acquisition, now));

      const releasedProviderSessionIds =
        payload.movement.kind === 'confirmed'
          ? await retirePredecessors(tx, tables, payload.agentId, generation.claimId)
          : [];

      const settled = await runSettleStatements(tx, tables, {
        agentId: payload.agentId,
        claimToken: generation.claimToken,
        fence: generation.fence,
        expectedRevision: payload.expectedRevision,
        target: target.currency,
      });
      if (settled.outcome !== 'settled') throw new MovementRollbackSignal(asMovementRefusal(settled, generation));

      const persistedGeneration = await adoptSettledLegacyGeneration(tx, tables, generation, ownerInstance.instanceId);
      return {
        outcome: 'settled',
        revision: settled.revision,
        currency: settled.currency,
        sessionSnapshotUpdated: settled.sessionSnapshotUpdated,
        releasedProviderSessionIds,
        claim: mapClaim(persistedGeneration),
      };
    });
  } catch (error) {
    if (error instanceof MovementRollbackSignal) return error.result;
    throw error;
  }
}
