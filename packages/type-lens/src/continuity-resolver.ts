import { createHash } from 'node:crypto';
import type { SymbolNode } from './schemas.js';
import { CONTINUITY_ALGORITHM_VERSION, type ContinuityConfig } from './continuity-config.js';

interface ContinuityCandidate {
  symbolId: string;
  aliasHash: string;
  kind: string;
  nameLower: string;
  namespacePath?: string;
  semanticSignature: string;
  semanticHash: string;
  relativeFilePath: string;
  originAliasHash: string;
  predecessorSymbolId?: string;
}

/**
 * Resolved symbol identity for continuity-aware indexing.
 */
export interface ResolvedSymbolIdentity {
  symbolId: string;
  aliasHash: string;
  semanticHash: string;
  originAliasHash: string;
  predecessorSymbolId?: string;
}

/**
 * Mutable continuity state across an index run.
 */
export interface ContinuityState {
  byAliasHash: Map<string, ContinuityCandidate>;
  byKindAndName: Map<string, ContinuityCandidate[]>;
  claimedSymbolIds: Set<string>;
}

/**
 * Minimal projection of an indexed symbol record used by continuity logic.
 */
export interface ContinuityRecord {
  symbol: SymbolNode;
  aliasHash: string;
  semanticHash: string;
  relativeFilePath: string;
  originAliasHash: string;
  predecessorSymbolId?: string;
}

/**
 * The kind of continuity decision made for a symbol.
 *
 * - `alias-match`: exact alias hash match (no scoring needed)
 * - `same`: fuzzy match above sameSymbolThreshold; reuses existing symbolId
 * - `lineage`: fuzzy match above lineageThreshold; new symbolId with predecessor
 * - `new`: score below lineageThreshold; fully new symbol
 */
export type ContinuityDecisionKind = 'alias-match' | 'same' | 'lineage' | 'new';

/**
 * Detailed scoring inputs that produced a continuity decision.
 */
export interface ContinuityScoringInputs {
  /** Jaccard similarity of semantic token sets. */
  readonly semanticSimilarity: number;
  /** Path segment overlap similarity. */
  readonly pathSimilarity: number;
  /** Weighted composite of semantic and path similarity. */
  readonly compositeScore: number;
}

/**
 * Structured result of the continuity resolution process.
 */
export interface ContinuityDecision {
  /** Resolved stable symbol ID. */
  readonly symbolId: string;
  /** Symbol ID of the predecessor when kind is `lineage`. */
  readonly predecessorSymbolId?: string;
  /** Nature of the resolution outcome. */
  readonly kind: ContinuityDecisionKind;
  /** Confidence in the decision (0–1). Always 1 for alias-match. */
  readonly confidence: number;
  /** Raw scoring inputs; absent for alias-match. */
  readonly scoringInputs?: ContinuityScoringInputs;
  /** Algorithm version stamp for audit trail. */
  readonly algorithmVersion: string;
}

/**
 * Combined identity and decision output of resolveSymbolIdentity.
 */
export interface ResolvedSymbolContinuity {
  /** Stable symbol identity fields for indexing. */
  readonly identity: ResolvedSymbolIdentity;
  /** Audit decision that produced the identity. */
  readonly decision: ContinuityDecision;
}

/**
 * Build continuity state from an existing scope index snapshot.
 * @param records - Existing indexed records
 * @returns Continuity state
 */
export function createContinuityState(records: Iterable<ContinuityRecord>): ContinuityState {
  const state: ContinuityState = {
    byAliasHash: new Map(),
    byKindAndName: new Map(),
    claimedSymbolIds: new Set(),
  };

  for (const record of records) {
    const semanticSignature = normalizeSemanticSignature(record.symbol);
    const candidate: ContinuityCandidate = {
      symbolId: record.symbol.id,
      aliasHash: record.aliasHash,
      kind: record.symbol.kind,
      nameLower: record.symbol.name.toLowerCase(),
      namespacePath: record.symbol.namespacePath,
      semanticSignature,
      semanticHash: record.semanticHash,
      relativeFilePath: record.relativeFilePath,
      originAliasHash: record.originAliasHash,
      predecessorSymbolId: record.predecessorSymbolId,
    };
    state.byAliasHash.set(candidate.aliasHash, candidate);
    const key = `${candidate.kind}:${candidate.namespacePath ?? ''}:${candidate.nameLower}`;
    const bucket = state.byKindAndName.get(key) ?? [];
    bucket.push(candidate);
    state.byKindAndName.set(key, bucket);
  }

  return state;
}

