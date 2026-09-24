import { z } from 'zod';

/** Known render hints for artifact context resolution. */
export const ARTIFACT_CONTEXT_RENDER_HINTS = ['inline', 'summary', 'link', 'omit'] as const;

/** A known render hint from the initial vocabulary. */
export type ArtifactContextKnownRenderHint = (typeof ARTIFACT_CONTEXT_RENDER_HINTS)[number];

/**
 * Render hint for artifact context entries.
 *
 * Starts with a closed initial vocabulary but the runtime schema accepts
 * any non-empty string so product code can extend the vocabulary without
 * a contract change.
 */
export type ArtifactContextRenderHint = ArtifactContextKnownRenderHint | (string & {});

/** Traversal direction of a relation selector. */
export const ARTIFACT_CONTEXT_RELATION_DIRECTIONS = ['outbound', 'inbound'] as const;

/**
 * Direction in which a relation selector follows relations of the given type.
 *
 * - `outbound` (default) follows relations stored on the walked artifact.
 * - `inbound` selects the current revisions of artifacts whose relations of
 *   this type point at the walked artifact's identity (kind + id).
 */
export type ArtifactContextRelationDirection = (typeof ARTIFACT_CONTEXT_RELATION_DIRECTIONS)[number];

/**
 * Per-relation selector controlling which relations to follow and how to
 * render the resolved context.
 */
export interface ArtifactContextRelationSelector {
  /** Restrict to these kinds of the artifact on the far side of the relation. */
  readonly kinds?: readonly string[];
  /** Render hint for the resolved entries. */
  readonly hint?: ArtifactContextRenderHint;
  /** Traversal depth along this relation type (defaults to 1). */
  readonly depth?: number;
  /** Selectors applied to the artifacts reached through this relation. */
  readonly nested?: ArtifactContextSelector;
  /** Direction to follow; defaults to `outbound`. */
  readonly direction?: ArtifactContextRelationDirection;
}

/**
 * Map from relation type to per-relation selector.
 *
 * Only relation types present in the map are followed during resolution.
 * Missing relation types fall through to kind defaults when available.
 */
export type ArtifactContextSelector = Readonly<Record<string, ArtifactContextRelationSelector>>;

/** Runtime schema for render hint strings. Accepts any non-empty string. */
export const ArtifactContextRenderHintSchema = z.string().min(1);

/** Runtime schema for relation traversal directions. */
export const ArtifactContextRelationDirectionSchema = z.enum(ARTIFACT_CONTEXT_RELATION_DIRECTIONS);

/** Runtime schema for per-relation selectors. */
export const ArtifactContextRelationSelectorSchema: z.ZodType<
  ArtifactContextRelationSelector,
  ArtifactContextRelationSelector
> = z.object({
  kinds: z.array(z.string().min(1)).optional(),
  hint: ArtifactContextRenderHintSchema.optional(),
  depth: z.number().int().min(1).max(20).optional(),
  nested: z.lazy(() => ArtifactContextSelectorSchema).optional(),
  direction: ArtifactContextRelationDirectionSchema.optional(),
});

/** Runtime schema for selector maps keyed by relation type. */
export const ArtifactContextSelectorSchema: z.ZodType<ArtifactContextSelector, ArtifactContextSelector> = z.record(
  z.string().min(1),
  ArtifactContextRelationSelectorSchema,
);
