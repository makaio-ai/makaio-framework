import type { SymbolKind } from './schemas.js';
import type {
  IndexEdgeRecord,
  IndexedSymbolRecord,
  ScopeIndexRecord,
  TraceEdge,
  TraceGraphResult,
  TraceNode,
} from './index-types.js';
import { clampLimit, compareRecords, resolveInputPath } from './index-utils.js';
import {
  finalizeSearchCandidates,
  rankLexicalCandidate,
  sortSearchCandidates,
  type SearchSymbolMatch,
  type SearchSymbolCandidate,
} from './search-ranking.js';
export type { SearchSymbolMatch } from './search-ranking.js';

/** Search request consumed by pure Typeview index queries. */
export interface SearchSymbolsRequest {
  /** Search query text. */
  query: string;
  /** Optional symbol kind filter. */
  kinds?: SymbolKind[];
  /** Optional path prefix filter. */
  pathPrefix?: string;
  /** Optional result limit. */
  limit?: number;
}

/** Semantic search result consumed by {@link searchIndex}. */
export interface SemanticSymbolMatch {
  /** Symbol ID. */
  symbolId: string;
  /** Semantic similarity score. */
  score: number;
}

/** Minimal semantic provider seam for index queries. */
export interface TypeviewSemanticSearchProvider {
  /**
   * Search semantically similar symbols.
   * @param scopePath - Absolute scope path.
   * @param branch - Branch name.
   * @param query - Query text.
   * @param limit - Max result count.
   * @returns Semantic matches.
   */
  search(scopePath: string, branch: string, query: string, limit: number): Promise<SemanticSymbolMatch[]>;
}

/** Trace traversal direction. */
export type TraceDirection = 'outgoing' | 'incoming' | 'both';

/**
 * Normalize a path prefix for repeated path-prefix matching.
 * @param prefix - Raw path prefix.
 * @returns Lowercase, forward-slash-normalized prefix.
 */
function normalizePathPrefix(prefix: string): string {
  return prefix.replace(/\\/g, '/').toLowerCase();
}

/**
 * Test whether a symbol record's file path starts with or contains a prefix.
 * @param record - Symbol record to test.
 * @param prefix - Path prefix to match against (raw or pre-normalized).
 * @returns `true` when the record path matches the prefix.
 */
export function matchesPathPrefix(record: IndexedSymbolRecord, prefix: string): boolean {
  const normalized = normalizePathPrefix(prefix);
  return matchesNormalizedPathPrefix(record, normalized);
}

/**
 * Test whether a symbol record's file path matches a pre-normalized prefix.
 * @param record - Symbol record to test.
 * @param normalizedPrefix - Lowercase, forward-slash-normalized prefix.
 * @returns `true` when the record path matches the prefix.
 */
function matchesNormalizedPathPrefix(record: IndexedSymbolRecord, normalizedPrefix: string): boolean {
  return (
    record.absoluteFilePath.replace(/\\/g, '/').toLowerCase().includes(normalizedPrefix) ||
    record.relativeFilePath.replace(/\\/g, '/').toLowerCase().startsWith(normalizedPrefix)
  );
}

/**
 * Search a scope index using lexical heuristics and optional semantic ranking.
 * @param index - The scope index to search.
 * @param request - Search parameters.
 * @param semanticProvider - Optional semantic provider.
 * @returns Ranked and finalized match array.
 */
export async function searchIndex(
  index: ScopeIndexRecord,
  request: SearchSymbolsRequest,
  semanticProvider?: TypeviewSemanticSearchProvider,
): Promise<SearchSymbolMatch[]> {
  const query = request.query.trim().toLowerCase();
  if (query.length === 0) return [];

  const matches: SearchSymbolCandidate[] = [];
  const existingIds = new Set<string>();
  const normalizedPrefix = request.pathPrefix ? normalizePathPrefix(request.pathPrefix) : undefined;

  for (const record of index.symbolsById.values()) {
    if (request.kinds && request.kinds.length > 0 && !request.kinds.includes(record.symbol.kind)) continue;
    if (normalizedPrefix && !matchesNormalizedPathPrefix(record, normalizedPrefix)) continue;
    const ranked = rankLexicalCandidate(record, query, index.scope.branch);
    if (ranked) {
      matches.push(ranked);
      existingIds.add(ranked.symbolId);
    }
  }

  if (semanticProvider) {
    let semantic: SemanticSymbolMatch[] = [];
    try {
      semantic = await semanticProvider.search(
        index.scope.path,
        index.scope.branch,
        request.query,
        clampLimit(request.limit, 20) * 3,
      );
    } catch (error) {
      console.warn('[index-query] Semantic search failed, returning lexical results only:', error);
    }

    for (const candidate of semantic) {
      if (existingIds.has(candidate.symbolId)) continue;
      const record = index.symbolsById.get(candidate.symbolId);
      if (!record) continue;
      if (request.kinds && request.kinds.length > 0 && !request.kinds.includes(record.symbol.kind)) continue;
      if (normalizedPrefix && !matchesNormalizedPathPrefix(record, normalizedPrefix)) continue;

      matches.push({
        symbolId: record.symbol.id,
        aliasHash: record.aliasHash,
        name: record.symbol.name,
        kind: record.symbol.kind,
        file: record.absoluteFilePath,
        line: record.symbol.line,
        signature: record.symbol.signature,
        branch: index.scope.branch,
        ranking: {
          score: Math.round(candidate.score * 1000),
          matchKind: 'semantic',
        },
      });
      existingIds.add(record.symbol.id);
    }
  }

  sortSearchCandidates(matches);
  return finalizeSearchCandidates(matches, clampLimit(request.limit, 20));
}

