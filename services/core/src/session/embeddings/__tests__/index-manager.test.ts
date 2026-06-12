/**
 * Tests for EmbeddingIndexManager - dynamic per-model index tables.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { getRawSqlExecutor, type MakaioDatabase } from '@makaio/storage-drizzle';
import { decodeEmbedding, EmbeddingIndexManager } from '../index-manager.js';

/**
 * Creates an in-memory SQLite database for testing.
 * Note: F32_BLOB and libsql_vector_idx may not be available in all environments.
 * @returns Test database context with db and cleanup
 */
async function createTestDb(): Promise<{ db: MakaioDatabase; cleanup: () => void }> {
  const { db, close } = await createDatabaseClient({ url: ':memory:' });
  return { db, cleanup: close };
}

/**
 * Select rows from a dynamically named table through the raw SQL executor.
 * @param db - Database handle to query.
 * @param tableName - Table to select from (test-controlled, not user input).
 * @param columns - Comma-separated column list or `*`.
 * @returns Rows typed as `T`.
 */
async function selectTableRows<T extends Record<string, unknown>>(
  db: MakaioDatabase,
  tableName: string,
  columns: string,
): Promise<T[]> {
  return getRawSqlExecutor(db).all<T>(sql.raw(`SELECT ${columns} FROM ${tableName}`));
}

