export { createTypeviewChangeBatch } from './change-batch.js';
export type { TypeviewChangeBatch, TypeviewFileChange, TypeviewFileChangeInput } from './change-batch.js';
export {
  createAliasHash,
  createBaseIndexStoreOperations,
  INDEX_LOG_INTERVAL,
  IndexEngine,
  TS_EXTENSIONS,
} from './index-engine.js';
export type { IndexEngineOptions, IndexStoreOperations } from './index-engine.js';
export { EDGE_RELATIONS } from './index-types.js';
export type {
  EdgeRelation,
  IndexedSymbolRecord,
  IndexEdgeRecord,
  IndexMeta,
  PersistedLineageRow,
  ScopeIndexRecord,
  ScopeMeta,
  ScopeType,
  TraceEdge,
  TraceGraphResult,
  TraceNode,
} from './index-types.js';
export {
  clampLimit,
  clampNumber,
  compareRecords,
  isEligibleFile,
  isPathWithinRoot,
  pathExists,
  resolveInputPath,
} from './index-utils.js';
export { matchesPathPrefix, resolveTraceRoot, searchIndex, traceGraph } from './index-query.js';
export type {
  SearchSymbolMatch,
  SearchSymbolsRequest,
  SemanticSymbolMatch,
  TraceDirection,
  TypeviewSemanticSearchProvider,
} from './index-query.js';
export { DEFAULT_CACHE_SIZE, TsciAnalyzer } from './tsci-analyzer.js';
export type { AnalyzerStats } from './tsci-analyzer.js';
export {
  extractClasses,
  extractEnums,
  extractFunctions,
  extractInterfaces,
  extractTypeAliases,
  findDeclaration,
  findMethodNode,
  getClassHierarchy,
  getInterfaceHierarchy,
} from './symbol-extractor.js';
export { extractDocSummary, extractExecutableMembers, extractMembers } from './member-extractor.js';
export {
  DescribeFileRequestSchema,
  DescribeFileResponseSchema,
  DescribeSymbolRequestSchema,
  DescribeSymbolResponseSchema,
  EmbeddableUnitSchema,
  ENRICHMENT_VERSION,
  MemberInfoSchema,
  ResolvedTypePropertySchema,
  ResolvedTypeShapeSchema,
  SymbolDetailSchema,
  SymbolKindSchema,
  SymbolNodeSchema,
} from './schemas.js';
export type {
  DescribeFileRequest,
  DescribeFileResponse,
  DescribeSymbolRequest,
  DescribeSymbolResponse,
  EmbeddableUnit,
  MemberInfo,
  SymbolDetail,
  SymbolKind,
  SymbolNode,
} from './schemas.js';
export type { FileCallEdge, LanguageAnalyzer, MethodCallTarget } from './types.js';
export { createSymbolId, generateId } from './symbol-id.js';
export { CONTINUITY_ALGORITHM_VERSION, DEFAULT_CONTINUITY_CONFIG } from './continuity-config.js';
export type { ContinuityConfig } from './continuity-config.js';
export { claimContinuitySymbols, createContinuityState, resolveSymbolIdentity } from './continuity-resolver.js';
export type {
  ContinuityDecision,
  ContinuityDecisionKind,
  ContinuityRecord,
  ContinuityScoringInputs,
  ContinuityState,
  ResolvedSymbolContinuity,
  ResolvedSymbolIdentity,
} from './continuity-resolver.js';
export { HashEmbeddingProvider } from './embedding-provider.js';
export type { TypeviewEmbeddingProvider } from './embedding-provider.js';
export { finalizeSearchCandidates, rankLexicalCandidate, sortSearchCandidates } from './search-ranking.js';
export type { SearchLexicalRecord, SearchMatchKind, SearchSymbolCandidate } from './search-ranking.js';
export { cosineSimilarity, toEmbeddingBlob, toFloat32Array } from './storage/vector-math.js';
export {
  DEFAULT_TYPEVIEW_SOURCE_GLOB_IGNORE_PATTERNS,
  createTypeviewSourceGlobIgnorePatterns,
  shouldDescendIntoTypeviewSourceDirectory,
  shouldIndexTypeviewSourceFile,
} from './source-filter.js';
export type { TypeviewSourceFilterOptions } from './source-filter.js';
export { runEnrichmentPass } from './enrichment-pass.js';
export type { EnrichmentOptions } from './enrichment-pass.js';
export { TypeAnalyzer, asCompilerProgram } from './type-analysis.js';
export type {
  CompilerProgramLike,
  TypeAliasAnalysis,
  TypeAnalyzerOptions,
  TypeCompositionNode,
} from './type-analysis.js';
export type { ResolvedTypeProperty, ResolvedTypeShape } from './schemas.js';
