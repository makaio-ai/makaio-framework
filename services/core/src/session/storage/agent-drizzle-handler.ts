import { eq, and, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { didAffectRows, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { CompressionModeSchema, type MakaioSessionAgent } from '@makaio/contracts';
import { AgentStorageSubjects } from './agent-namespace.js';
import { sessionStorageSchema } from './schema.variants.js';

/** Canonical column shape of the agents table, resolved through the dialect seam. */
type AgentsTable = typeof sessionStorageSchema.sqlite.agents;
type AgentRow = AgentsTable['$inferSelect'];

/**
 * Handler dependencies for agent storage handlers.
 */
interface AgentHandlerDeps {
  bus: IMakaioBus;
  db: MakaioDatabase;
}

/**
 * Map database row to MakaioSessionAgent API type.
 * @param row - The agent table row
 * @returns The mapped agent object
 */
export function mapAgent(row: AgentRow): MakaioSessionAgent {
  return {
    agentId: row.agentId,
    adapterId: row.adapterId,
    adapterName: row.adapterName,
    sessionId: row.sessionId,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    model: row.model ?? undefined,
    adapterSessionId: row.adapterSessionId ?? undefined,
    cwd: row.cwd ?? undefined,
    allowedDirectories: row.allowedDirectories ?? undefined,
    providerConfigId: row.providerConfigId ?? undefined,
    personaId: row.personaId ?? undefined,
    profileId: row.profileId ?? undefined,
    harnessId: row.harnessId ?? undefined,
    clientId: row.clientId ?? undefined,
    compressionMode: row.compressionMode ? CompressionModeSchema.parse(row.compressionMode) : undefined,
    currentAdapterSessionId: row.currentAdapterSessionId ?? undefined,
    currentAdapterSessionIdState: row.currentAdapterSessionIdState,
    revision: row.revision,
    currencyFence: row.currencyFence,
  };
}

/**
 * Map MakaioSessionAgent to DB column values (for insert/update).
 *
 * The ownership columns (`currentAdapterSessionId`,
 * `currentAdapterSessionIdState`, `revision`, `currencyFence`) are deliberately
 * absent: `set` is a whole-record write of a caller-held snapshot, so carrying
 * them would let a writer that read the agent before a provider-session movement
 * resurrect the abandoned provider session — and reset the very counters that
 * reject such a write. Omitting them here leaves the insert to the column
 * defaults and the conflict update untouched. They are written exclusively
 * through the `storage:sessionOwnership` seam.
 *
 * `adapterSessionId` — the agent's origin provider session, and the fifth
 * column a `set` may not overwrite — is present here because a *fresh* row has
 * no stored origin to protect and must take the caller's. On an existing row it
 * is dropped again by {@link toConflictValues}.
 * @param agent - The agent to convert
 * @returns DB column values for insert/update operations
 */
function toDbValues(agent: MakaioSessionAgent): AgentsTable['$inferInsert'] {
  return {
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    adapterName: agent.adapterName,
    sessionId: agent.sessionId,
    role: agent.role,
    status: agent.status,
    createdAt: agent.createdAt,
    lastActivityAt: agent.lastActivityAt,
    model: agent.model ?? null,
    adapterSessionId: agent.adapterSessionId ?? null,
    cwd: agent.cwd ?? null,
    allowedDirectories: agent.allowedDirectories ?? null,
    providerConfigId: agent.providerConfigId ?? null,
    personaId: agent.personaId ?? null,
    profileId: agent.profileId ?? null,
    harnessId: agent.harnessId ?? null,
    clientId: agent.clientId ?? null,
    compressionMode: agent.compressionMode ?? null,
  };
}

/**
 * Narrow the whole-record write to the columns it may change on an existing row.
 *
 * `adapterSessionId` is the agent's *origin* provider session — the only
 * resumable ID an agent whose currency is still `inherited` has. A `set` writes
 * a caller-held snapshot, and a caller that never read the origin (identity
 * enrichment) or read it before it was written would otherwise erase it. So on
 * conflict the stored origin wins; the insert path keeps the caller's value,
 * because a fresh row has no origin to lose. Changing the origin of a live agent
 * has its own seam, `storage:agent.updateRuntime`, which carries the field and
 * only writes it when the caller actually supplies one.
 *
 * `status` survives the narrowing but stops being the caller's value in one
 * case: a stored `disposed` wins, because disposal is the agent's removal and is
 * terminal — the rule {@link registerUpdateStatusHandler} enforces on the
 * dedicated seam. A whole-record write carries a snapshot read at some earlier
 * instant, so without the CASE a writer that read the agent before the removal
 * would revive the row and, with it, every ownership predicate that refuses a
 * disposed agent. Every other stored status is still overwritten, which is what
 * keeps an ordinary post-start persistence writing `idle`.
 * @param values - Full column values produced by {@link toDbValues}
 * @param agents - Dialect-resolved agents table, for the existing row's columns
 * @returns The same values without the origin column, with `status` merged
 */
function toConflictValues(
  values: AgentsTable['$inferInsert'],
  agents: AgentsTable,
): Omit<AgentsTable['$inferInsert'], 'adapterSessionId' | 'status'> & { status: SQL } {
  const { adapterSessionId: _storedOriginWins, status: _terminalDisposedWins, ...conflictValues } = values;
  return {
    ...conflictValues,
    status: sql`CASE WHEN ${agents.status} = 'disposed' THEN ${agents.status} ELSE excluded.status END`,
  };
}

/**
 * Run handler cleanups in reverse registration order without leaking later teardowns.
 * @param cleanups - Registered cleanup callbacks
 */
function cleanupHandlers(cleanups: ReadonlyArray<() => void>): void {
  let firstError: unknown;
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    try {
      cleanups[index]?.();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) {
    throw firstError;
  }
}

/**
 * Register handler for storage:agent.get.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetHandler(deps: AgentHandlerDeps): () => void {
  const { bus, db } = deps;
  const { agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(AgentStorageSubjects.get, async (ctx) => {
    const [row] = await db.select().from(agents).where(eq(agents.agentId, ctx.payload.agentId)).limit(1);

    ctx.setResult({ agent: row ? mapAgent(row) : null });
  });
}

/**
 * Register handler for storage:agent.set.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerSetHandler(deps: AgentHandlerDeps): () => void {
  const { bus, db } = deps;
  const { agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(AgentStorageSubjects.set, async (ctx) => {
    const { agent } = ctx.payload;
    const dbValues = toDbValues(agent);

    const result = await db
      .insert(agents)
      .values(dbValues)
      .onConflictDoUpdate({
        target: agents.agentId,
        set: toConflictValues(dbValues, agents),
      });

    ctx.setResult({ success: didAffectRows(result) });
  });
}

/**
 * Register handler for storage:agent.delete.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerDeleteHandler(deps: AgentHandlerDeps): () => void {
  const { bus, db } = deps;
  const { agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(AgentStorageSubjects.delete, async (ctx) => {
    const result = await db.delete(agents).where(eq(agents.agentId, ctx.payload.agentId));

    ctx.setResult({ success: didAffectRows(result) });
  });
}

/**
 * Register handler for storage:agent.listByAdapter.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerListByAdapterHandler(deps: AgentHandlerDeps): () => void {
  const { bus, db } = deps;
  const { agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(AgentStorageSubjects.listByAdapter, async (ctx) => {
    const { adapterName, status } = ctx.payload;

    // Build WHERE clause
    const predicates = [eq(agents.adapterName, adapterName)];

    // Only filter by status if it's not 'all' or undefined
    if (status && status !== 'all') {
      predicates.push(eq(agents.status, status));
    }

    const whereClause = predicates.length > 1 ? and(...predicates) : predicates[0];
    const rows = await db.select().from(agents).where(whereClause);

    ctx.setResult({ agents: rows.map(mapAgent) });
  });
}

/**
 * Register handler for storage:agent.listBySession.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerListBySessionHandler(deps: AgentHandlerDeps): () => void {
  const { bus, db } = deps;
  const { agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(AgentStorageSubjects.listBySession, async (ctx) => {
    const { sessionId } = ctx.payload;
    const rows = await db.select().from(agents).where(eq(agents.sessionId, sessionId));

    ctx.setResult({ agents: rows.map(mapAgent) });
  });
}

/**
 * Register handler for storage:agent.updateStatus.
 *
 * Carries the terminal-`disposed` rule: a removed agent's row never transitions
 * again, so the refusal is a conjunct of the write's own predicate rather than a
 * check some caller could forget or race.
 *
 * **What a refusal does not do — and who is expected to notice.** The refusal
 * reports `{ success: true, transitioned: false }`: the row is there, this call
 * did not write it. A lifecycle caller that *created something live* before
 * writing the status has to read that bit, because the refusal means the row it
 * is describing was removed while it worked. The reserved paths this wave owns
 * do: a start settles after its dispatch, and a settlement for a removed agent
 * answers `agent-disposed`, which stops the connector and releases the key.
 *
 * The rehydrate path does not, and cannot yet. Its `idle` write is the adapter's
 * (`ai-adapter-rehydration`), unconditional and outside this wave's boundary, so
 * a removal landing mid-rehydrate can leave a live connector attached to a
 * disposed row. That is the open question this wave records rather than closes:
 * bringing rehydrate under the authority — a reserved phase, a status
 * compare-and-swap and a typed disposition — is what makes the refusal
 * actionable there, and it lands with the rest of the rehydrate work.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerUpdateStatusHandler(deps: AgentHandlerDeps): () => void {
  const { bus, db } = deps;
  const { agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(AgentStorageSubjects.updateStatus, async (ctx) => {
    const { agentId, status, expectedStatus } = ctx.payload;
    const now = Date.now();

    // Write first, with both refusals as conjuncts of the write's own predicate:
    // a read that decided whether the transition is permitted would be a
    // different instant than the one the write lands in, which is exactly the
    // race a compare-and-swap exists to remove.
    //
    // The `disposed` conjunct is unconditional and outranks `expectedStatus`,
    // including an expectation naming `disposed` itself. Disposal is the agent's
    // removal; letting any later write hand the row a live-looking status would
    // let it re-enter every ownership predicate that refuses a disposed agent.
    const predicates = [eq(agents.agentId, agentId), ne(agents.status, 'disposed')];
    if (expectedStatus) predicates.push(inArray(agents.status, expectedStatus));

    const result = await db
      .update(agents)
      .set({ status, lastActivityAt: now })
      .where(and(...predicates));

    if (didAffectRows(result)) {
      ctx.setResult({ success: true, transitioned: true });
      return;
    }

    // Zero rows has two causes — absent, or present and refused — and only a read
    // can tell them apart, so the read runs here to *classify* a write that
    // already failed, never to authorize one.
    //
    // Deliberately not transactional with the write above. `transitioned: false`
    // is already settled and is the only answer a caller acts on; `success` is
    // diagnostic, and a row deleted between the two statements is honestly
    // reported as gone.
    const [row] = await db.select({ agentId: agents.agentId }).from(agents).where(eq(agents.agentId, agentId)).limit(1);

    ctx.setResult({ success: row !== undefined, transitioned: false });
  });
}

/**
 * Register handler for storage:agent.updateActivity.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerUpdateActivityHandler(deps: AgentHandlerDeps): () => void {
  const { bus, db } = deps;
  const { agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(AgentStorageSubjects.updateActivity, async (ctx) => {
    const { agentId, lastActivityAt } = ctx.payload;

    const result = await db.update(agents).set({ lastActivityAt }).where(eq(agents.agentId, agentId));

    ctx.setResult({ success: didAffectRows(result) });
  });
}

/**
 * Register handler for storage:agent.updateRuntime.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerUpdateRuntimeHandler(deps: AgentHandlerDeps): () => void {
  const { bus, db } = deps;
  const { agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(AgentStorageSubjects.updateRuntime, async (ctx) => {
    const { agentId, adapterId, adapterSessionId, cwd, model, allowedDirectories, providerConfigId } = ctx.payload;
    const now = Date.now();
    const updateFields: Partial<AgentsTable['$inferInsert']> = {
      lastActivityAt: now,
    };

    if (adapterId !== undefined) updateFields.adapterId = adapterId;
    if (adapterSessionId !== undefined) updateFields.adapterSessionId = adapterSessionId;
    if (cwd !== undefined) updateFields.cwd = cwd;
    if (model !== undefined) updateFields.model = model;
    if (allowedDirectories !== undefined) updateFields.allowedDirectories = allowedDirectories;
    if (providerConfigId !== undefined) updateFields.providerConfigId = providerConfigId;

    const result = await db.update(agents).set(updateFields).where(eq(agents.agentId, agentId));

    ctx.setResult({ success: didAffectRows(result) });
  });
}

/**
 * Register Drizzle-based agent storage handlers.
 *
 * Persists agents via Drizzle ORM.
 * Provides durable storage suitable for production deployments.
 * @param bus - The bus instance to register handlers on
 * @param db - The MakaioDatabase instance
 * @returns Cleanup function to unsubscribe all handlers
 * @example
 * ```typescript
 * import { registerDrizzleAgentStorage } from '@makaio/services-core/session';
 * import { drizzle } from 'drizzle-orm/libsql';
 * import { createClient } from '@libsql/client';
 *
 * const client = createClient({ url: 'file:./makaio.db' });
 * const db = drizzle(client);
 * const cleanup = registerDrizzleAgentStorage(bus, db);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerDrizzleAgentStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const deps: AgentHandlerDeps = { bus, db };
  const cleanups = [
    registerGetHandler(deps),
    registerSetHandler(deps),
    registerDeleteHandler(deps),
    registerListByAdapterHandler(deps),
    registerListBySessionHandler(deps),
    registerUpdateStatusHandler(deps),
    registerUpdateActivityHandler(deps),
    registerUpdateRuntimeHandler(deps),
  ];

  return () => cleanupHandlers(cleanups);
}
