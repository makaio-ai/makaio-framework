import type { IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  type ArtifactContextRefEntry,
  type ArtifactContextRelationSelector,
  type ArtifactContextSelector,
  type ArtifactRef,
  type ArtifactRelation,
  type ArtifactRelationTarget,
  type ArtifactRevision,
  type ResolvedArtifactContextWire,
} from '@makaio/contracts';

/**
 * Options for {@link resolveArtifactContext}.
 */
export interface ResolveArtifactContextOptions {
  /** Bus instance for artifact resolution RPCs. */
  readonly bus: IMakaioBus;
  /** Root artifact reference to resolve from. */
  readonly ref: ArtifactRef;
  /**
   * Explicit selectors for the relations to resolve. Unselected relations
   * remain unresolved links.
   */
  readonly selectors?: ArtifactContextSelector;
  /** Maximum traversal depth (defaults to 5). */
  readonly maxDepth?: number;
}

interface ResolverState {
  readonly bus: IMakaioBus;
  readonly maxDepth: number;
  readonly resolvedByKey: Map<string, ArtifactRevision | null>;
  readonly walkedByKey: Set<string>;
  readonly refIndexByKey: Map<string, number>;
  readonly refMetadataByKey: Map<string, RefMetadata>;
  readonly resolved: ArtifactRevision[];
  readonly refs: ArtifactContextRefEntry[];
}

interface RefMetadata {
  readonly resolvedViaBackEdge: boolean;
}

/**
 * Resolve a selector-driven outbound artifact context graph.
 * @param options - Bus, root ref, and explicit relation selectors.
 * @returns Normalized wire context with all encountered refs visible.
 */
export async function resolveArtifactContext(
  options: ResolveArtifactContextOptions,
): Promise<ResolvedArtifactContextWire> {
  const maxDepth = options.maxDepth ?? 5;
  const state: ResolverState = {
    bus: options.bus,
    maxDepth,
    resolvedByKey: new Map(),
    walkedByKey: new Set(),
    refIndexByKey: new Map(),
    refMetadataByKey: new Map(),
    resolved: [],
    refs: [],
  };

  const root = await resolveRef(state, options.ref);
  if (!root) {
    throw new Error(
      `artifact.resolveContext: root artifact '${options.ref.kind}:${options.ref.id}:${options.ref.revision}' not found`,
    );
  }

  state.resolved.push(root);
  await walkArtifact(state, root, options.selectors, 0, new Set([artifactRefKey(options.ref)]));

  return {
    rootRef: options.ref,
    refs: state.refs,
    resolved: state.resolved,
  };
}

/**
 * Walk an artifact's outbound relations using the merged selectors.
 * @param state - Resolver state accumulator.
 * @param artifact - Current artifact to walk.
 * @param selectors - Merged selectors for this artifact's relations.
 * @param depth - Current traversal depth.
 * @param path - Ancestor ref keys for cycle detection.
 */
async function walkArtifact(
  state: ResolverState,
  artifact: ArtifactRevision,
  selectors: ArtifactContextSelector | undefined,
  depth: number,
  path: ReadonlySet<string>,
): Promise<void> {
  const walkKey = artifactWalkKey(artifact, selectors, depth, path);
  if (state.walkedByKey.has(walkKey)) {
    return;
  }
  state.walkedByKey.add(walkKey);

  const sourceRef = artifactToRef(artifact);
  for (const relation of artifact.relations) {
    await resolveRelation(state, sourceRef, relation, selectors, depth, path);
  }
}

/**
 * Resolve a single outbound relation from a source artifact.
 * @param state - Resolver state accumulator.
 * @param sourceRef - Source artifact reference.
 * @param relation - Outbound relation to resolve.
 * @param selectors - Merged selectors for this artifact's relations.
 * @param depth - Current traversal depth.
 * @param path - Ancestor ref keys for cycle detection.
 */
