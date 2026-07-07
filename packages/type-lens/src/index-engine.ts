import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { TypeviewChangeBatch } from './change-batch.js';
import type { SymbolNode } from './schemas.js';
import type { LanguageAnalyzer } from './types.js';
import {
  claimContinuitySymbols,
  createContinuityState,
  resolveSymbolIdentity,
  type ContinuityState,
} from './continuity-resolver.js';
import { CONTINUITY_ALGORITHM_VERSION, type ContinuityConfig } from './continuity-config.js';
import type {
  EdgeRelation,
  IndexedSymbolRecord,
  IndexEdgeRecord,
  PersistedLineageRow,
  ScopeIndexRecord,
  ScopeMeta,
} from './index-types.js';
import { compareRecords, isPathWithinRoot } from './index-utils.js';
import { TS_EXTENSIONS } from './index-types.js';
import { appendEdge } from './index-helpers.js';
import { runEnrichmentPass, type EnrichmentOptions } from './enrichment-pass.js';

export { TS_EXTENSIONS };

/**
 * Compute the alias hash for a symbol — a stable, scope-scoped identity key.
 *
 * Hash formula: `SHA-1(branch|relativePath|namespacePath|name|kind)`.
 * Branch-scoped by design so no separate branch conflict key is needed.
 *
 * Uses a 5-part digest (branch|path|namespacePath|name|kind) for all symbols.
 * Top-level symbols hash with an empty namespacePath segment, which changes
 * their hashes relative to the pre-method-support 4-part formula. This is an
 * accepted breaking change for a pre-publication codebase (see design doc).
 * @param branch - Git branch name for the scope.
 * @param relativePath - Scope-relative file path.
 * @param symbol - Parsed symbol node.
 * @returns Hex-encoded SHA-1 alias hash.
 */
export function createAliasHash(branch: string, relativePath: string, symbol: SymbolNode): string {
  return createHash('sha1')
    .update(`${branch}|${relativePath}|${symbol.namespacePath ?? ''}|${symbol.name}|${symbol.kind}`)
    .digest('hex');
}

/** Number of files indexed between progress log messages. */
export const INDEX_LOG_INTERVAL = 100;

/**
 * Minimal interface that IndexEngine requires from an IndexStore.
 * IndexStore is the authoritative owner of ScopeIndexRecord storage; IndexEngine
 * is a pure computing unit that reads/writes records but does not store them.
 */
export interface IndexStoreOperations {
  /**
   * Create a new empty scope index for the given scope metadata.
   * @param scope - Scope metadata to create the index for.
   * @returns A fresh empty ScopeIndexRecord.
   */
  createEmptyScopeIndex(scope: ScopeMeta): ScopeIndexRecord;

  /**
   * Clone an existing scope index with independent collection containers.
   *
   * `IndexedSymbolRecord` payload objects may remain shared as immutable data.
   * @param scope - Scope metadata for the new index.
   * @param source - Source index to clone from.
   * @returns Structural clone of the source index.
   */
  cloneScopeIndex(scope: ScopeMeta, source: ScopeIndexRecord): ScopeIndexRecord;

  /**
   * Remove all symbols associated with a single file from the index.
   * @param index - Index record to mutate.
   * @param filePath - Absolute path of the file to remove.
   */
  removeFile(index: ScopeIndexRecord, filePath: string): void;

  /**
   * Remove all symbols from files under a given directory from the index.
   * @param index - Index record to mutate.
   * @param directoryPath - Absolute path of the directory to remove.
   */
  removeDirectory(index: ScopeIndexRecord, directoryPath: string): void;
}

/**
 * Create a base implementation of {@link IndexStoreOperations}.
 *
 * Provides the minimal correct behaviour: create, clone, remove-file, and
 * remove-directory. Callers that need additional invariants (e.g. dangling-edge
 * cleanup after `removeFile`) can spread the result and override individual
 * methods.
 * @returns Base store operations.
 */
