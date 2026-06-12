/**
 * Conformance suite: embedding BLOB/bytea round-trip.
 *
 * Exercises EmbeddingIndexManager on a live database to pin the storage
 * semantics of embedding vectors:
 *
 *  - SQLite: stored as BLOB, retrieved as ArrayBuffer.
 *  - Postgres: stored as bytea, retrieved as Buffer (respects byteOffset /
 *    byteLength of the original Float32Array view).
 *
 * Assertions:
 * 1. The returned vector is byte-identical to the stored one (compared via
 *    Float32Array element-by-element with closeTo precision to survive the
 *    float binary round-trip).
 * 2. Ranking puts the identical-vector query first.
 *
 * No dialect branches: the same assertions apply to both dialects, pinning
 * the EmbeddingIndexManager's portability contract.
 */
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { EmbeddingIndexManager } from '@makaio/services-core';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIMENSIONS = 8;

/**
 * Model name prefix. Each test case appends a suffix so every test gets
 * a distinct EmbeddingIndexManager table and avoids cross-test data pollution.
 */
const MODEL_PREFIX = 'conformance-embedding-model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Float32Array with non-trivial values (negatives + fractionals).
 * @param seed - Numeric seed to produce distinct vectors.
 * @returns Float32Array of length DIMENSIONS.
 */
function makeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(DIMENSIONS);
  for (let i = 0; i < DIMENSIONS; i++) {
    v[i] = (seed + i * 0.1 - 2.5) * (i % 2 === 0 ? 1 : -1);
  }
  return v;
}

/**
 * Reconstruct a Float32Array from a raw buffer value returned by the driver.
 * Handles both ArrayBuffer (SQLite BLOB path) and Buffer / Uint8Array
 * (Postgres bytea path), correctly respecting byteOffset and byteLength so a
 * sub-view is not silently read past its own bounds.
 * @param raw - Raw buffer returned by the driver.
 * @returns Float32Array view over the same bytes.
 */
function toFloat32Array(raw: ArrayBuffer | Buffer | Uint8Array): Float32Array {
  if (raw instanceof ArrayBuffer) {
    return new Float32Array(raw);
  }
  // Buffer / Uint8Array: respect byteOffset + byteLength so a sub-view does
  // not silently read past its own bounds (bytea+Buffer reconstruction on PG).
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('embeddings-roundtrip', (config) => {
  // EmbeddingIndexManager creates its own dynamic tables via ensureIndexTable;
  // no central migration chain is needed for this suite.
  const getCtx = useSuiteDatabaseContext(config, { applyCentralChain: false });

  it('stores two embeddings and retrieves byte-identical vectors', async () => {
    const ctx = getCtx();
    const model = `${MODEL_PREFIX}-roundtrip`;
    const manager = new EmbeddingIndexManager(ctx.db);

    const embA = makeEmbedding(1.0);
    const embB = makeEmbedding(3.0);

    await manager.upsertIndexed(model, DIMENSIONS, 'entity', 'id-a', embA);
    await manager.upsertIndexed(model, DIMENSIONS, 'entity', 'id-b', embB);

    // Fetch raw rows via the executor to validate the round-trip directly,
    // bypassing any intermediate serialization in searchSimilar.
    const tableName = manager.getTableName(model);
    const tableId = sql.identifier(tableName);
    type EmbRow = { entity_id: string; embedding: ArrayBuffer | Buffer };
    const rows = await ctx.executor.all<EmbRow>(sql`SELECT entity_id, embedding FROM ${tableId} ORDER BY entity_id`);

    expect(rows).toHaveLength(2);

    const rowA = rows.find((r) => r.entity_id === 'id-a');
    const rowB = rows.find((r) => r.entity_id === 'id-b');
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();

    // Reconstruct Float32Arrays and compare element-by-element.
    const storedA = toFloat32Array(rowA!.embedding);
    const storedB = toFloat32Array(rowB!.embedding);

    for (let i = 0; i < DIMENSIONS; i++) {
      expect(storedA[i]).toBeCloseTo(embA[i]!, 5);
      expect(storedB[i]).toBeCloseTo(embB[i]!, 5);
    }
  });

  it('searchSimilar ranks the identical-vector query first', async () => {
    // Distinct model → distinct table → no cross-test data pollution.
    const model = `${MODEL_PREFIX}-ranking`;
    const manager = new EmbeddingIndexManager(getCtx().db);

    const embA = makeEmbedding(1.0);
    const embB = makeEmbedding(3.0);
    const embC = makeEmbedding(7.0);

    await manager.upsertIndexed(model, DIMENSIONS, 'rank', 'rank-a', embA);
    await manager.upsertIndexed(model, DIMENSIONS, 'rank', 'rank-b', embB);
    await manager.upsertIndexed(model, DIMENSIONS, 'rank', 'rank-c', embC);

    // Query with embA exactly — Euclidean distance to rank-a must be 0.
    const results = await manager.searchSimilar(model, embA, 3);

    expect(results.length).toBeGreaterThan(0);
    // The identical vector must rank first (distance = 0).
    expect(results[0]!.entityId).toBe('rank-a');
    expect(results[0]!.distance).toBeCloseTo(0, 5);
  });

  it('upsert overwrites the stored embedding and searchSimilar reflects the update', async () => {
    // Distinct model → distinct table → no cross-test data pollution.
    const model = `${MODEL_PREFIX}-upsert`;
    const manager = new EmbeddingIndexManager(getCtx().db);

    const embOld = makeEmbedding(10.0);
    const embNew = makeEmbedding(20.0);

    await manager.upsertIndexed(model, DIMENSIONS, 'upsert', 'upsert-id', embOld);
    // Overwrite with a different vector.
    await manager.upsertIndexed(model, DIMENSIONS, 'upsert', 'upsert-id', embNew);

    // Query with the new vector — distance to the upserted row must be ≈ 0.
    const results = await manager.searchSimilar(model, embNew, 1);

    expect(results).toHaveLength(1);
    expect(results[0]!.entityId).toBe('upsert-id');
    expect(results[0]!.distance).toBeCloseTo(0, 5);
  });
});