/**
 * Mark existing symbol IDs as claimed for a continuity run.
 * @param state - Continuity state
 * @param symbolIds - Existing symbol ids
 */
export function claimContinuitySymbols(state: ContinuityState, symbolIds: Iterable<string>): void {
  for (const symbolId of symbolIds) {
    state.claimedSymbolIds.add(symbolId);
  }
}

interface ResolveIdentityInput {
  scopeBranch: string;
  relativeFilePath: string;
  symbol: SymbolNode;
  state: ContinuityState;
  config: ContinuityConfig;
  createAliasHash: (branch: string, relativePath: string, symbol: SymbolNode) => string;
  createSymbolId: (aliasHash: string) => string;
}

/**
 * Resolve canonical symbol identity for a parsed symbol.
 * @param input - Resolve input including config for tunable thresholds
 * @returns Stable symbol identity paired with an audit decision
 */
export function resolveSymbolIdentity(input: ResolveIdentityInput): ResolvedSymbolContinuity {
  const aliasHash = input.createAliasHash(input.scopeBranch, input.relativeFilePath, input.symbol);
  const semanticSignature = normalizeSemanticSignature(input.symbol);
  const semanticHash = createSemanticHash(input.symbol, semanticSignature);

  const aliasCandidate = input.state.byAliasHash.get(aliasHash);
  if (aliasCandidate) {
    input.state.claimedSymbolIds.add(aliasCandidate.symbolId);
    const identity: ResolvedSymbolIdentity = {
      symbolId: aliasCandidate.symbolId,
      aliasHash,
      semanticHash,
      originAliasHash: aliasCandidate.originAliasHash,
      predecessorSymbolId: aliasCandidate.predecessorSymbolId,
    };
    const decision: ContinuityDecision = {
      symbolId: aliasCandidate.symbolId,
      kind: 'alias-match',
      confidence: 1,
      algorithmVersion: CONTINUITY_ALGORITHM_VERSION,
    };
    return { identity, decision };
  }

  const { sameSymbolThreshold, lineageThreshold } = input.config;
  const key = `${input.symbol.kind}:${input.symbol.namespacePath ?? ''}:${input.symbol.name.toLowerCase()}`;
  const candidates = input.state.byKindAndName.get(key) ?? [];

  let bestCandidate: ContinuityCandidate | null = null;
  let bestScoring: ContinuityScoringInputs | null = null;

  for (const candidate of candidates) {
    if (input.state.claimedSymbolIds.has(candidate.symbolId)) continue;
    const scoring = scoreContinuity(semanticSignature, input.relativeFilePath, candidate, input.config);
    if (scoring.compositeScore > (bestScoring?.compositeScore ?? 0)) {
      bestScoring = scoring;
      bestCandidate = candidate;
    }
  }

  const compositeScore = bestScoring?.compositeScore ?? 0;

  if (bestCandidate && bestScoring && compositeScore >= sameSymbolThreshold) {
    input.state.claimedSymbolIds.add(bestCandidate.symbolId);
    const identity: ResolvedSymbolIdentity = {
      symbolId: bestCandidate.symbolId,
      aliasHash,
      semanticHash,
      originAliasHash: bestCandidate.originAliasHash,
      predecessorSymbolId: bestCandidate.predecessorSymbolId,
    };
    rememberCandidate(input.state, input.symbol, input.relativeFilePath, semanticSignature, identity);
    const decision: ContinuityDecision = {
      symbolId: bestCandidate.symbolId,
      kind: 'same',
      confidence: compositeScore,
      scoringInputs: bestScoring,
      algorithmVersion: CONTINUITY_ALGORITHM_VERSION,
    };
    return { identity, decision };
  }

  const predecessorSymbolId =
    bestCandidate && bestScoring && compositeScore >= lineageThreshold ? bestCandidate.symbolId : undefined;

  const newSymbolId = input.createSymbolId(aliasHash);
  const identity: ResolvedSymbolIdentity = {
    symbolId: newSymbolId,
    aliasHash,
    semanticHash,
    originAliasHash: aliasHash,
    predecessorSymbolId,
  };
  input.state.claimedSymbolIds.add(newSymbolId);
  rememberCandidate(input.state, input.symbol, input.relativeFilePath, semanticSignature, identity);

  const kind: ContinuityDecisionKind = predecessorSymbolId ? 'lineage' : 'new';
  const decision: ContinuityDecision = {
    symbolId: newSymbolId,
    predecessorSymbolId,
    kind,
    confidence: compositeScore,
    scoringInputs: bestScoring ?? undefined,
    algorithmVersion: CONTINUITY_ALGORITHM_VERSION,
  };
  return { identity, decision };
}

