/**
 * Row mapping and row-producing SQL for the `storage:sessionOwnership` handlers.
 *
 * These are the mechanical halves of the aggregate — how a stored row reads as a
 * contract record, and how the statements that select rows are spelled. The
 * decisions that carry the ownership invariant (which statement runs first, what
 * a failed predicate means) stay with the operations in
 * `ownership-drizzle-handler.ts` and `ownership-drizzle-settle.ts`.
 *
 * {@link lockAgentAllocation} lives here for the same reason: it is the one
 * statement every operation of the aggregate opens with, and none of them owns
 * it. It is mechanism, not decision — what a zero-row lock *means* differs per
 * operation and is stated at each call site.
 * @packageDocumentation
 */
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { TransactionCallback } from '@makaio/storage-drizzle';
import type {
  AdapterSessionClaimRecord,
  AdapterSessionCurrencySnapshot,
  SessionOwnershipListClaimsRequest,
} from '@makaio/contracts';
import { sessionStorageSchema } from './schema.variants.js';

/**
 * Session storage tables resolved through the dialect seam.
 *
 * The `.sqlite` face is the canonical static type for both dialects, so this is
 * exactly what `resolveSchema` returns regardless of the active backend.
 */
export type OwnershipTables = typeof sessionStorageSchema.sqlite;

/** Row of `adapter_session_claims`. */
export type ClaimRow = OwnershipTables['adapterSessionClaims']['$inferSelect'];

/** Row of `agents`. */
export type AgentRow = OwnershipTables['agents']['$inferSelect'];

/** Transaction context handed to an `executeTransaction` callback. */
export type OwnershipTransaction = Parameters<TransactionCallback<unknown>>[0];

/**
 * Serialize this agent's whole ownership state machine against every other
 * operation on it.
 *
 * A fence is totally ordered **per agent**, but the statements that allocate one
 * derive it from the agent's own state — its `currency_fence` and the fences of
 * the claims it holds — and nothing in that derivation is unique-indexed against
 * a *different* ownership key. Two processes claiming two distinct keys for the
 * same agent therefore both read a state without the other's claim under READ
 * COMMITTED, both allocate the same fence, and the per-key unique index has no
 * reason to object. Equal fences are what the contract's strictly-increasing
 * order exists to prevent: a settle from either generation then passes the
 * other's guard.
 *
 * **Claim, settle and release all open with this lock**, so the agents row is
 * the single point at which the aggregate's per-agent transitions are ordered.
 * A settle and a release are otherwise unordered against each other: the release
 * never touches the agents row, and the settle's authority `exists` is a plain
 * subquery, whose snapshot READ COMMITTED does *not* refresh when the row the
 * statement locks turns out to be a newer version. (PostgreSQL's EvalPlanQual
 * re-evaluates the quals of the *updated* row against the new version, but the
 * subquery inside them keeps the statement's original snapshot — so a settle
 * that started while the claim was still `held` could commit after a release had
 * already freed the key.) Taking this lock first pushes the settle's guarded
 * UPDATE into a *second* statement, whose fresh snapshot sees whatever the
 * release committed while the settle waited here.
 *
 * A self-update is the portable lock seam this codebase already uses (see
 * `lockWorklogSummaryForUsage`): PostgreSQL holds the row lock until the
 * transaction ends, so the second caller runs only after the first has
 * committed; SQLite acquires its writer lock, on top of the serialized handle
 * that already orders these transactions. It is written first so each
 * transaction stays write-first throughout.
 *
 * **This lock is serialization, not authority.** Nothing downstream may read it
 * as permission: every write below still carries its whole predicate — the
 * membership guards, the token CAS, the fence floor computed in-statement.
 * The unique index over `(agent_id, fence)` is the standing net underneath, so a
 * path that ever forgets this lock is refused by the database rather than
 * silently allocating a duplicate.
 *
 * **What a zero-row lock means is the caller's to decide**, and the callers
 * disagree: an operation that allocates a fence must refuse (there is nothing to
 * serialize against, and the agent may be committed right after), while one that
 * only retires a claim row must proceed (a claim whose agent is gone must stay
 * releasable). Each call site states its own policy.
 * **The locked row is returned, and reading it is not a read-then-write.** Once
 * this statement has taken the row, no other transaction can change it until
 * this one ends, so a guard stated against the returned row holds for the rest
 * of the operation just as firmly as a conjunct would. The keyless reservation
 * and the movement settle state their membership and `disposed` guards that way;
 * every operation that also writes the *claims* table still carries its guards
 * in the statements that touch it, because those rows are not locked here.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param agentId - Agent whose ownership transitions are being serialized.
 * @returns The locked agent row, or `undefined` when no agent row exists.
 */
