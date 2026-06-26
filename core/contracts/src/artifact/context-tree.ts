import type { ArtifactContextRenderHint } from './context-selectors.js';
import type { ArtifactContextUnresolvedReason } from './context-resolution.js';
import type { ArtifactRef, ArtifactRelationTarget, ArtifactRevision } from './schemas.js';

/**
 * Hydrated tree representation of a resolved artifact context graph.
 *
 * The root is always a resolved node. Children may be resolved or
 * unresolved depending on resolution status.
 */
export interface ArtifactContextTree {
  /** The root artifact node — always resolved. */
  readonly root: ArtifactContextRootNode;
  /**
   * Collect all resolved artifact revisions in depth-first order.
   * @returns Ordered list of resolved artifact revisions.
   */
  flatten(): readonly ArtifactRevision[];
}

/** A node in the hydrated artifact context tree. */
export type ArtifactContextNode = ResolvedArtifactContextNode | UnresolvedArtifactContextNode;

/** Shared resolved node fields for root and relation children. */
export interface ResolvedArtifactContextNodeBase {
  readonly status: 'resolved';
  /** Artifact reference for this node. */
  readonly ref: ArtifactRef;
  /** Full artifact revision data. */
  readonly artifact: ArtifactRevision;
  /** Render hint applied to this node. */
  readonly hint: ArtifactContextRenderHint;
  /** Child nodes from this artifact's outbound relations. */
  readonly children: readonly ArtifactContextNode[];
}

/** The resolved root node; it has no parent relation. */
export type ArtifactContextRootNode = ResolvedArtifactContextNodeBase;

/** A resolved child node with artifact data and relation metadata. */
export interface ResolvedArtifactContextNode extends ResolvedArtifactContextNodeBase {
  /** Relation type that led to this node from its parent. */
  readonly relation: string;
}

/** An unresolved node representing a relation that could not be followed. */
export interface UnresolvedArtifactContextNode {
  readonly status: 'unresolved';
  /** The relation target that was not resolved. */
  readonly target: ArtifactRelationTarget;
  /** Relation type that led to this node from its parent. */
  readonly relation: string;
  /** Render hint applied to this node. */
  readonly hint: ArtifactContextRenderHint;
  /** Reason the target was not resolved. */
  readonly reason: ArtifactContextUnresolvedReason;
}
