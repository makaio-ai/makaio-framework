import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';

/**
 * Manages dynamic embedding index tables per model.
 *
 * Each embedding model gets its own indexed table for efficient
 * vector similarity search. Tables are created on-demand when
 * a new model is used.
 *
 * ## Table Structure
 *
 * Each table (`embeddings_idx_<model_slug>`) contains:
 * - `entity_type`: Type of entity (e.g., 'session', 'message')
 * - `entity_id`: ID of the entity
 * - `embedding`: Vector data as BLOB (F32_BLOB in libsql production)
 *
 * ## Design Rationale
 *
 * Per-model tables enable:
 * 1. Efficient vector indexing (one index per embedding dimension)
 * 2. Model-specific optimizations
 * 3. Easy cleanup when models are deprecated
 * 4. Ensemble search across multiple models
 * @example
 * ```typescript
 * const manager = new EmbeddingIndexManager(db);
 *
 * // Create/ensure table for a model
 * await manager.ensureIndexTable('text-embedding-3-small', 1536);
 *
 * // Insert embedding
 * await manager.upsertIndexed(
 *   'text-embedding-3-small',
 *   1536,
 *   'session',
 *   'session-123',
 *   embedding
 * );
 *
 * // Search similar
 * const results = await manager.searchSimilar(
 *   'text-embedding-3-small',
 *   queryEmbedding,
 *   10
 * );
 * ```
 */
export class EmbeddingIndexManager {
  private readonly db: MakaioDatabase;

  /**
   * Cache of known tables to avoid redundant CREATE TABLE checks.
   */
  private readonly knownTables = new Set<string>();

  /**
   * @param db - Drizzle database instance for all dynamic table operations.
   */
  public constructor(db: MakaioDatabase) {
    this.db = db;
  }

  /**
   * Slugify model name for use as table suffix.
   *
   * Converts model names to valid SQLite identifiers by replacing
   * non-alphanumeric characters with underscores and lowercasing.
   * @param model - The model name (e.g., 'text-embedding-3-small')
   * @returns Slugified name (e.g., 'text_embedding_3_small')
   * @example
   * slugify('text-embedding-3-small') // 'text_embedding_3_small'
   * slugify('nomic-embed-text')       // 'nomic_embed_text'
   * slugify('all-MiniLM-L6-v2')       // 'all_minilm_l6_v2'
   */
  private slugify(model: string): string {
    return model.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  }

  /**
   * Create a stable hash suffix to avoid slug collisions.
   * @param model - The model name
   * @returns Short lowercase hash string
   */
  private hashModel(model: string): string {
    let hash = 0;
    for (let i = 0; i < model.length; i++) {
      hash = (hash * 31 + model.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  }

  /**
   * Get table name for a model.
   * @param model - The model name
   * @returns Full table name with prefix
   */
  public getTableName(model: string): string {
    return `embeddings_idx_${this.slugify(model)}_${this.hashModel(model)}`;
  }

  /**
   * Ensure index table exists for a model.
   *
   * Creates table with BLOB column for vector storage if not exists.
   * Uses in-memory cache to avoid redundant CREATE TABLE statements.
   *
   * Note: In production with libsql, F32_BLOB would be used for native
   * vector operations. Standard SQLite uses BLOB as fallback.
   * @param model - The model name
   * @param _dimensions - Number of dimensions (reserved for F32_BLOB validation)
   * @returns The table name
   */
  public async ensureIndexTable(model: string, _dimensions: number): Promise<string> {
    const tableName = this.getTableName(model);

    if (this.knownTables.has(tableName)) {
      return tableName;
    }

    // Create table with BLOB for vector storage
    // Note: F32_BLOB would be used in production libsql for native vector ops
    // Standard SQLite falls back to BLOB storage
    await this.db.run(
      sql.raw(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          embedding BLOB NOT NULL,
          PRIMARY KEY (entity_type, entity_id)
        )
      `),
    );

    this.knownTables.add(tableName);
    return tableName;
  }

  /**
   * Insert or update embedding in index table.
   * @param model - The model name
   * @param dimensions - Number of dimensions
   * @param entityType - Type of entity (e.g., 'session', 'message')
   * @param entityId - ID of the entity
   * @param embedding - The embedding vector
   */
  public async upsertIndexed(
    model: string,
    dimensions: number,
    entityType: string,
    entityId: string,
    embedding: Float32Array,
  ): Promise<void> {
    const tableName = await this.ensureIndexTable(model, dimensions);

    // Convert Float32Array to ArrayBuffer for BLOB storage (respect view bounds)
    const buffer = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    const tableId = sql.identifier(tableName);
    await this.db.run(
      sql`INSERT INTO ${tableId} (entity_type, entity_id, embedding)
        VALUES (${entityType}, ${entityId}, ${buffer})
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
          embedding = excluded.embedding`,
    );
  }

  /**
   * Search for similar embeddings using Euclidean distance.
   *
   * Note: In production with libsql vector extensions, this would use
   * native vector distance operators. This implementation provides a
   * basic fallback using manual distance calculation.
   * @param model - The model name
   * @param queryEmbedding - The query embedding vector
   * @param limit - Maximum number of results (default: 10)
   * @returns Array of results with entity info and distance
   */
  public async searchSimilar(
    model: string,
    queryEmbedding: Float32Array,
    limit = 10,
  ): Promise<Array<{ entityType: string; entityId: string; distance: number }>> {
    const tableName = this.getTableName(model);

    // Check if table exists
    if (!this.knownTables.has(tableName)) {
      const tables = await this.db.all<{ name: string }>(
        sql.raw(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`),
      );
      if (tables.length === 0) {
        return [];
      }
      this.knownTables.add(tableName);
    }

    // Fetch all embeddings and compute distance in JS
    // Note: Production libsql would use native vector_distance_cos or <-> operator
    const tableId = sql.identifier(tableName);
    const rows = await this.db.all<{ entity_type: string; entity_id: string; embedding: ArrayBuffer }>(
      sql`SELECT entity_type, entity_id, embedding FROM ${tableId}`,
    );

    if (rows.length === 0) {
      return [];
    }

    // Calculate Euclidean distance for each embedding
    const results = rows.map((row) => {
      const stored = new Float32Array(row.embedding);
      const distance = this.euclideanDistance(queryEmbedding, stored);
      return {
        entityType: row.entity_type,
        entityId: row.entity_id,
        distance,
      };
    });

    // Sort by distance and limit
    return results.sort((a, b) => a.distance - b.distance).slice(0, limit);
  }

  /**
   * Delete embedding by entity.
   * @param model - The model name
   * @param entityType - Type of entity
   * @param entityId - ID of the entity
   */
  public async deleteByEntity(model: string, entityType: string, entityId: string): Promise<void> {
    const tableName = this.getTableName(model);

    if (!this.knownTables.has(tableName)) {
      const tables = await this.db.all<{ name: string }>(
        sql.raw(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`),
      );
      if (tables.length === 0) {
        return;
      }
      this.knownTables.add(tableName);
    }

    const tableId = sql.identifier(tableName);
    await this.db.run(sql`DELETE FROM ${tableId} WHERE entity_type = ${entityType} AND entity_id = ${entityId}`);
  }

  /**
   * Calculate Euclidean distance between two vectors.
   * @param a - First vector
   * @param b - Second vector
   * @returns The Euclidean distance
   */
  private euclideanDistance(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }
}