export async function lockAgentAllocation(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  agentId: string,
): Promise<AgentRow | undefined> {
  const { agents } = tables;
  // Known cost, deliberately carried: on Postgres a self-update writes a new
  // tuple version per operation, so heavy claim churn adds autovacuum pressure
  // on `agents` that a `select … for update` would avoid. That spelling is not
  // expressible through this SQLite-typed transaction face without a dialect
  // seam, and ownership operations are per provider-session lifecycle events,
  // not per message — revisit only if vacuum statistics on `agents` say so.
  const [locked] = await tx
    .update(agents)
    .set({ currencyFence: agents.currencyFence })
    .where(eq(agents.agentId, agentId))
    .returning();
  return locked;
}

/**
 * Bind a caller-supplied text value with an explicit type.
 *
 * The acquiring statement is an `INSERT ... SELECT`, whose select list is parsed
 * independently of the insert target on Postgres, so an unannotated parameter
 * there has no type to resolve against. Casting is portable: SQLite reads the
 * type name as an affinity, Postgres as the parameter's resolved type.
 * @param value - Text value to bind.
 * @returns Typed SQL expression for the select list.
 */
function asText(value: string): SQL {
  return sql`cast(${value} as text)`;
}

/**
 * Bind a caller-supplied millisecond timestamp with an explicit type.
 * @param value - Epoch-millisecond value to bind.
 * @returns Typed SQL expression for the select list.
 */
function asEpochMs(value: number): SQL {
  return sql`cast(${value} as bigint)`;
}

/**
 * Bind a caller-supplied integer with an explicit type.
 *
 * Same reason as {@link asText}: a bare parameter inside a `case` expression has
 * no column to resolve its type against on Postgres.
 * @param value - Integer value to bind.
 * @returns Typed SQL expression.
 */
function asInt(value: number): SQL {
  return sql`cast(${value} as integer)`;
}

/**
 * The greater of two integer expressions.
 *
 * `greatest` is Postgres-only and `max(a, b)` is SQLite-only, so the comparison
 * is spelled as a `case`, which both dialects parse identically.
 * @param left - First expression.
 * @param right - Second expression.
 * @returns SQL expression yielding the greater of the two.
 */
function greatestOf(left: SQL, right: SQL): SQL {
  return sql`(case when ${left} > ${right} then ${left} else ${right} end)`;
}

/**
 * The highest fence any claim the agent currently holds carries, or `0`.
 *
 * Read as a scalar subquery rather than in a preceding statement so the fence
 * allocation stays inside the single acquiring INSERT — the write must remain
 * the transaction's first statement.
 * @param tables - Dialect-resolved session storage tables.
 * @param agentId - Agent whose live claims bound the allocation.
 * @returns Scalar SQL expression yielding the agent's highest live claim fence.
 */
function agentLiveClaimFence(tables: OwnershipTables, agentId: string): SQL {
  const { adapterSessionClaims } = tables;
  return sql`coalesce((select max(${adapterSessionClaims.fence}) from ${adapterSessionClaims}
    where ${eq(adapterSessionClaims.agentId, agentId)}), 0)`;
}

/**
 * The fence that currently governs the agent's currency, read live.
 *
 * A scalar subquery rather than a value carried in from a preceding read: a
 * settle by the same agent under another generation raises `currency_fence` and
 * may release the claim that authored it in the same breath, so a fence
 * allocated against a value read earlier can land *below* the one already
 * governing the currency — after which every settle under the new generation
 * classifies as `superseded`.
 * @param tables - Dialect-resolved session storage tables.
 * @param agentId - Agent whose currency fence bounds the allocation.
 * @returns Scalar SQL expression yielding the agent's currency fence.
 */
function agentCurrencyFence(tables: OwnershipTables, agentId: string): SQL {
  const { agents } = tables;
  return sql`coalesce((select ${agents.currencyFence} from ${agents}
    where ${eq(agents.agentId, agentId)}), 0)`;
}