/**
 * Resolve a trace root symbol ID from a name or ID reference string.
 * @param index - The scope index to search within.
 * @param ref - A symbol ID, name, or `filePath#symbolName` reference.
 * @returns The resolved symbol ID, or `null` when no match is found.
 */
export function resolveTraceRoot(index: ScopeIndexRecord, ref: string): string | null {
  if (!ref) return null;
  if (index.symbolsById.has(ref)) return ref;

  const parts = ref.split('#');
  if (parts.length === 2) {
    const [fileRef, symbolName] = parts;
    const normalizedFile = resolveInputPath(index.scope.path, fileRef);
    for (const record of index.symbolsById.values()) {
      if (record.symbol.name !== symbolName) continue;
      if (record.absoluteFilePath === normalizedFile || record.relativeFilePath === fileRef) {
        return record.symbol.id;
      }
    }
  }

  let exactBest: IndexedSymbolRecord | undefined;
  let insensitiveBest: IndexedSymbolRecord | undefined;
  const lower = ref.toLowerCase();

  for (const record of index.symbolsById.values()) {
    if (record.symbol.name === ref) {
      if (!exactBest || compareRecords(record, exactBest) < 0) exactBest = record;
    } else if (record.nameLower === lower) {
      if (!insensitiveBest || compareRecords(record, insensitiveBest) < 0) insensitiveBest = record;
    }
  }

  return exactBest?.symbol.id ?? insensitiveBest?.symbol.id ?? null;
}

/**
 * Perform a breadth-first graph traversal starting from a root symbol.
 * @param index - The scope index containing adjacency maps.
 * @param rootId - Starting symbol ID for the traversal.
 * @param direction - Edge direction to follow.
 * @param depth - Maximum BFS depth.
 * @returns All reachable nodes and connecting edges.
 */
export function traceGraph(
  index: ScopeIndexRecord,
  rootId: string,
  direction: TraceDirection,
  depth: number,
): TraceGraphResult {
  const visited = new Set<string>([rootId]);
  const edgeMap = new Map<string, TraceEdge>();
  let frontier = new Set<string>([rootId]);

  for (let currentDepth = 0; currentDepth < depth; currentDepth++) {
    const nextFrontier = new Set<string>();
    for (const node of frontier) {
      const visitEdge = (edge: IndexEdgeRecord): void => {
        const key = `${edge.fromSymbolId}->${edge.toSymbolId}:${edge.kind}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, { fromSymbolId: edge.fromSymbolId, toSymbolId: edge.toSymbolId, kind: edge.kind });
        }
        const next = edge.fromSymbolId === node ? edge.toSymbolId : edge.fromSymbolId;
        if (!visited.has(next)) {
          visited.add(next);
          nextFrontier.add(next);
        }
      };
      if (direction !== 'incoming') {
        for (const edge of index.outgoing.get(node) ?? []) visitEdge(edge);
      }
      if (direction !== 'outgoing') {
        for (const edge of index.incoming.get(node) ?? []) visitEdge(edge);
      }
    }
    if (nextFrontier.size === 0) break;
    frontier = nextFrontier;
  }

  const nodes = [...visited]
    .map((symbolId) => {
      const record = index.symbolsById.get(symbolId);
      if (!record) return null;
      return {
        symbolId: record.symbol.id,
        name: record.symbol.name,
        kind: record.symbol.kind,
        file: record.absoluteFilePath,
        line: record.symbol.line,
      };
    })
    .filter((node): node is TraceNode => node !== null);

  return { nodes, edges: [...edgeMap.values()] };
}