async function resolveRelation(
  state: ResolverState,
  sourceRef: ArtifactRef,
  relation: ArtifactRelation,
  selectors: ArtifactContextSelector | undefined,
  depth: number,
  path: ReadonlySet<string>,
): Promise<void> {
  const selector = selectors?.[relation.type];
  if (selector?.hint === 'omit') {
    return;
  }
  const hint = selector?.hint ?? 'link';

  if (!selectorMatches(selector, relation.target)) {
    recordRef(state, unresolved(sourceRef, relation, hint, 'not-selected'));
    return;
  }

  if (relation.target.refClass !== 'artifact') {
    recordRef(state, unresolved(sourceRef, relation, hint, 'unsupported-ref-class'));
    return;
  }

  const targetKey = artifactRefKey(relation.target);
  const isBackEdge = path.has(targetKey);
  if (depth >= state.maxDepth && !isBackEdge) {
    recordRef(state, unresolved(sourceRef, relation, hint, 'depth-exceeded'));
    return;
  }

  const alreadyResolved = state.resolvedByKey.has(targetKey);
  const target = await resolveRef(state, relation.target);
  if (!target) {
    recordRef(state, unresolved(sourceRef, relation, hint, 'not-found'));
    return;
  }

  recordRef(
    state,
    {
      sourceRef,
      target: relation.target,
      relationType: relation.type,
      hint,
      status: 'resolved',
    },
    { resolvedViaBackEdge: isBackEdge },
  );
  if (!alreadyResolved) {
    state.resolved.push(target);
  }
  if (isBackEdge) {
    return;
  }

  const remainingDepth = (selector.depth ?? 1) - 1;
  const continuedSelector =
    remainingDepth > 0
      ? ({
          [relation.type]: {
            ...selector,
            depth: remainingDepth,
          },
        } satisfies ArtifactContextSelector)
      : undefined;
  const nestedSelectors = mergeSelectors(continuedSelector, selector.nested);
  const nextPath = new Set(path);
  nextPath.add(targetKey);
  await walkArtifact(state, target, nestedSelectors, depth + 1, nextPath);
}

/**
 * Resolve an artifact ref using the per-call cache.
 * @param state - Resolver state with cache.
 * @param ref - Artifact reference to resolve.
 * @returns Resolved artifact revision, or `null` if not found.
 */
async function resolveRef(state: ResolverState, ref: ArtifactRef): Promise<ArtifactRevision | null> {
  const key = artifactRefKey(ref);
  if (state.resolvedByKey.has(key)) {
    return state.resolvedByKey.get(key) ?? null;
  }
  const { artifact } = await state.bus.request(ArtifactSubjects.resolve, {
    ref,
  });
  state.resolvedByKey.set(key, artifact);
  return artifact;
}

/**
 * Merge continued traversal selectors with explicit nested overrides.
 *
 * Nested overrides replace continued selectors per relation type. An
 * override with `hint: 'omit'` suppresses that relation type during
 * resolution.
 * @param continued - Selectors carried forward by the requested traversal depth.
 * @param callerOverride - Caller-provided selector overrides.
 * @returns Merged selector map.
 */
function mergeSelectors(
  continued: ArtifactContextSelector | undefined,
  callerOverride: ArtifactContextSelector | undefined,
): ArtifactContextSelector | undefined {
  if (!callerOverride) return continued;
  if (!continued) {
    return callerOverride;
  }

  const result: Record<string, ArtifactContextRelationSelector> = {
    ...continued,
  };
  for (const [relationType, selector] of Object.entries(callerOverride)) {
    result[relationType] = selector;
  }
  return result;
}

/**
 * Check whether a selector matches a relation target.
 * @param selector - Per-relation selector.
 * @param target - Relation target to check.
 * @returns Whether the selector applies.
 */
function selectorMatches(
  selector: ArtifactContextRelationSelector | undefined,
  target: ArtifactRelationTarget,
): selector is ArtifactContextRelationSelector {
  if (!selector) return false;
  if (!selector.kinds) return true;
  const kind = relationTargetKind(target);
  return kind !== undefined && selector.kinds.includes(kind);
}

