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

/**
 * Per-relation selector controlling which outbound relations to follow
 * and how to render the resolved context.
 */
export interface ArtifactContextRelationSelector {
  readonly kinds?: readonly string[];
  readonly hint?: ArtifactContextRenderHint;
  readonly depth?: number;
  readonly nested?: ArtifactContextSelector;
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

/** Runtime schema for per-relation selectors. */
export const ArtifactContextRelationSelectorSchema: z.ZodType<
  ArtifactContextRelationSelector,
  ArtifactContextRelationSelector
> = z.object({
  kinds: z.array(z.string().min(1)).optional(),
  hint: ArtifactContextRenderHintSchema.optional(),
  depth: z.number().int().min(1).max(20).optional(),
  nested: z.lazy(() => ArtifactContextSelectorSchema).optional(),
});

/** Runtime schema for selector maps keyed by relation type. */
export const ArtifactContextSelectorSchema: z.ZodType<ArtifactContextSelector, ArtifactContextSelector> = z.record(
  z.string().min(1),
  ArtifactContextRelationSelectorSchema,
);