describe('EmbeddingIndexManager', () => {
  let ctx: { db: MakaioDatabase; cleanup: () => void };
  let manager: EmbeddingIndexManager;

  beforeEach(async () => {
    ctx = await createTestDb();
    manager = new EmbeddingIndexManager(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  describe('slugify', () => {
    it('should convert model names to valid table suffixes', () => {
      expect(manager.getTableName('text-embedding-3-small')).toBe('embeddings_idx_text_embedding_3_small_17pbaaf');
      expect(manager.getTableName('nomic-embed-text')).toBe('embeddings_idx_nomic_embed_text_1ol76qw');
      expect(manager.getTableName('all-MiniLM-L6-v2')).toBe('embeddings_idx_all_minilm_l6_v2_1me9jfa');
    });
  });

  describe('ensureIndexTable', () => {
    it('should create index table for new model', async () => {
      // Note: In standard SQLite, F32_BLOB is not available.
      // The implementation uses BLOB as fallback in test environments.
      await manager.ensureIndexTable('text-embedding-3-small', 1536);

      // Verify table exists
      const tables = await getRawSqlExecutor(ctx.db).all<{ name: string }>(sql`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='embeddings_idx_text_embedding_3_small_17pbaaf'
      `);
      expect(tables).toHaveLength(1);
    });

    it('should be idempotent', async () => {
      await manager.ensureIndexTable('text-embedding-3-small', 1536);
      await manager.ensureIndexTable('text-embedding-3-small', 1536);
      // Should not throw - second call uses cache
    });

    it('should create different tables for different models', async () => {
      await manager.ensureIndexTable('text-embedding-3-small', 1536);
      await manager.ensureIndexTable('nomic-embed-text', 768);

      const tables = await getRawSqlExecutor(ctx.db).all<{ name: string }>(sql`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'embeddings_idx_%'
        ORDER BY name
      `);

      expect(tables).toHaveLength(2);
      expect(tables.map((t) => t.name)).toEqual([
        'embeddings_idx_nomic_embed_text_1ol76qw',
        'embeddings_idx_text_embedding_3_small_17pbaaf',
      ]);
    });
  });

  describe('upsertIndexed', () => {
    it('should insert embedding into index table', async () => {
      const embedding = new Float32Array([0.1, 0.2, 0.3]);

      await manager.upsertIndexed('test-model', 3, 'session', 'session-1', embedding);

      const tableName = manager.getTableName('test-model');
      const rows = await selectTableRows<{ entity_type: string; entity_id: string }>(
        ctx.db,
        tableName,
        'entity_type, entity_id',
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        entity_type: 'session',
        entity_id: 'session-1',
      });
    });

    it('should upsert (update) existing embedding', async () => {
      const embedding1 = new Float32Array([0.1, 0.2, 0.3]);
      const embedding2 = new Float32Array([0.4, 0.5, 0.6]);

      await manager.upsertIndexed('test-model', 3, 'session', 'session-1', embedding1);
      await manager.upsertIndexed('test-model', 3, 'session', 'session-1', embedding2);

      const tableName = manager.getTableName('test-model');
      const rows = await selectTableRows<{ entity_type: string; entity_id: string }>(
        ctx.db,
        tableName,
        'entity_type, entity_id',
      );

      // Should still be only 1 row (upsert, not insert)
      expect(rows).toHaveLength(1);
    });

    it('should allow same entity in different models', async () => {
      const embedding1 = new Float32Array([0.1, 0.2, 0.3]);
      const embedding2 = new Float32Array(Array(768).fill(0.1));

      await manager.upsertIndexed('model-a', 3, 'session', 'session-1', embedding1);
      await manager.upsertIndexed('model-b', 768, 'session', 'session-1', embedding2);

      // Each model has its own table
      const tableA = manager.getTableName('model-a');
      const tableB = manager.getTableName('model-b');

      const rowsA = await selectTableRows<{ entity_id: string }>(ctx.db, tableA, 'entity_id');
      const rowsB = await selectTableRows<{ entity_id: string }>(ctx.db, tableB, 'entity_id');

      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
    });
  });

  describe('searchSimilar', () => {
    it('should search for similar embeddings', async () => {
      // Insert some test embeddings
      await manager.upsertIndexed('test-model', 3, 'session', 'session-1', new Float32Array([1, 0, 0]));
      await manager.upsertIndexed('test-model', 3, 'session', 'session-2', new Float32Array([0, 1, 0]));
      await manager.upsertIndexed('test-model', 3, 'session', 'session-3', new Float32Array([0, 0, 1]));

      // Search for embedding similar to [1, 0, 0]
      const results = await manager.searchSimilar('test-model', new Float32Array([1, 0, 0]), 10);

      expect(results).toHaveLength(3);
      // First result should be session-1 (exact match, distance ~= 0)
      expect(results[0].entityId).toBe('session-1');
      expect(results[0].distance).toBeCloseTo(0, 5);
    });

    it('should respect limit parameter', async () => {
      // Insert more embeddings than the limit
      for (let i = 0; i < 5; i++) {
        await manager.upsertIndexed(
          'test-model',
          3,
          'session',
          `session-${i}`,
          new Float32Array([Math.random(), Math.random(), Math.random()]),
        );
      }

      const results = await manager.searchSimilar('test-model', new Float32Array([0.5, 0.5, 0.5]), 3);

      expect(results).toHaveLength(3);
    });

    it('should return empty array for empty table', async () => {
      // Create table but don't insert anything
      await manager.ensureIndexTable('empty-model', 3);

      const results = await manager.searchSimilar('empty-model', new Float32Array([1, 0, 0]), 10);

      expect(results).toHaveLength(0);
    });

    it('should return empty array for non-existent table', async () => {
      const results = await manager.searchSimilar('non-existent-model', new Float32Array([1, 0, 0]), 10);

      expect(results).toHaveLength(0);
    });
  });

  describe('deleteByEntity', () => {
    it('should delete embedding by entity', async () => {
      await manager.upsertIndexed('test-model', 3, 'session', 'session-1', new Float32Array([1, 0, 0]));
      await manager.upsertIndexed('test-model', 3, 'session', 'session-2', new Float32Array([0, 1, 0]));

      await manager.deleteByEntity('test-model', 'session', 'session-1');

      const tableName = manager.getTableName('test-model');
      const rows = await selectTableRows<{ entity_id: string }>(ctx.db, tableName, 'entity_id');

      expect(rows).toHaveLength(1);
      expect(rows[0].entity_id).toBe('session-2');
    });
  });
});

describe('decodeEmbedding', () => {
  // Values exactly representable in IEEE-754 f32, so round-trips compare with toEqual.
  const floats = [0.25, -1.5, 3.75];

  /**
   * Encode the fixture floats as f32 bytes at the given offset inside a padded
   * backing buffer, returning an exact-length byte view at that offset.
   * @param byteOffset - Offset of the f32 payload inside the backing buffer.
   * @returns Uint8Array view with `view.byteOffset === byteOffset`.
   */
  function encodedViewAt(byteOffset: number): Uint8Array {
    const payload = new Uint8Array(Float32Array.from(floats).buffer);
    const backing = new Uint8Array(byteOffset + payload.byteLength);
    backing.set(payload, byteOffset);
    return new Uint8Array(backing.buffer, byteOffset, payload.byteLength);
  }

  it('wraps an ArrayBuffer directly (SQLite driver shape)', () => {
    const buffer = new ArrayBuffer(floats.length * 4);
    new Float32Array(buffer).set(floats);

    expect(Array.from(decodeEmbedding(buffer))).toEqual(floats);
  });

  it('reinterprets a 4-byte-aligned view zero-copy', () => {
    const view = encodedViewAt(0);

    const decoded = decodeEmbedding(view);

    expect(Array.from(decoded)).toEqual(floats);
    // Zero-copy contract: the aligned branch shares the backing buffer.
    expect(decoded.buffer).toBe(view.buffer);
  });

  it('copies an unaligned Buffer view instead of throwing (node-postgres pool slice shape)', () => {
    const view = encodedViewAt(2);
    // node-postgres bytea values are Buffers sliced from the shared pool at
    // arbitrary offsets — mirror that exact shape (no copy on construction).
    const pooled = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    expect(pooled.byteOffset % 4).not.toBe(0);

    const decoded = decodeEmbedding(pooled);

    expect(Array.from(decoded)).toEqual(floats);
    // The unaligned branch must copy: sharing the backing buffer would require
    // a misaligned Float32Array, which the runtime rejects.
    expect(decoded.buffer).not.toBe(pooled.buffer);
  });

  it('throws a descriptive error when the byte length is not a multiple of 4', () => {
    expect(() => decodeEmbedding(new Uint8Array(5))).toThrow(/byte length 5 is not a multiple of 4/);
    expect(() => decodeEmbedding(new ArrayBuffer(7))).toThrow(/byte length 7 is not a multiple of 4/);
  });
});
