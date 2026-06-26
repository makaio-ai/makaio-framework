import type {
  ArtifactContextNode,
  ArtifactContextRootNode,
  ArtifactContextTree,
  ResolvedArtifactContextNode,
  UnresolvedArtifactContextNode,
} from './context-tree.js';
import {
  ResolvedArtifactContextWireSchema,
  type ArtifactContextRefEntry,
  type ResolvedArtifactContextWire,
} from './context-resolution.js';
import type { ArtifactContextRenderHint } from './context-selectors.js';
import type { ArtifactRef, ArtifactRevision } from './schemas.js';

/**
 * Hydrate a normalized artifact context wire payload into a tree.
 * @param wire - Normalized resolved artifact context payload.
 * @returns Tree view with a convenience flatten method.
 */
export function hydrateArtifactContextTree(wire: ResolvedArtifactContextWire): ArtifactContextTree {
  const normalizedWire = ResolvedArtifactContextWireSchema.parse(wire);
  const artifactByKey = new Map(
    normalizedWire.resolved.map((artifact) => [artifactRefKey(artifact), artifact] as const),
  );
  const refsBySource = new Map<string, ArtifactContextRefEntry[]>();
  for (const entry of normalizedWire.refs) {
    const key = artifactRefKey(entry.sourceRef);
    let entries = refsBySource.get(key);
    if (!entries) {
      entries = [];
      refsBySource.set(key, entries);
    }
    entries.push(entry);
  }

  const rootArtifact = artifactByKey.get(artifactRefKey(normalizedWire.rootRef));
  if (!rootArtifact) {
    throw new Error(`Resolved artifact context is missing root artifact '${artifactRefKey(normalizedWire.rootRef)}'`);
  }

  const root = buildRootNode(normalizedWire.rootRef, rootArtifact, 'inline', refsBySource, artifactByKey);

  return {
    root,
    flatten(): readonly ArtifactRevision[] {
      const artifacts: ArtifactRevision[] = [];
      collectResolved(root, artifacts);
      return artifacts;
    },
  };
}

/**
 * Build the resolved root tree node.
 * @param ref - Root artifact reference.
 * @param artifact - Root artifact revision.
 * @param hint - Render hint for the root node.
 * @param refsBySource - Lookup of ref entries by source key.
 * @param artifactByKey - Lookup of resolved artifacts by key.
 * @returns Root context node without parent relation metadata.
 */
function buildRootNode(
  ref: ArtifactRef,
  artifact: ArtifactRevision,
  hint: ArtifactContextRenderHint,
  refsBySource: ReadonlyMap<string, readonly ArtifactContextRefEntry[]>,
  artifactByKey: ReadonlyMap<string, ArtifactRevision>,
): ArtifactContextRootNode {
  return {
    status: 'resolved',
    ref,
    artifact,
    hint,
    children: buildChildren(ref, refsBySource, artifactByKey, new Set([artifactRefKey(ref)])),
  };
}

/**
 * Build a resolved tree node and recursively resolve its children.
 * @param ref - Artifact reference for this node.
 * @param artifact - Full artifact revision data.
 * @param relation - Relation type from parent.
 * @param hint - Render hint for this node.
 * @param refsBySource - Lookup of ref entries by source key.
 * @param artifactByKey - Lookup of resolved artifacts by key.
 * @param path - Ancestor keys for cycle detection.
 * @returns Resolved context node with children.
 */
function buildResolvedNode(
  ref: ArtifactRef,
  artifact: ArtifactRevision,
  relation: string,
  hint: ArtifactContextRenderHint,
  refsBySource: ReadonlyMap<string, readonly ArtifactContextRefEntry[]>,
  artifactByKey: ReadonlyMap<string, ArtifactRevision>,
  path: ReadonlySet<string>,
): ResolvedArtifactContextNode {
  const key = artifactRefKey(ref);
  const nextPath = new Set(path);
  nextPath.add(key);
  const children = buildChildren(ref, refsBySource, artifactByKey, nextPath);

  return { status: 'resolved', ref, artifact, relation, hint, children };
}

/**
 * Build child nodes for an artifact reference.
 * @param sourceRef - Artifact whose outgoing relation entries are hydrated.
 * @param refsBySource - Lookup of ref entries by source key.
 * @param artifactByKey - Lookup of resolved artifacts by key.
 * @param path - Ancestor keys for cycle detection.
 * @returns Hydrated child nodes.
 */
function buildChildren(
  sourceRef: ArtifactRef,
  refsBySource: ReadonlyMap<string, readonly ArtifactContextRefEntry[]>,
  artifactByKey: ReadonlyMap<string, ArtifactRevision>,
  path: ReadonlySet<string>,
): readonly ArtifactContextNode[] {
  return (refsBySource.get(artifactRefKey(sourceRef)) ?? []).map((entry): ArtifactContextNode => {
    if (entry.status === 'unresolved') {
      return {
        status: 'unresolved',
        target: entry.target,
        relation: entry.relationType,
        hint: entry.hint,
        reason: entry.reason!,
      } satisfies UnresolvedArtifactContextNode;
    }

    if (entry.target.refClass !== 'artifact') {
      throw new Error('Resolved artifact context refs must target an artifact revision');
    }

    const childKey = artifactRefKey(entry.target);
    const childArtifact = artifactByKey.get(childKey);
    if (!childArtifact) {
      throw new Error(`Resolved artifact context is missing target artifact '${childKey}'`);
    }
    if (path.has(childKey)) {
      return {
        status: 'unresolved',
        target: entry.target,
        relation: entry.relationType,
        hint: entry.hint,
        reason: 'cycle-detected',
      } satisfies UnresolvedArtifactContextNode;
    }

    return buildResolvedNode(
      entry.target,
      childArtifact,
      entry.relationType,
      entry.hint,
      refsBySource,
      artifactByKey,
      path,
    );
  });
}

/**
 * Collect resolved artifacts from a context tree in depth-first order.
 * @param node - Current node.
 * @param artifacts - Accumulator for resolved artifacts.
 */
function collectResolved(node: ArtifactContextNode | ArtifactContextRootNode, artifacts: ArtifactRevision[]): void {
  if (node.status === 'unresolved') return;
  artifacts.push(node.artifact);
  for (const child of node.children) {
    collectResolved(child, artifacts);
  }
}

/**
 * Build a cache key from any artifact-identifying object.
 * @param ref - Object with kind, id, and revision fields.
 * @returns Composite cache key.
 */
function artifactRefKey(ref: { kind: string; id: string; revision: string }): string {
  return JSON.stringify([ref.kind, ref.id, ref.revision]);
}
