import type {
  ArtifactContextRefEntry,
  ArtifactContextRelationSelector,
  ArtifactRef,
  ArtifactRelationTarget,
} from '@makaio/contracts';
import { artifactRevisionKey } from '@makaio/contracts/artifact';

/**
 * Provenance kept per recorded relation entry.
 */
export interface RefMetadata {
  /** Whether the resolved entry was reached through a path-local back-edge. */
  readonly resolvedViaBackEdge: boolean;
}

/**
 * Mutable ledger of pathless relation entries collected during a context walk.
 *
 * Entries are keyed by source, relation type, direction, and target so that the
 * same relation reached through different paths is recorded once, with the
 * most informative status winning.
 */
export interface ContextRefLedger {
  /** Index of each recorded entry in {@link ContextRefLedger.refs} by relation key. */
  readonly refIndexByKey: Map<string, number>;
  /** Provenance of resolved entries by relation key. */
  readonly refMetadataByKey: Map<string, RefMetadata>;
  /** Recorded entries in first-seen order. */
  readonly refs: ArtifactContextRefEntry[];
}

/**
 * Identity of one context edge plus the selector that renders it.
 */
export interface ContextEdgeFields {
  /** Walked artifact the edge starts from. */
  readonly sourceRef: ArtifactRef;
  /** Relation target the edge points at. */
  readonly target: ArtifactRelationTarget;
  /** Relation type of the stored relation. */
  readonly relationType: string;
  /** Local identifier of the part that owns the stored relation. */
  readonly sourceLocalId?: string;
  /** Set when the stored relation lives on the target and points back at the source. */
  readonly direction?: 'inbound';
  /** Selector applying to the edge; `undefined` leaves it unselected with the default `link` hint. */
  readonly selector: ArtifactContextRelationSelector | undefined;
}

/**
 * Build a context ref entry for an edge; `direction` is omitted for outbound edges.
 * @param edge - Edge identity fields and the selector providing the render hint.
 * @param outcome - Resolution status, with the reason when unresolved.
 * @returns Context ref entry.
 */
export function refEntry(
  edge: ContextEdgeFields,
  outcome: Pick<ArtifactContextRefEntry, 'status' | 'reason'>,
): ArtifactContextRefEntry {
  return {
    sourceRef: edge.sourceRef,
    target: edge.target,
    relationType: edge.relationType,
    sourceLocalId: edge.sourceLocalId,
    ...(edge.direction ? { direction: edge.direction } : {}),
    hint: edge.selector?.hint ?? 'link',
    ...outcome,
  };
}

/**
 * Record a relation entry once in the pathless wire graph.
 * @param state - Resolver state accumulator.
 * @param entry - Relation entry to record.
 * @param metadata - Internal provenance for precedence decisions.
 */
export function recordRef(state: ContextRefLedger, entry: ArtifactContextRefEntry, metadata?: RefMetadata): void {
  const key = refEntryKey(entry);
  const existingIndex = state.refIndexByKey.get(key);
  if (existingIndex === undefined) {
    state.refIndexByKey.set(key, state.refs.length);
    setEntryMetadata(state, key, entry, metadata);
    state.refs.push(entry);
    return;
  }

  const existing = state.refs[existingIndex];
  if (!existing) return;

  if (entry.status === 'unresolved' && entry.reason === 'depth-exceeded') {
    // Depth-exceeded only wins over a resolved entry when that entry came from
    // a path-local back-edge. A normally resolved source relation must remain
    // resolved, and a precise unresolved reason must remain precise, if a later,
    // longer path encounters the same pathless relation at the depth limit.
    if (!canDepthExceededReplaceExisting(existing, resolvedViaBackEdge(state, key))) {
      return;
    }
    replaceRefEntry(state, existingIndex, key, entry, metadata);
    return;
  }

  if (existing.status === 'unresolved' && existing.reason === 'depth-exceeded') {
    if (
      (entry.status === 'resolved' && isResolvedViaBackEdge(metadata)) ||
      (entry.status === 'unresolved' && !canUnresolvedReplaceExisting(entry.reason, existing.reason))
    ) {
      return;
    }
    replaceRefEntry(state, existingIndex, key, entry, metadata);
    return;
  }

  if (entry.status === 'unresolved' && existing.status === 'unresolved') {
    if (canUnresolvedReplaceExisting(entry.reason, existing.reason)) {
      replaceRefEntry(state, existingIndex, key, entry, metadata);
    }
    return;
  }

  if (entry.status === 'resolved' && existing.status === 'unresolved') {
    replaceRefEntry(state, existingIndex, key, entry, metadata);
    return;
  }

  if (entry.status === 'resolved' && !isResolvedViaBackEdge(metadata)) {
    setResolvedMetadata(state, key, metadata);
  }
}

/**
 * Decide whether a new depth miss can replace a known pathless relation.
 * @param existing - Existing relation entry for the same source/target.
 * @param existingResolvedViaBackEdge - Whether the existing resolved entry came from a back-edge.
 * @returns Whether the depth-exceeded entry may replace the existing entry.
 */