/**
 * Resolve the kind discriminator used by selector kind filters.
 * @param target - Relation target to inspect.
 * @returns Kind string, or undefined for a separately managed entity.
 */
function relationTargetKind(target: ArtifactRelationTarget): string | undefined {
  if (target.refClass === 'entity') return undefined;
  return target.refClass === 'local' ? target.artifact.kind : target.kind;
}

/**
 * Create an unresolved context ref entry.
 * @param sourceRef - Source artifact reference.
 * @param relation - The outbound relation.
 * @param hint - Render hint for the entry.
 * @param reason - Reason the target was not resolved.
 * @returns Unresolved ref entry.
 */
function unresolved(
  sourceRef: ArtifactRef,
  relation: ArtifactRelation,
  hint: string,
  reason: ArtifactContextRefEntry['reason'],
): ArtifactContextRefEntry {
  return {
    sourceRef,
    target: relation.target,
    relationType: relation.type,
    hint,
    status: 'unresolved',
    reason,
  };
}

/**
 * Record a relation entry once in the pathless wire graph.
 * @param state - Resolver state accumulator.
 * @param entry - Relation entry to record.
 * @param metadata - Internal provenance for precedence decisions.
 */
function recordRef(state: ResolverState, entry: ArtifactContextRefEntry, metadata?: RefMetadata): void {
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
  state: ResolverState,
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
  state: ResolverState,
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
function setResolvedMetadata(state: ResolverState, key: string, metadata: RefMetadata | undefined): void {
  state.refMetadataByKey.set(key, metadata ?? { resolvedViaBackEdge: false });
}

/**
 * Remove provenance when a relation is no longer recorded as resolved.
 * @param state - Resolver state accumulator.
 * @param key - Pathless relation key being cleared.
 */
function clearRefMetadata(state: ResolverState, key: string): void {
  state.refMetadataByKey.delete(key);
}

/**
 * Check whether stored provenance marks a relation as resolved through a back-edge.
 * @param state - Resolver state accumulator.
 * @param key - Pathless relation key to inspect.
 * @returns Whether the stored resolved entry came from a path-local back-edge.
 */
function resolvedViaBackEdge(state: ResolverState, key: string): boolean {
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
 * Convert an artifact revision to an artifact ref.
 * @param artifact - Artifact revision.
 * @returns Artifact reference.
 */
function artifactToRef(artifact: ArtifactRevision): ArtifactRef {
  return {
    refClass: 'artifact',
    kind: artifact.kind,
    id: artifact.id,
    revision: artifact.revision,
  };
}

/**
 * Build a cache key from an artifact reference.
 * @param ref - Artifact reference.
 * @returns Composite cache key.
 */
function artifactRefKey(ref: ArtifactRef): string {
  return JSON.stringify([ref.kind, ref.id, ref.revision]);
}

/**
 * Build a key for a source relation in the pathless wire graph.
 * @param entry - Context relation entry to key.
 * @returns Stable relation identity key.
 */
function refEntryKey(entry: ArtifactContextRefEntry): string {
  return JSON.stringify([artifactRefKey(entry.sourceRef), entry.relationType, relationTargetKey(entry.target)]);
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
    return JSON.stringify(['local', artifactRefKey(target.artifact), target.localId]);
  }
  return JSON.stringify(['evidence', target.kind, target.id, target.revision ?? null, target.locator ?? null]);
}

/**
 * Build a traversal key for a pathless graph walk.
 * @param artifact - Artifact revision being walked.
 * @param selectors - Selector context applied to the artifact.
 * @param depth - Current traversal depth.
 * @param path - Current path membership for cycle-sensitive expansion.
 * @returns Composite traversal key.
 */
function artifactWalkKey(
  artifact: ArtifactRevision,
  selectors: ArtifactContextSelector | undefined,
  depth: number,
  path: ReadonlySet<string>,
): string {
  return JSON.stringify([artifact.kind, artifact.id, artifact.revision, depth, selectors ?? null, [...path].sort()]);
}
