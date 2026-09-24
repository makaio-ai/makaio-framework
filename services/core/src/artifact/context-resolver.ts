import type { IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  type ArtifactContextRelationSelector,
  type ArtifactContextSelector,
  type ArtifactRef,
  type ArtifactRelation,
  type ArtifactRelationTarget,
  type ArtifactRevision,
  type ResolvedArtifactContextWire,
} from '@makaio/contracts';
import { artifactRevisionKey } from '@makaio/contracts/artifact';
import { recordRef, refEntry, type ContextEdgeFields, type ContextRefLedger } from './context-ref-ledger.js';

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

interface ResolverState extends ContextRefLedger {
  readonly bus: IMakaioBus;
  readonly maxDepth: number;
  readonly resolvedByKey: Map<string, ArtifactRevision | null>;
  readonly walkedByKey: Set<string>;
  /** Inbound query results keyed by `[relationType, kind, id]`, including empty results. */
  readonly inboundByKey: Map<string, readonly ArtifactRevision[]>;
  readonly resolved: ArtifactRevision[];
}

/**
 * Resolve a selector-driven artifact context graph.
 *
 * Selectors follow stored relations outbound by default. A selector with
 * `direction: 'inbound'` instead selects the current revisions of artifacts
 * whose relations of that type point at the walked artifact's identity.
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
    inboundByKey: new Map(),
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
  await walkArtifact(state, root, options.selectors, 0, new Set([artifactRevisionKey(options.ref)]));

  return {
    rootRef: options.ref,
    refs: state.refs,
    resolved: state.resolved,
  };
}

/**
 * One artifact-targeted traversal edge ready for resolution, independent of the stored relation's direction.
 */
interface EdgeCandidate extends ContextEdgeFields {
  /** Artifact revision the edge points at. */
  readonly target: ArtifactRef;
  /** Loads the target revision through the per-call cache. */
  readonly load: () => Promise<ArtifactRevision | null>;
}

/**
 * Walk an artifact's relations using the merged selectors.
 *
 * Stored (outbound) relations are visited first; inbound selectors then
 * query the store for artifacts pointing back at this artifact.
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
  if (state.walkedByKey.has(walkKey)) return;
  state.walkedByKey.add(walkKey);

  const sourceRef = artifactToRef(artifact);
  for (const relation of artifact.relations) {
    await resolveRelation(state, sourceRef, relation, selectors, depth, path);
  }
  for (const [relationType, selector] of Object.entries(selectors ?? {})) {
    if (selector.direction === 'inbound') {
      await resolveInboundRelations(state, sourceRef, relationType, selector, depth, path);
    }
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
  // `omit` suppresses the relation type in both directions. Otherwise an
  // inbound selector never selects the stored relation of the same type; the
  // inbound walk records its own edges from the query result.
  const declared = selectors?.[relation.type];
  if (declared?.hint === 'omit') return;
  const selector = declared?.direction === 'inbound' ? undefined : declared;

  const { target } = relation;
  const edge = { sourceRef, relationType: relation.type, sourceLocalId: relation.sourceLocalId, selector };
  if (target.refClass !== 'artifact') {
    // Kind filters apply before the ref-class check, so an unselected evidence ref stays `not-selected`.
    const reason = selectorMatches(selector, target) ? 'unsupported-ref-class' : 'not-selected';
    recordRef(state, refEntry({ ...edge, target }, { status: 'unresolved', reason }));
    return;
  }
  await resolveEdge(state, { ...edge, target, load: () => resolveRef(state, target) }, depth, path);
}

/**
 * Resolve the artifacts whose relations of one type point at the walked artifact.
 *
 * Only whole-artifact targets count: a stored relation matches when it is an
 * `artifact` ref with the walked artifact's kind and id, so relations pinned
 * to an earlier revision still count, while relations targeting a `local`
 * part of the walked artifact do not. Each match becomes a context edge from
 * the walked artifact to the matching artifact's current revision, marked
 * `direction: 'inbound'`. Query results are cached per relation type and
 * identity for the whole call.
 * @param state - Resolver state accumulator.
 * @param sourceRef - Walked artifact the inbound relations point at.
 * @param relationType - Relation type declared by the inbound selector.
 * @param selector - Inbound selector for this relation type.
 * @param depth - Current traversal depth.
 * @param path - Ancestor ref keys for cycle detection.
 */
async function resolveInboundRelations(
  state: ResolverState,
  sourceRef: ArtifactRef,
  relationType: string,
  selector: ArtifactContextRelationSelector,
  depth: number,
  path: ReadonlySet<string>,
): Promise<void> {
  if (selector.hint === 'omit') return;
  const queryKey = JSON.stringify([relationType, sourceRef.kind, sourceRef.id]);
  let sources = state.inboundByKey.get(queryKey);
  if (!sources) {
    const { artifacts } = await state.bus.request(ArtifactSubjects.query, {
      relation: { type: relationType, target: { refClass: 'artifact', kind: sourceRef.kind, id: sourceRef.id } },
      currentOnly: true,
    });
    sources = artifacts;
    state.inboundByKey.set(queryKey, sources);
  }

  for (const source of sources) {
    const target = artifactToRef(source);
    for (const relation of source.relations) {
      if (relation.type !== relationType || !relationTargetsIdentity(relation.target, sourceRef)) {
        continue;
      }
      const candidate: EdgeCandidate = {
        sourceRef,
        target,
        relationType,
        sourceLocalId: relation.sourceLocalId,
        direction: 'inbound',
        selector,
        load: () => resolveRef(state, target, async () => source),
      };
      await resolveEdge(state, candidate, depth, path);
    }
  }
}