export function createBaseIndexStoreOperations(): IndexStoreOperations {
  const ops: IndexStoreOperations = {
    createEmptyScopeIndex(scope: ScopeMeta): ScopeIndexRecord {
      return {
        scope,
        indexedAt: Date.now(),
        symbolsById: new Map(),
        symbolIdsByFile: new Map(),
        symbolIdByAliasHash: new Map(),
        outgoing: new Map(),
        incoming: new Map(),
      };
    },
    cloneScopeIndex(scope: ScopeMeta, source: ScopeIndexRecord): ScopeIndexRecord {
      return {
        scope,
        indexedAt: source.indexedAt,
        symbolsById: new Map(source.symbolsById),
        symbolIdsByFile: new Map([...source.symbolIdsByFile.entries()].map(([filePath, ids]) => [filePath, [...ids]])),
        symbolIdByAliasHash: new Map(source.symbolIdByAliasHash),
        outgoing: new Map([...source.outgoing.entries()].map(([id, edges]) => [id, [...edges]])),
        incoming: new Map([...source.incoming.entries()].map(([id, edges]) => [id, [...edges]])),
        enrichment: source.enrichment ? { ...source.enrichment } : undefined,
      };
    },
    removeFile(index: ScopeIndexRecord, filePath: string): void {
      const ids = index.symbolIdsByFile.get(filePath);
      if (!ids) return;
      for (const id of ids) {
        const existing = index.symbolsById.get(id);
        if (existing) index.symbolIdByAliasHash.delete(existing.aliasHash);
        index.symbolsById.delete(id);
        index.outgoing.delete(id);
        index.incoming.delete(id);
      }
      index.symbolIdsByFile.delete(filePath);
    },
    removeDirectory(index: ScopeIndexRecord, directoryPath: string): void {
      const normalized = path.resolve(directoryPath);
      for (const filePath of [...index.symbolIdsByFile.keys()]) {
        if (isPathWithinRoot(normalized, filePath)) {
          ops.removeFile(index, filePath);
        }
      }
    },
  };
  return ops;
}

/**
 * Clone a scope index for in-place enrichment.
 *
 * Store-level clones may share symbol record payloads because those records are
 * immutable for storage operations. Enrichment is different: it mutates records
 * and graph maps in place, so failure isolation requires independent record
 * objects as well as independent collection containers.
 * @param source - Syntactic scope index to enrich.
 * @returns Mutable scratch copy for semantic enrichment.
 */
function cloneScopeIndexForEnrichment(source: ScopeIndexRecord): ScopeIndexRecord {
  return {
    scope: source.scope,
    indexedAt: source.indexedAt,
    symbolsById: new Map(
      [...source.symbolsById.entries()].map(([id, record]) => [
        id,
        {
          ...record,
          symbol: { ...record.symbol },
          resolvedShape:
            record.resolvedShape?.kind === 'object'
              ? { kind: 'object', properties: record.resolvedShape.properties.map((property) => ({ ...property })) }
              : record.resolvedShape
                ? { ...record.resolvedShape }
                : undefined,
          embeddableUnit: record.embeddableUnit ? { ...record.embeddableUnit } : undefined,
        },
      ]),
    ),
    symbolIdsByFile: new Map([...source.symbolIdsByFile.entries()].map(([filePath, ids]) => [filePath, [...ids]])),
    symbolIdByAliasHash: new Map(source.symbolIdByAliasHash),
    outgoing: new Map([...source.outgoing.entries()].map(([id, edges]) => [id, edges.map((edge) => ({ ...edge }))])),
    incoming: new Map([...source.incoming.entries()].map(([id, edges]) => [id, edges.map((edge) => ({ ...edge }))])),
    enrichment: source.enrichment ? { ...source.enrichment } : undefined,
  };
}

/** Constructor options for IndexEngine. */
export interface IndexEngineOptions {
  /** Language analyzer used to parse TypeScript files. */
  readonly analyzer: LanguageAnalyzer;
  /** Continuity thresholds and weights. */
  readonly continuityConfig: ContinuityConfig;
}

/**
 * Performs file parsing and index building for TypeScript scopes.
 *
 * IndexEngine is a pure computing unit — it reads files, resolves symbol
 * identity, and populates ScopeIndexRecord structures, but does not own or
 * persist them. Storage is delegated to the caller via IndexStoreOperations.
 */
export class IndexEngine {
  private readonly analyzer: LanguageAnalyzer;
  private readonly continuityConfig: ContinuityConfig;
  private symbolIdCounter = 0;

  /**
   * Create an IndexEngine.
   * @param options - Analyzer and continuity configuration.
   */
  public constructor(options: IndexEngineOptions) {
    this.analyzer = options.analyzer;
    this.continuityConfig = options.continuityConfig;
  }