/**
 * Add the resolved symbol identity to in-memory continuity candidates.
 * @param state - Continuity state for this index run.
 * @param symbol - Parsed symbol node.
 * @param relativeFilePath - Symbol file path relative to scope root.
 * @param semanticSignature - Normalized semantic signature.
 * @param identity - Resolved symbol identity.
 * @returns Nothing.
 */
function rememberCandidate(
  state: ContinuityState,
  symbol: SymbolNode,
  relativeFilePath: string,
  semanticSignature: string,
  identity: ResolvedSymbolIdentity,
): void {
  const candidate: ContinuityCandidate = {
    symbolId: identity.symbolId,
    aliasHash: identity.aliasHash,
    kind: symbol.kind,
    nameLower: symbol.name.toLowerCase(),
    namespacePath: symbol.namespacePath,
    semanticSignature,
    semanticHash: identity.semanticHash,
    relativeFilePath,
    originAliasHash: identity.originAliasHash,
    predecessorSymbolId: identity.predecessorSymbolId,
  };

  state.byAliasHash.set(candidate.aliasHash, candidate);
  const key = `${candidate.kind}:${candidate.namespacePath ?? ''}:${candidate.nameLower}`;
  const bucket = state.byKindAndName.get(key) ?? [];
  bucket.push(candidate);
  state.byKindAndName.set(key, bucket);
}

/**
 * Score how likely a candidate matches the current symbol.
 * @param semanticSignature - Normalized semantic signature for current symbol.
 * @param relativeFilePath - Current symbol file path relative to scope root.
 * @param candidate - Candidate symbol from prior snapshot.
 * @param config - Continuity configuration weights.
 * @returns Structured scoring inputs including composite score.
 */
function scoreContinuity(
  semanticSignature: string,
  relativeFilePath: string,
  candidate: ContinuityCandidate,
  config: ContinuityConfig,
): ContinuityScoringInputs {
  const semanticSimilarity = signatureSimilarity(semanticSignature, candidate.semanticSignature);
  const pathSimilarity = calculatePathSimilarity(relativeFilePath, candidate.relativeFilePath);
  // Both similarities are Jaccard-based [0,1] and weights sum to 1.0 — score is bounded [0,1] by construction.
  const compositeScore = semanticSimilarity * config.semanticWeight + pathSimilarity * config.pathWeight;
  return { semanticSimilarity, pathSimilarity, compositeScore };
}

/**
 * Normalize a symbol signature for continuity comparisons.
 * @param symbol - Parsed symbol node.
 * @returns Normalized semantic signature.
 */
function normalizeSemanticSignature(symbol: SymbolNode): string {
  const signature = symbol.signature ?? `${symbol.kind} ${symbol.name}`;
  return signature
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * Build semantic hash from symbol kind/name/signature tuple.
 * @param symbol - Parsed symbol node.
 * @param normalizedSignature - Normalized semantic signature.
 * @returns Semantic hash.
 */
function createSemanticHash(symbol: SymbolNode, normalizedSignature: string): string {
  return createHash('sha1').update(`${symbol.kind}|${symbol.name}|${normalizedSignature}`).digest('hex');
}

/**
 * Compute token-based similarity for two semantic signatures.
 * @param left - Left normalized signature.
 * @param right - Right normalized signature.
 * @returns Jaccard similarity.
 */
function signatureSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftTokens = tokenizeSemanticSignature(left);
  const rightTokens = tokenizeSemanticSignature(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Tokenize semantic signature into lowercase identifier tokens.
 * @param value - Normalized signature value.
 * @returns Distinct token set.
 */
function tokenizeSemanticSignature(value: string): Set<string> {
  return new Set(value.split(/[^a-z0-9_]+/g).filter((token) => token.length > 0));
}

/**
 * Compare two file paths by common trailing path segments.
 * @param leftPath - Left path.
 * @param rightPath - Right path.
 * @returns Similarity score in [0, 1].
 */
function calculatePathSimilarity(leftPath: string, rightPath: string): number {
  if (leftPath === rightPath) return 1;
  const left = leftPath.toLowerCase().split(/[\\/]/g).filter(Boolean);
  const right = rightPath.toLowerCase().split(/[\\/]/g).filter(Boolean);
  if (left.length === 0 || right.length === 0) return 0;

  let commonSuffix = 0;
  while (
    commonSuffix < left.length &&
    commonSuffix < right.length &&
    left[left.length - 1 - commonSuffix] === right[right.length - 1 - commonSuffix]
  ) {
    commonSuffix += 1;
  }

  return commonSuffix / Math.max(left.length, right.length);
}