/**
 * Resolve one artifact-targeted edge, record it, and continue the walk through its target.
 *
 * Checks run in a fixed order: selector match (`not-selected`), depth limit
 * (`depth-exceeded`, skipped for back-edges), then loading (`not-found`). A
 * back-edge is recorded as resolved but not walked again.
 * @param state - Resolver state accumulator.
 * @param candidate - Edge to resolve.
 * @param depth - Current traversal depth.
 * @param path - Ancestor ref keys for cycle detection.
 */
async function resolveEdge(
  state: ResolverState,
  candidate: EdgeCandidate,
  depth: number,
  path: ReadonlySet<string>,
): Promise<void> {
  const { selector, target } = candidate;
  if (!selectorMatches(selector, target)) {
    recordRef(state, refEntry(candidate, { status: 'unresolved', reason: 'not-selected' }));
    return;
  }

  const targetKey = artifactRevisionKey(target);
  const isBackEdge = path.has(targetKey);
  if (depth >= state.maxDepth && !isBackEdge) {
    recordRef(state, refEntry(candidate, { status: 'unresolved', reason: 'depth-exceeded' }));
    return;
  }

  const alreadyResolved = state.resolvedByKey.has(targetKey);
  const next = await candidate.load();
  if (!next) {
    recordRef(state, refEntry(candidate, { status: 'unresolved', reason: 'not-found' }));
    return;
  }

  recordRef(state, refEntry(candidate, { status: 'resolved' }), { resolvedViaBackEdge: isBackEdge });
  if (!alreadyResolved) state.resolved.push(next);
  if (isBackEdge) return;

  await continueWalk(state, next, targetKey, candidate.relationType, selector, depth, path);
}

/**
 * Continue the walk into a resolved artifact with the selector's remaining depth and nested overrides.
 * @param state - Resolver state accumulator.
 * @param next - Resolved artifact to walk next.
 * @param nextKey - Revision key of `next`, added to the ancestor path.
 * @param relationType - Relation type that led to `next`.
 * @param selector - Selector that resolved the edge.
 * @param depth - Depth of the artifact the edge started from.
 * @param path - Ancestor ref keys up to and excluding `next`.
 */
async function continueWalk(
  state: ResolverState,
  next: ArtifactRevision,
  nextKey: string,
  relationType: string,
  selector: ArtifactContextRelationSelector,
  depth: number,
  path: ReadonlySet<string>,
): Promise<void> {
  const remainingDepth = (selector.depth ?? 1) - 1;
  const continued: ArtifactContextSelector | undefined =
    remainingDepth > 0 ? { [relationType]: { ...selector, depth: remainingDepth } } : undefined;
  await walkArtifact(state, next, mergeSelectors(continued, selector.nested), depth + 1, new Set([...path, nextKey]));
}

/**
 * Resolve an artifact ref using the per-call cache.
 *
 * The cache is the single admission path: a cached entry (including a cached
 * `null`) wins over `fetch`, and whatever `fetch` returns is cached.
 * @param state - Resolver state with cache.
 * @param ref - Artifact reference to resolve.
 * @param fetch - Loader for a cache miss; defaults to the `artifact.resolve` RPC.
 * @returns Resolved artifact revision, or `null` if not found.
 */
async function resolveRef(
  state: ResolverState,
  ref: ArtifactRef,
  fetch: () => Promise<ArtifactRevision | null> = async () =>
    (await state.bus.request(ArtifactSubjects.resolve, { ref })).artifact,
): Promise<ArtifactRevision | null> {
  const key = artifactRevisionKey(ref);
  if (state.resolvedByKey.has(key)) return state.resolvedByKey.get(key) ?? null;
  const artifact = await fetch();
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
  if (!callerOverride || !continued) return callerOverride ?? continued;
  return { ...continued, ...callerOverride };
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
 * Check whether a stored relation target is a whole-artifact ref to an identity, ignoring the pinned revision.
 *
 * `local` targets (parts of an artifact) never match.
 * @param target - Stored relation target to inspect.
 * @param identity - Artifact identity to match.
 * @returns Whether the target is an `artifact` ref with the identity's kind and id.
 */
function relationTargetsIdentity(target: ArtifactRelationTarget, identity: ArtifactRef): boolean {
  return target.refClass === 'artifact' && target.kind === identity.kind && target.id === identity.id;
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
 * Convert an artifact revision to an artifact ref.
 * @param artifact - Artifact revision.
 * @returns Artifact reference.
 */
function artifactToRef(artifact: ArtifactRevision): ArtifactRef {
  return { refClass: 'artifact', kind: artifact.kind, id: artifact.id, revision: artifact.revision };
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