  /**
   * Perform a full re-index of the provided TypeScript files for a scope.
   *
   * Parses each file, resolves symbol identity with continuity against the
   * previous index snapshot, and builds the inheritance/implementation graph.
   * File collection is the caller's responsibility (use `collectTsFiles` from `file-collector`).
   * @param scope - Scope metadata (path, branch) to index.
   * @param filePaths - Pre-collected sorted array of absolute TS/TSX file paths to index.
   * @param store - IndexStore operations used to create/clone/mutate index records.
   * @param previous - Optional previous ScopeIndexRecord used to seed symbol
   *   continuity. Pass undefined for a cold first-time index.
   * @param options - Optional configuration for post-index passes. When
   *   `options.enrichment` is set, runs the semantic enrichment pass after
   *   graph construction to attach call edges, resolved shapes, and
   *   embeddable units.
   * @returns Fully populated ScopeIndexRecord and accumulated lineage rows.
   *   Caller is responsible for storing the index and persisting the lineage rows.
   */
  public async fullIndex(
    scope: ScopeMeta,
    filePaths: string[],
    store: IndexStoreOperations,
    previous?: ScopeIndexRecord,
    options?: { enrichment?: EnrichmentOptions },
  ): Promise<{ index: ScopeIndexRecord; lineageRows: PersistedLineageRow[] }> {
    const normalizedFilePaths = this.normalizeFilePaths(filePaths);
    let index = store.createEmptyScopeIndex(scope);
    const continuity = createContinuityState(previous?.symbolsById.values() ?? []);
    const lineageRows: PersistedLineageRow[] = [];
    console.info(`[IndexEngine] Found ${normalizedFilePaths.length} files to index in ${scope.path}`);
    const startMs = Date.now();
    for (let i = 0; i < normalizedFilePaths.length; i++) {
      await this.indexFile(index, normalizedFilePaths[i], continuity, lineageRows);
      await this.yieldToEventLoop(); // yield per file — ts-morph is sync CPU work
      if ((i + 1) % INDEX_LOG_INTERVAL === 0) {
        const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
        const filesPerSec = ((i + 1) / ((Date.now() - startMs) / 1000)).toFixed(1);
        console.info(
          `[IndexEngine] Indexing progress: ${i + 1}/${normalizedFilePaths.length} files (${elapsedSec}s, ${filesPerSec} files/s)`,
        );
      }
    }
    this.rebuildGraph(index);

    if (options?.enrichment) {
      const enrichedIndex = cloneScopeIndexForEnrichment(index);
      try {
        await runEnrichmentPass(enrichedIndex, this.analyzer, options.enrichment);
        index = enrichedIndex;
      } catch (error) {
        // Enrichment is additive semantic metadata; fullIndex must still return
        // the syntactic index so callers can persist/search the baseline graph
        // and retry enrichment later.
        console.warn('[IndexEngine] Semantic enrichment failed; returning syntactic index', error);
      }
    }

    index.indexedAt = Date.now();
    return { index, lineageRows };
  }

  /**
   * Re-index only the files listed in a change batch.
   *
   * Clones the existing index, removes stale entries for each target file,
   * then re-parses the affected files. Rebuilds the graph after all files are
   * re-indexed. Directory expansion is the caller's responsibility (use
   * `collectTsFiles` from `file-collector` for directory expansion).
   * @param changeBatch - Scope-resolved file changes to apply.
   * @param store - IndexStore operations used to clone/mutate index records.
   * @param existing - Existing ScopeIndexRecord to clone from (or empty if none).
   * @returns Updated ScopeIndexRecord and accumulated lineage rows.
   *   Caller is responsible for storing the index and persisting the lineage rows.
   */
  public async incrementalIndex(
    changeBatch: TypeviewChangeBatch,
    store: IndexStoreOperations,
    existing: ScopeIndexRecord,
  ): Promise<{ index: ScopeIndexRecord; lineageRows: PersistedLineageRow[] }> {
    const { scope } = changeBatch;
    if (
      existing.scope.key !== scope.key ||
      existing.scope.branch !== scope.branch ||
      path.resolve(existing.scope.path) !== path.resolve(scope.path)
    ) {
      throw new Error(
        `[IndexEngine] Scope mismatch in incrementalIndex: existing=${existing.scope.key} batch=${scope.key}`,
      );
    }
    const index = store.cloneScopeIndex(scope, existing);
    // Stale semantic data must not masquerade as fresh — the syntactic fields
    // enrichment populated remain, but the freshness stamp is cleared so
    // consumers can detect that re-enrichment is needed.
    delete index.enrichment;
    const continuity = createContinuityState(existing.symbolsById.values());

    for (const change of changeBatch.changes) {
      store.removeFile(index, change.absolutePath);
    }
    claimContinuitySymbols(continuity, index.symbolsById.keys());

    const lineageRows: PersistedLineageRow[] = [];
    for (const change of changeBatch.changes) {
      if (change.kind === 'delete') {
        await this.yieldToEventLoop();
        continue;
      }

      await this.indexFile(index, change.absolutePath, continuity, lineageRows);
      await this.yieldToEventLoop();
    }
    this.rebuildGraph(index);
    index.indexedAt = Date.now();
    return { index, lineageRows };
  }

