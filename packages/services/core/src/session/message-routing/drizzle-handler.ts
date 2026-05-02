import { eq, and } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext, MessageRouting, MessageRoutingStatus } from '@makaio/contracts';
import { MessageRoutingSubjects } from './namespace.js';
import { messageRouting, type SelectMessageRouting } from './schema.js';

/**
 * Convert database row to MessageRouting type.
 * @param row - Database row
 * @returns MessageRouting object
 */
function rowToRouting(row: SelectMessageRouting): MessageRouting {
  return {
    messageId: row.messageId,
    agentId: row.agentId,
    status: row.status as MessageRoutingStatus,
    timestamp: row.timestamp,
    error: row.error ?? undefined,
  };
}

/**
 * Register Drizzle-based message routing storage handlers.
 *
 * Manages message delivery tracking in SQLite/libSQL via Drizzle ORM.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unsubscribe all handlers
 */
export function registerDrizzleMessageRoutingStorage(
  bus: IMakaioBus,
  db: MakaioDatabase,
  _ctx: ExtensionContext,
): () => void {
  const unsubs: Array<() => void> = [];

  // storage:messageRouting.record
  unsubs.push(
    bus.on(MessageRoutingSubjects.record, async (ctx) => {
      const { messageId, agentId, status, timestamp, error } = ctx.payload;

      await db
        .insert(messageRouting)
        .values({
          messageId,
          agentId,
          status,
          timestamp,
          error: error ?? null,
        })
        .onConflictDoUpdate({
          target: [messageRouting.messageId, messageRouting.agentId, messageRouting.status],
          set: {
            timestamp,
            error: error ?? null,
          },
        });

      ctx.setResult({ success: true });
    }),
  );

  // storage:messageRouting.getByMessage
  unsubs.push(
    bus.on(MessageRoutingSubjects.getByMessage, async (ctx) => {
      const { messageId } = ctx.payload;

      const rows = await db.select().from(messageRouting).where(eq(messageRouting.messageId, messageId));

      ctx.setResult({ routing: rows.map(rowToRouting) });
    }),
  );

  // storage:messageRouting.getCompleted
  unsubs.push(
    bus.on(MessageRoutingSubjects.getCompleted, async (ctx) => {
      const { messageId } = ctx.payload;

      const rows = await db
        .select()
        .from(messageRouting)
        .where(and(eq(messageRouting.messageId, messageId), eq(messageRouting.status, 'completed')));

      ctx.setResult({ agentIds: rows.map((r) => r.agentId) });
    }),
  );

  // storage:messageRouting.isComplete
  unsubs.push(
    bus.on(MessageRoutingSubjects.isComplete, async (ctx) => {
      const { messageId, targetAgentIds } = ctx.payload;

      const rows = await db
        .select()
        .from(messageRouting)
        .where(and(eq(messageRouting.messageId, messageId), eq(messageRouting.status, 'completed')));

      const completedAgentIds = new Set(rows.map((r) => r.agentId));
      const pending = targetAgentIds.filter((id) => !completedAgentIds.has(id));

      ctx.setResult({
        complete: pending.length === 0,
        pending,
      });
    }),
  );

  return () => unsubs.forEach((fn) => fn());
}
