import type { EmbeddableUnit, ResolvedTypeShape, SymbolKind, SymbolNode } from './schemas.js';

/** File extensions treated as TypeScript source files. */
export const TS_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Scope subtype resolved by the host before entering Typeview core logic. */
export type ScopeType = 'worktree' | 'repo' | 'cwd';

/** Resolved scope metadata attached to index/query results. */
export interface ScopeMeta {
  /** Stable scope key. */
  key: string;
  /** Scope kind. */
  type: ScopeType;
  /** Absolute scope root path. */
  path: string;
  /** Branch or branch-like version key for index isolation. */
  branch: string;
  /** Optional git commit hash. */
  commit?: string;
}

/** Index statistics for scope snapshots. */
export interface IndexMeta {
  /** Unix timestamp (ms) when the index was produced. */
  indexedAt: number;
  /** Number of files represented in the index. */
  fileCount: number;
  /** Number of symbols represented in the index. */
  symbolCount: number;
}

/**
 * Canonical list of graph edge relation kinds.
 *
 * This is the single source of truth — the {@link EdgeRelation} union type is
 * derived from it so that runtime guards and type-level checks stay in sync.
 */
export const EDGE_RELATIONS = ['extends', 'implements', 'calls'] as const;

/** Edge relation subset used for graph edges. */
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

/** Directed graph edge between two symbols. */
export interface IndexEdgeRecord {
  /** Source symbol ID. */
  fromSymbolId: string;
  /** Target symbol ID. */
  toSymbolId: string;
  /** Edge relation kind. */
  kind: EdgeRelation;
}

/** Single indexed symbol with pre-computed lookup fields. */
export interface IndexedSymbolRecord {
  /** Parsed symbol payload. */
  symbol: SymbolNode;
  /** Absolute path of the containing file. */
  absoluteFilePath: string;
  /** Scope-relative path of the containing file. */
  relativeFilePath: string;
  /** Stable alias hash for the symbol identity candidate. */
  aliasHash: string;
  /** Semantic hash for continuity scoring. */
  semanticHash: string;
  /** Origin alias hash for continuity history. */
  originAliasHash: string;
  /** Previous symbol ID when continuity resolved a lineage edge. */
  predecessorSymbolId?: string;
  /** Lowercase symbol name for search. */
  nameLower: string;
  /** Lowercase signature for search. */
  signatureLower: string;
  /** Checker-resolved shape, present only after semantic enrichment. */
  resolvedShape?: ResolvedTypeShape;
  /** Canonical embeddable text unit, present only after semantic enrichment. */
  embeddableUnit?: EmbeddableUnit;
}

/** In-memory index for a single scope. */
export interface ScopeIndexRecord {
  /** Scope this record belongs to. */
  scope: ScopeMeta;
  /** Unix timestamp (ms) when the index was produced. */
  indexedAt: number;
  /** Symbol records by symbol ID. */
  symbolsById: Map<string, IndexedSymbolRecord>;
  /** File-to-symbolId mapping by absolute file path. */
  symbolIdsByFile: Map<string, string[]>;
  /** Alias-hash reverse lookup. */
  symbolIdByAliasHash: Map<string, string>;
  /** Outgoing graph edges by source symbol ID. */
  outgoing: Map<string, IndexEdgeRecord[]>;
  /** Incoming graph edges by target symbol ID. */
  incoming: Map<string, IndexEdgeRecord[]>;
  /** Present when the semantic enrichment pass has run over this index. */
  enrichment?: { version: string; enrichedAt: number };
}

/** Result of a graph trace operation. */
export interface TraceGraphResult {
  /** Trace nodes. */
  nodes: TraceNode[];
  /** Trace edges. */
  edges: TraceEdge[];
}

/** Minimal trace node shape shared by query helpers. */
export interface TraceNode {
  /** Symbol ID. */
  symbolId: string;
  /** Symbol name. */
  name: string;
  /** Symbol kind. */
  kind: SymbolKind;
  /** File path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Optional signature text. */
  signature?: string;
}

/** Minimal trace edge shape shared by query helpers. */
export interface TraceEdge {
  /** Source symbol ID. */
  fromSymbolId: string;
  /** Target symbol ID. */
  toSymbolId: string;
  /** Trace edge kind. */
  kind: EdgeRelation | 'references' | 'imports';
}

/** Persisted lineage row recording a continuity decision between two symbols. */
export interface PersistedLineageRow {
  /** The newer symbol that replaced or descended from the predecessor. */
  symbolId: string;
  /** The older symbol this one is derived from. */
  predecessorSymbolId: string;
  /** Continuity decision value that caused this row. */
  reason: string;
  /** Decision confidence stored as integer. */
  confidence: number;
  /** Algorithm version stamp for future migrations. */
  algorithmVersion: string;
  /** Unix timestamp (ms) when the row was first recorded. */
  createdAt: number;
}