  /**
   * Parse a single file and populate the index with resolved symbol records.
   *
   * Removes any stale entries for the file before re-parsing. Best-effort:
   * parse failures are logged and the file is skipped.
   * @param index - Index record to populate.
   * @param filePath - Absolute path of the file to parse.
   * @param continuity - Mutable continuity state for this index run.
   * @param lineageRows - Accumulator for lineage rows to persist.
   * @returns `true` if the file was indexed successfully, `false` if parsing
   *   failed and the file was skipped.
   */
  public async indexFile(
    index: ScopeIndexRecord,
    filePath: string,
    continuity: ContinuityState,
    lineageRows: PersistedLineageRow[],
  ): Promise<boolean> {
    const relativeFilePath = path.relative(index.scope.path, filePath);
    try {
      const parsedSymbols = await this.analyzer.parseFile(filePath, relativeFilePath);
      if (parsedSymbols.length === 0) return true;

      const ids: string[] = [];
      for (const parsedSymbol of parsedSymbols) {
        const { identity, decision } = resolveSymbolIdentity({
          scopeBranch: index.scope.branch,
          relativeFilePath,
          symbol: parsedSymbol,
          state: continuity,
          config: this.continuityConfig,
          createAliasHash: (branch, relPath, symbol) => this.createAliasHash(branch, relPath, symbol),
          createSymbolId: (aliasHash) => this.createStableSymbolId(aliasHash),
        });
        const symbol: SymbolNode = { ...parsedSymbol, id: identity.symbolId };
        ids.push(symbol.id);
        index.symbolsById.set(symbol.id, {
          symbol,
          absoluteFilePath: filePath,
          relativeFilePath,
          aliasHash: identity.aliasHash,
          semanticHash: identity.semanticHash,
          originAliasHash: identity.originAliasHash,
          predecessorSymbolId: identity.predecessorSymbolId,
          nameLower: symbol.name.toLowerCase(),
          signatureLower: (symbol.signature ?? '').toLowerCase(),
        });
        index.symbolIdByAliasHash.set(identity.aliasHash, symbol.id);

        if (decision.kind === 'lineage' && decision.predecessorSymbolId) {
          lineageRows.push({
            symbolId: decision.symbolId,
            predecessorSymbolId: decision.predecessorSymbolId,
            reason: decision.kind,
            confidence: Math.round(decision.confidence * 1000),
            algorithmVersion: CONTINUITY_ALGORITHM_VERSION,
            createdAt: Date.now(),
          });
        }
      }
      index.symbolIdsByFile.set(filePath, ids);
      return true;
    } catch (error) {
      // best-effort indexing
      console.warn(`[IndexEngine] Failed to index file ${filePath} (best-effort)`, error);
      return false;
    }
  }