/**
 * Allocate a fence strictly above everything the claiming agent already carries.
 *
 * A fence is totally ordered per agent, not per ownership key: an agent holding
 * a live claim must not be able to take a second key at the same fence, or a
 * settle from either generation would pass the other's guard. The floor is
 * therefore the greatest of the agent's `currency_fence`, the fences of its live
 * claims, and — on a takeover — the superseded row's fence.
 * @param tables - Dialect-resolved session storage tables.
 * @param agentId - Agent the claim is being allocated for.
 * @param floor - The part of the floor known outside the claim table.
 * @returns SQL expression yielding the fence to allocate.
 */
function fenceAllocation(tables: OwnershipTables, agentId: string, floor: SQL): SQL {
  return sql`1 + ${greatestOf(floor, agentLiveClaimFence(tables, agentId))}`;
}

/**
 * Fence for a takeover: above the superseded row and the taker's own state.
 *
 * The taking agent's `currency_fence` and its live claims are read *inside* the
 * takeover UPDATE, for the same reason the acquiring INSERT allocates its fence
 * within its own statement: only a value the write itself computes is guaranteed
 * to still hold when the write lands. A fence allocated against a `currency_fence`
 * read earlier can land *below* the one already governing the currency — after
 * which every settle under the new generation classifies as `superseded`.
 *
 * The superseded row's fence is the one part of the floor that may be carried in
 * from the classifying read, because the takeover's own predicate pins it: a
 * claim row's fence only ever changes together with its `claimToken`, and the
 * UPDATE refuses any row whose token is no longer the one that was read.
 * @param tables - Dialect-resolved session storage tables.
 * @param agentId - Agent taking the claim over.
 * @param supersededFence - Fence of the row being taken over, as read under the
 *   token the UPDATE's predicate re-states.
 * @returns SQL expression yielding the fence to allocate.
 */
export function buildTakeoverFence(tables: OwnershipTables, agentId: string, supersededFence: number): SQL {
  return fenceAllocation(tables, agentId, greatestOf(asInt(supersededFence), agentCurrencyFence(tables, agentId)));
}

/**
 * Map a claim row onto the contract's claim record.
 * @param row - Row from `adapter_session_claims`.
 * @returns The claim as the contract reports it.
 */
