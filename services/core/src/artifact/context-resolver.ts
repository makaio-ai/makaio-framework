import type { IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  type ArtifactContextRefEntry,
  type ArtifactContextRelationSelector,
  type ArtifactContextSelector,
  type ArtifactKindRegistration,
  type ArtifactRef,
  type ArtifactRelation,
  type ArtifactRelationTarget,
  type ArtifactRevision,
  type ResolvedArtifactContextWire,
} from '@makaio/contracts';

type MaybePromise<T> = T | Promise<T>;

/**
 * Kind registry interface for context resolution.
 *
 * Implementations must support versioned kind lookups so the resolver
 * can retrieve `defaultContext` selectors for each artifact kind.
 */
export interface ArtifactContextKindRegistry {
  /**
   * Look up a kind registration by kind string and schema version.
   * @param kind - Kind discriminator string.
   * @param schemaVersion - Schema version string.
   * @returns The registration record, or `undefined` if not found.
   */
  getKind(kind: string, schemaVersion: string): MaybePromise<ArtifactKindRegistration | undefined>;
}

/**
 * Options for {@link resolveArtifactContext}.
 */
export interface ResolveArtifactContextOptions {
  /** Bus instance for artifact resolution RPCs. */
  readonly bus: IMakaioBus;
  /** Kind registry for versioned defaultContext lookups. */
  readonly kindRegistry: ArtifactContextKindRegistry;
  /** Root artifact reference to resolve from. */
  readonly ref: ArtifactRef;
  /**
   * Optional caller selectors that override kind defaults per relation
   * type.
   */
  readonly selectors?: ArtifactContextSelector;
  /** Maximum traversal depth (defaults to 5). */
  readonly maxDepth?: number;
}

interface ResolverState {
  readonly bus: IMakaioBus;
  readonly kindRegistry: ArtifactContextKindRegistry;
  readonly maxDepth: number;
  readonly resolvedByKey: Map<string, ArtifactRevision | null>;
  readonly kindDefaultsCache: Map<string, ArtifactContextSelector | undefined>;
  readonly walkedByKey: Set<string>;
  readonly resolved: ArtifactRevision[];
  readonly refs: ArtifactContextRefEntry[];
}

/**
 * Resolve a selector-driven outbound artifact context graph.
 * @param options - Bus, schema registry, root ref, and optional
 *   selector overrides.
 * @returns Normalized wire context with all encountered refs visible.
 */
export async function resolveArtifactContext(
  options: ResolveArtifactContextOptions,
): Promise<ResolvedArtifactContextWire> {
  const maxDepth = options.maxDepth ?? 5;
  const state: ResolverState = {
    bus: options.bus,
    kindRegistry: options.kindRegistry,
    maxDepth,
    resolvedByKey: new Map(),
    kindDefaultsCache: new Map(),
    walkedByKey: new Set(),
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
  const rootSelectors = mergeSelectors(await kindDefaultContext(state, root), options.selectors);
  await walkArtifact(state, root, rootSelectors, 0, new Set([artifactRefKey(options.ref)]));

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
  const walkKey = artifactWalkKey(artifact, selectors, depth);
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
    state.refs.push(unresolved(sourceRef, relation, hint, 'not-selected'));
    return;
  }

  if (relation.target.refClass !== 'artifact') {
    state.refs.push(unresolved(sourceRef, relation, hint, 'unsupported-ref-class'));
    return;
  }

  if (depth >= state.maxDepth) {
    state.refs.push(unresolved(sourceRef, relation, hint, 'depth-exceeded'));
    return;
  }

  const targetKey = artifactRefKey(relation.target);
  if (path.has(targetKey)) {
    state.refs.push(unresolved(sourceRef, relation, hint, 'cycle-detected'));
    return;
  }

  const alreadyResolved = state.resolvedByKey.has(targetKey);
  const target = await resolveRef(state, relation.target);
  if (!target) {
    state.refs.push(unresolved(sourceRef, relation, hint, 'not-found'));
    return;
  }

  state.refs.push({
    sourceRef,
    target: relation.target,
    relationType: relation.type,
    hint,
    status: 'resolved',
  });
  if (!alreadyResolved) {
    state.resolved.push(target);
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
  const targetDefaults = await kindDefaultContext(state, target);
  const nestedSelectors = mergeSelectors(mergeSelectors(targetDefaults, continuedSelector), selector.nested);
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
 * Retrieve default context selectors for an artifact's kind, with per-call caching.
 * @param state - Resolver state carrying the kind defaults cache.
 * @param artifact - Artifact whose kind defaults to look up.
 * @returns Default context selectors, or `undefined` if none.
 */
async function kindDefaultContext(
  state: ResolverState,
  artifact: ArtifactRevision,
): Promise<ArtifactContextSelector | undefined> {
  const cacheKey = JSON.stringify([artifact.kind, artifact.schemaVersion]);
  if (state.kindDefaultsCache.has(cacheKey)) {
    return state.kindDefaultsCache.get(cacheKey);
  }
  const defaults = (await state.kindRegistry.getKind(artifact.kind, artifact.schemaVersion))?.defaultContext;
  state.kindDefaultsCache.set(cacheKey, defaults);
  return defaults;
}

/**
 * Merge kind-default selectors with caller overrides.
 *
 * Caller overrides replace kind defaults per relation type. A caller
 * override with `hint: 'omit'` suppresses that relation type during
 * resolution.
 * @param kindDefault - Kind-level default selectors.
 * @param callerOverride - Caller-provided selector overrides.
 * @returns Merged selector map.
 */
function mergeSelectors(
  kindDefault: ArtifactContextSelector | undefined,
  callerOverride: ArtifactContextSelector | undefined,
): ArtifactContextSelector | undefined {
  if (!callerOverride) return kindDefault;
  if (!kindDefault) {
    return callerOverride;
  }

  const result: Record<string, ArtifactContextRelationSelector> = {
    ...kindDefault,
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
  return selector.kinds.includes(relationTargetKind(target));
}

/**
 * Resolve the kind discriminator used by selector kind filters.
 * @param target - Relation target to inspect.
 * @returns Kind string for selector matching.
 */
function relationTargetKind(target: ArtifactRelationTarget): string {
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
 * Build a traversal key for a pathless graph walk.
 * @param artifact - Artifact revision being walked.
 * @param selectors - Selector context applied to the artifact.
 * @param depth - Current traversal depth.
 * @returns Composite traversal key.
 */
function artifactWalkKey(
  artifact: ArtifactRevision,
  selectors: ArtifactContextSelector | undefined,
  depth: number,
): string {
  return JSON.stringify([artifact.kind, artifact.id, artifact.revision, depth, selectors ?? null]);
}
