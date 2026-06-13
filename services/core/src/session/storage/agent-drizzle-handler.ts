import { eq, and } from 'drizzle-orm';
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
  };
}

/**
 * Map MakaioSessionAgent to DB column values (for insert/update).
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

    const result = await db.insert(agents).values(dbValues).onConflictDoUpdate({
      target: agents.agentId,
      set: dbValues,
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
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerUpdateStatusHandler(deps: AgentHandlerDeps): () => void {
  const { bus, db } = deps;
  const { agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(AgentStorageSubjects.updateStatus, async (ctx) => {
    const { agentId, status } = ctx.payload;
    const now = Date.now();

    const result = await db.update(agents).set({ status, lastActivityAt: now }).where(eq(agents.agentId, agentId));

    ctx.setResult({ success: didAffectRows(result) });
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
    const { agentId, adapterId, cwd, model, allowedDirectories, providerConfigId } = ctx.payload;
    const now = Date.now();
    const updateFields: Partial<AgentsTable['$inferInsert']> = {
      lastActivityAt: now,
    };

    if (adapterId !== undefined) updateFields.adapterId = adapterId;
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