function canDepthExceededReplaceExisting(
  existing: ArtifactContextRefEntry,
  existingResolvedViaBackEdge: boolean,
): boolean {
  if (existing.status === 'resolved') {
    return existingResolvedViaBackEdge;
  }
  return canUnresolvedReplaceExisting('depth-exceeded', existing.reason);
}

/**
 * Decide whether an unresolved reason is more informative for a pathless relation.
 * @param incomingReason - New unresolved reason for the relation.
 * @param existingReason - Existing unresolved reason for the relation.
 * @returns Whether the incoming reason should replace the existing reason.
 */
function canUnresolvedReplaceExisting(
  incomingReason: ArtifactContextRefEntry['reason'],
  existingReason: ArtifactContextRefEntry['reason'],
): boolean {
  return unresolvedReasonPrecedence(incomingReason) > unresolvedReasonPrecedence(existingReason);
}

/**
 * Rank unresolved relation reasons by how much traversal information they carry.
 * @param reason - Unresolved reason to rank.
 * @returns Precedence rank; larger values preserve more information.
 */
function unresolvedReasonPrecedence(reason: ArtifactContextRefEntry['reason']): number {
  if (reason === 'not-selected') return 0;
  if (reason === 'depth-exceeded') return 1;
  return 2;
}

/**
 * Replace a pathless relation entry and keep provenance metadata aligned.
 * @param state - Resolver state accumulator.
 * @param existingIndex - Index of the relation entry to replace.
 * @param key - Pathless relation key being replaced.
 * @param entry - New relation entry.
 * @param metadata - Provenance for resolved entries.
 */
function replaceRefEntry(
  state: ContextRefLedger,
  existingIndex: number,
  key: string,
  entry: ArtifactContextRefEntry,
  metadata: RefMetadata | undefined,
): void {
  setEntryMetadata(state, key, entry, metadata);
  state.refs[existingIndex] = entry;
}

/**
 * Keep relation provenance aligned with a relation entry.
 * @param state - Resolver state accumulator.
 * @param key - Pathless relation key being recorded.
 * @param entry - Relation entry whose provenance is being recorded.
 * @param metadata - Provenance for resolved entries.
 */
function setEntryMetadata(
  state: ContextRefLedger,
  key: string,
  entry: ArtifactContextRefEntry,
  metadata: RefMetadata | undefined,
): void {
  if (entry.status === 'resolved') {
    setResolvedMetadata(state, key, metadata);
    return;
  }
  clearRefMetadata(state, key);
}

/**
 * Store resolved-entry provenance with a conservative default for missing metadata.
 * @param state - Resolver state accumulator.
 * @param key - Pathless relation key being recorded.
 * @param metadata - Provenance for the resolved entry.
 */
function setResolvedMetadata(state: ContextRefLedger, key: string, metadata: RefMetadata | undefined): void {
  state.refMetadataByKey.set(key, metadata ?? { resolvedViaBackEdge: false });
}

/**
 * Remove provenance when a relation is no longer recorded as resolved.
 * @param state - Resolver state accumulator.
 * @param key - Pathless relation key being cleared.
 */
function clearRefMetadata(state: ContextRefLedger, key: string): void {
  state.refMetadataByKey.delete(key);
}

/**
 * Check whether stored provenance marks a relation as resolved through a back-edge.
 * @param state - Resolver state accumulator.
 * @param key - Pathless relation key to inspect.
 * @returns Whether the stored resolved entry came from a path-local back-edge.
 */
function resolvedViaBackEdge(state: ContextRefLedger, key: string): boolean {
  return isResolvedViaBackEdge(state.refMetadataByKey.get(key));
}

/**
 * Check whether explicit provenance marks a resolved entry as a back-edge.
 * @param metadata - Provenance to inspect.
 * @returns Whether the provenance represents a path-local back-edge.
 */
function isResolvedViaBackEdge(metadata: RefMetadata | undefined): boolean {
  return metadata?.resolvedViaBackEdge === true;
}

/**
 * Build a key for a source relation in the pathless wire graph.
 * @param entry - Context relation entry to key.
 * @returns Stable relation identity key.
 */
function refEntryKey(entry: ArtifactContextRefEntry): string {
  return JSON.stringify([
    artifactRevisionKey(entry.sourceRef),
    entry.sourceLocalId ?? null,
    entry.relationType,
    entry.direction ?? 'outbound',
    relationTargetKey(entry.target),
  ]);
}

/**
 * Build a key for an artifact relation target.
 * @param target - Relation target to key.
 * @returns Stable target identity key.
 */
function relationTargetKey(target: ArtifactRelationTarget): string {
  if (target.refClass === 'entity') {
    return JSON.stringify(['entity', target.entityType, target.id]);
  }
  if (target.refClass === 'artifact') {
    return JSON.stringify(['artifact', target.kind, target.id, target.revision]);
  }
  if (target.refClass === 'local') {
    return JSON.stringify(['local', artifactRevisionKey(target.artifact), target.localId]);
  }
  return JSON.stringify(['evidence', target.kind, target.id, target.revision ?? null, target.locator ?? null]);
}
