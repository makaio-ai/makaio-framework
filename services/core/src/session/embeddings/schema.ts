import { sqliteTable, text, integer, blob, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Embeddings table schema.
 *
 * Flexible storage for vector embeddings from any model.
 * Source of truth for all embeddings. Dynamic indexed tables
 * (embeddings_idx_MODEL) are created per-model for vector search.
 *
 * Design rationale:
 * - `entityType` + `entityId` enables embedding sessions, messages, or other entities
 * - `model` tracks which embedding model was used
 * - `dimensions` enables validation and table routing
 * - `embedding` as BLOB for flexible storage (not F32_BLOB - that's in indexed tables)
 * - Multiple embeddings per entity allowed (one per model)
 */
export const embeddings = sqliteTable(
  'embeddings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    content: text('content'),
    embedding: blob('embedding', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_embeddings_entity').on(table.entityType, table.entityId),
    index('idx_embeddings_model').on(table.model),
    // Unique constraint: one embedding per entity per model
    uniqueIndex('idx_embeddings_unique').on(table.entityType, table.entityId, table.model),
  ],
);

export type InsertEmbedding = typeof embeddings.$inferInsert;
export type SelectEmbedding = typeof embeddings.$inferSelect;