  /**
   * Rebuild the outgoing and incoming edge maps from symbol signatures.
   *
   * Parses extends/implements clauses from each symbol's signature, resolves
   * target names to symbol IDs, and populates index.outgoing / index.incoming.
   * @param index - Index record whose graph maps will be replaced in-place.
   */
  public rebuildGraph(index: ScopeIndexRecord): void {
    const byName = new Map<string, IndexedSymbolRecord[]>();
    for (const record of index.symbolsById.values()) {
      const bucket = byName.get(record.symbol.name) ?? [];
      bucket.push(record);
      byName.set(record.symbol.name, bucket);
    }
    for (const bucket of byName.values()) {
      bucket.sort((a, b) => compareRecords(a, b));
    }

    const outgoing = new Map<string, IndexEdgeRecord[]>();
    const incoming = new Map<string, IndexEdgeRecord[]>();
    const seen = new Set<string>();

    for (const record of index.symbolsById.values()) {
      const links = this.extractLinks(record.symbol.signature);
      for (const link of links) {
        const target = byName.get(link.targetName)?.[0];
        if (!target) continue;
        const edge: IndexEdgeRecord = {
          fromSymbolId: record.symbol.id,
          toSymbolId: target.symbol.id,
          kind: link.relation,
        };
        const key = `${edge.fromSymbolId}->${edge.toSymbolId}:${edge.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);

        appendEdge(outgoing, incoming, edge);
      }
    }

    index.outgoing = outgoing;
    index.incoming = incoming;
  }

  /**
   * Extract extends/implements links from a symbol signature string.
   * @param signature - Raw signature text from the symbol node.
   * @returns Array of directed link descriptors with relation kind and target name.
   */
  public extractLinks(signature?: string): Array<{ relation: EdgeRelation; targetName: string }> {
    if (!signature) return [];
    const links: Array<{ relation: EdgeRelation; targetName: string }> = [];

    const extendsMatch = signature.match(/\bextends\s+(.+?)(?:\s+implements\s+|$)/);
    if (extendsMatch?.[1]) {
      for (const part of this.splitTopLevelTypeList(extendsMatch[1])) {
        const targetName = this.normalizeTypeName(part);
        if (targetName) links.push({ relation: 'extends', targetName });
      }
    }
    const implementsMatch = signature.match(/\bimplements\s+(.+)$/);
    if (implementsMatch?.[1]) {
      for (const part of this.splitTopLevelTypeList(implementsMatch[1])) {
        const targetName = this.normalizeTypeName(part);
        if (targetName) links.push({ relation: 'implements', targetName });
      }
    }

    return links;
  }

  /**
   * Normalize a raw type name string to a simple identifier.
   *
   * Strips generic type parameters, namespace qualifiers, and non-identifier
   * characters.
   * @param value - Raw type name extracted from a signature clause.
   * @returns Normalized identifier, or empty string if nothing remains.
   */
  public normalizeTypeName(value: string): string {
    const trimmed = value.trim();
    let result = '';
    let depth = 0;
    for (const char of trimmed) {
      if (char === '<') {
        depth++;
      } else if (char === '>') {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0) {
        result += char;
      }
    }
    return (
      result
        .split('.')
        .pop()
        ?.replace(/[^\w$]/g, '')
        .trim() ?? ''
    );
  }

  /**
   * Split a comma-separated type list at top-level commas only.
   * @param value - Raw extends/implements clause segment.
   * @returns Trimmed non-empty top-level segments.
   */
  private splitTopLevelTypeList(value: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    for (const char of value) {
      if (char === '<') depth++;
      if (char === '>') depth = Math.max(0, depth - 1);
      if (char === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    parts.push(current.trim());
    return parts.filter((part) => part.length > 0);
  }

  /**
   * Yield control to the event loop via setImmediate to prevent starvation in
   * tight file-indexing loops.
   * @returns Promise that resolves on the next event loop iteration.
   */
  public yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Generate a stable, globally-unique symbol ID for a new symbol.
   *
   * The ID encodes a content hash, a monotonic counter, and a timestamp to
   * guarantee uniqueness across sessions.
   * @param aliasHash - Alias hash of the symbol, used as content input.
   * @returns Stable symbol ID string of the form `sym_<digest>_<ts><nonce>`.
   */
  public createStableSymbolId(aliasHash: string): string {
    this.symbolIdCounter += 1;
    const timestamp = Date.now().toString(36);
    const nonce = this.symbolIdCounter.toString(36);
    const digest = createHash('sha1').update(`${aliasHash}|${timestamp}|${nonce}`).digest('hex').slice(0, 10);
    return `sym_${digest}_${timestamp}${nonce}`;
  }

  /**
   * Compute the alias hash for a symbol.
   *
   * Delegates to the standalone {@link createAliasHash} function.
   * @param branch - Git branch name for the scope.
   * @param relativePath - Scope-relative file path.
   * @param symbol - Parsed symbol node.
   * @returns Hex-encoded SHA-1 alias hash.
   */
  public createAliasHash(branch: string, relativePath: string, symbol: SymbolNode): string {
    return createAliasHash(branch, relativePath, symbol);
  }

  /**
   * Return true if the given file path has a TypeScript extension.
   * @param filePath - File path to check.
   * @returns True for .ts and .tsx files.
   */
  public isTsPath(filePath: string): boolean {
    return TS_EXTENSIONS.has(path.extname(filePath));
  }

  /**
   * Normalize and de-duplicate incoming file paths while preserving order.
   * @param filePaths - Candidate absolute or relative file paths.
   * @returns Canonicalized unique absolute paths.
   */
  private normalizeFilePaths(filePaths: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const filePath of filePaths) {
      const canonicalPath = path.resolve(path.normalize(filePath));
      if (seen.has(canonicalPath)) continue;
      seen.add(canonicalPath);
      normalized.push(canonicalPath);
    }
    return normalized;
  }
}