export function mapClaim(row: ClaimRow): AdapterSessionClaimRecord {
  return {
    claimId: row.claimId,
    machineId: row.machineId,
    adapterId: row.adapterId,
    adapterName: row.adapterName,
    providerSessionId: row.providerSessionId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    claimToken: row.claimToken,
    fence: row.fence,
    status: row.status,
    claimedAt: row.claimedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Read an agent row's currency trias.
 *
 * Absent columns map to `null` rather than `undefined`: the contract's snapshot
 * models "never known" as `null`, and leaving the field off would make an
 * unwritten currency indistinguishable from a missing property.
 * @param row - Row from `agents`.
 * @returns The agent's currency trias.
 */
export function mapCurrency(row: AgentRow): AdapterSessionCurrencySnapshot {
  return {
    adapterSessionId: row.adapterSessionId ?? null,
    currentAdapterSessionId: row.currentAdapterSessionId ?? null,
    currentAdapterSessionIdState: row.currentAdapterSessionIdState,
  };
}

/**
 * Everything a claim generation needs, independent of which RPC allocates it.
 *
 * `claim` and `settleMovement` both allocate generations and must allocate them
 * identically — same guards, same fence rule, same unique index. Naming the
 * inputs once is what keeps the two from drifting: neither operation can add a
 * guard the other silently lacks.
 */
export interface ClaimAcquisition {
  /** Stable runtime machine identity that owns the provider-native session store. */
  readonly machineId: string;
  /** Adapter runtime instance that owns the provider process. */
  readonly adapterId: string;
  /** Adapter type name of the owning runtime, carried for diagnostics. */
  readonly adapterName: string;
  /** Provider session the key is being taken on. */
  readonly providerSessionId: string;
  /** Session the claiming agent belongs to. */
  readonly sessionId: string;
  /** Agent that will own the provider session. */
  readonly agentId: string;
  /** Caller-minted identity for the generation being taken. */
  readonly claimToken: string;
}

/**
 * How much a statement demands of the agent it writes on behalf of.
 *
 * - `live` — the agent must exist, be a member of the named session, and not be
 *   `disposed`. Every statement that can *end in ownership* demands this.
 * - `any-status` — membership only. The one act a removed agent must still be
 *   able to perform is giving authority *up*: clearing its own lead designation,
 *   and retiring its claims. Demanding liveness there would strand exactly the
 *   designations and keys that most need retiring.
 */
export type AgentGuardMode = 'live' | 'any-status';

/**
 * Restate the agent a statement writes on behalf of as its own predicate.
 *
 * Every statement that can end in ownership repeats this — the acquiring SELECT,
 * both takeover UPDATEs, the lead designation — rather than trusting a preceding
 * read, because `storage:agent.set` and `storage:agent.updateStatus` can move or
 * dispose the agent at any instant and nothing pins its row for the statements
 * that touch the *claims* table. `disposed` is absorbing for ownership: a
 * removed agent may never re-acquire authority, and a service-side status check
 * before the write is precisely the read-then-write this seam exists to remove.
 * @param tables - Dialect-resolved session storage tables.
 * @param agentId - Agent the statement acts for.
 * @param sessionId - Session the statement files the act under.
 * @param mode - How much the statement demands of that agent.
 * @returns Predicate over the agents table.
 */
export function buildAgentGuard(
  tables: OwnershipTables,
  agentId: string,
  sessionId: string,
  mode: AgentGuardMode,
): SQL {
  const { agents } = tables;
  return sql`exists (select 1 from ${agents} where ${and(
    eq(agents.agentId, agentId),
    eq(agents.sessionId, sessionId),
    ...(mode === 'live' ? [ne(agents.status, 'disposed')] : []),
  )})`;
}

/**
 * Build the SELECT that supplies the acquiring INSERT's row.
 *
 * The guards live in this statement rather than in a preceding read: the row is
 * produced only while the agent exists, its session exists, the agent is a
 * member of *that* session and the agent is not `disposed`, and the unique
 * ownership index decides the rest. The membership equality is what keeps a
 * claim from being filed under a session the owning agent has nothing to do with
 * — and, with a lead designation attached, from handing that session's lead to
 * it. The fence is allocated in the same statement by {@link fenceAllocation},
 * so an agent that already holds a live claim cannot take a second key at the
 * same fence.
 *
 * `INSERT ... SELECT` takes its column list from the table's full insertable
 * column order, so the select list is positional. Declaring it as a record keyed
 * by the row type makes an added column a compile error rather than a runtime
 * column-count mismatch; the literal order below is the schema's order.
 * @param tables - Dialect-resolved session storage tables.
 * @param acquisition - The generation being taken.
 * @param claimId - Identifier minted for the new claim row.
 * @param now - Acquisition timestamp.
 * @returns The guarded SELECT feeding the acquiring INSERT.
 */
export function buildAcquisitionSelect(
  tables: OwnershipTables,
  acquisition: ClaimAcquisition,
  claimId: string,
  now: number,
): SQL {
  const { agents, sessions } = tables;
  const columns: Record<keyof ClaimRow, SQL> = {
    claimId: asText(claimId),
    machineId: asText(acquisition.machineId),
    adapterId: asText(acquisition.adapterId),
    adapterName: asText(acquisition.adapterName),
    providerSessionId: asText(acquisition.providerSessionId),
    sessionId: asText(acquisition.sessionId),
    agentId: asText(acquisition.agentId),
    claimToken: asText(acquisition.claimToken),
    fence: fenceAllocation(tables, acquisition.agentId, sql`${agents.currencyFence}`),
    status: asText('held'),
    claimedAt: asEpochMs(now),
    updatedAt: asEpochMs(now),
  };

  return sql`select ${sql.join(Object.values(columns), sql`, `)} from ${agents}
    where ${eq(agents.agentId, acquisition.agentId)}
      and ${eq(agents.sessionId, acquisition.sessionId)}
      and ${ne(agents.status, 'disposed')}
      and exists (select 1 from ${sessions} where ${eq(sessions.sessionId, acquisition.sessionId)})`;
}

/**
 * Assignments that publish the designated lead's currency onto the session row.
 *
 * Both halves are correlated subqueries over the same agent row, so they are
 * spread into the `set` clause of the statement that publishes them rather than
 * applied as a statement of their own.
 */
export interface LeadCurrencyMirror {
  /** The lead's resume target, expressed in the session row's own terms. */
  readonly currentAdapterSessionId: SQL;
  /** The currency state that makes that target true of the session row. */
  readonly currentAdapterSessionIdState: SQL;
}

/**
 * Publish the designated lead's *resolved* currency onto the session row.
 *
 * Session currency is a persisted snapshot of the designated lead's currency, so
 * both statements that can make that snapshot stale publish the pair through
 * here: the claim's designating UPDATE, which promotes a new lead, and the
 * settle's mirror, which moves the standing lead's currency on. Spelling it as
 * correlated subqueries keeps it inside the statement it belongs to — the
 * designation's own UPDATE, and the settle's mirror running after the agent
 * UPDATE in the same transaction, where the subqueries see the pair just
 * written. No read stands between deciding the write and publishing its
 * snapshot.
 *
 * **The pair is resolved, not copied.** `inherited` does not name a provider
 * session, it points at *the row's own* `adapter_session_id`, and the two rows
 * have different origins: the session keeps the origin it was imported from,
 * while a lead that joined it carries its own. Copying `inherited` across
 * therefore publishes the *session's* origin as its resume target while the lead
 * resolves elsewhere — the one outcome this aggregate exists to prevent. Only
 * the pair's meaning is
 * translated, never invented: what is mirrored is exactly what
 * `resolveResumableAdapterSessionId` yields for the lead, re-expressed in the
 * only terms the session row has for it —
 * - the lead resolves to the session's own origin (including both being unknown)
 *   → `inherited`, which is what that already means on the session row;
 * - the lead resolves to some other provider session → `confirmed` naming it,
 *   the only state in which the session row can point away from its origin;
 * - the lead resolves to nothing → `moved`, the only state that says "nothing
 *   here is resumable" without naming an ID.
 *
 * `confirmed` and `moved` already name their target independently of the row's
 * origin, so they are mirrored unchanged.
 *
 * Null-safe equality is spelled out rather than delegated to the dialect
 * operators for it, which exist under different names on Postgres and SQLite.
 * Every branch pairs a non-null ID with `confirmed` and a null ID with
 * `inherited` or `moved`, so the `confirmed ↔ id is not null` CHECK holds on
 * both columns — including when the agent subquery finds no row at all, which
 * falls through to `moved` with a null ID.
 * @param tables - Dialect-resolved session storage tables.
 * @param agentId - Lead agent whose currency the session snapshot mirrors.
 * @returns Assignments for the session row's currency columns.
 */
export function buildLeadCurrencyMirror(tables: OwnershipTables, agentId: string): LeadCurrencyMirror {
  const { agents, sessions } = tables;
  const owner = eq(agents.agentId, agentId);
  const ofLead = (column: SQL): SQL => sql`(select ${column} from ${agents} where ${owner})`;

  const state = ofLead(sql`${agents.currentAdapterSessionIdState}`);
  const currentId = ofLead(sql`${agents.currentAdapterSessionId}`);
  const leadOrigin = ofLead(sql`${agents.adapterSessionId}`);
  const sessionOrigin = sql`${sessions.adapterSessionId}`;
  const sameOrigin = sql`(${leadOrigin} = ${sessionOrigin} or (${leadOrigin} is null and ${sessionOrigin} is null))`;

  return {
    currentAdapterSessionId: sql`(case
      when ${state} <> 'inherited' then ${currentId}
      when ${sameOrigin} then null
      when ${leadOrigin} is null then null
      else ${leadOrigin} end)`,
    currentAdapterSessionIdState: sql`(case
      when ${state} <> 'inherited' then ${state}
      when ${sameOrigin} then ${asText('inherited')}
      when ${leadOrigin} is null then ${asText('moved')}
      else ${asText('confirmed')} end)`,
  };
}

/**
 * Build the predicates narrowing a claim listing.
 *
 * `machineId` is always present: reconciliation is a per-machine act, and a
 * query that could span machines invites a takeover decision with no evidence
 * behind it.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Listing request.
 * @returns Predicates for the listing query.
 */
export function buildListClaimsPredicates(tables: OwnershipTables, payload: SessionOwnershipListClaimsRequest): SQL[] {
  const { adapterSessionClaims } = tables;
  const predicates: SQL[] = [eq(adapterSessionClaims.machineId, payload.machineId)];
  if (payload.adapterId !== undefined) predicates.push(eq(adapterSessionClaims.adapterId, payload.adapterId));
  if (payload.providerSessionId !== undefined) {
    predicates.push(eq(adapterSessionClaims.providerSessionId, payload.providerSessionId));
  }
  if (payload.statuses !== undefined) predicates.push(inArray(adapterSessionClaims.status, payload.statuses));
  return predicates;
}
