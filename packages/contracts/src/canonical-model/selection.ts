import { z } from 'zod';
import { AgentSelectionBaseSchema } from '../adapter/schemas/agent-resolution.js';

/**
 * Agent selection for `kind: 'canonical-model'`.
 *
 * The `model` field carries the canonical model reference string verbatim.
 * Resolution happens immediately at the `AgentResolutionSubjects.resolve`
 * chokepoint, so this kind never persists into runtime spawn paths.
 */
export const CanonicalModelSelectionSchema = AgentSelectionBaseSchema.safeExtend({
  /** Discriminant for transient canonical-model resolution. */
  kind: z.literal('canonical-model'),
  /** Canonical model string such as `'sonnet'` or `'anthropic::sonnet'`. */
  model: z.string().trim().min(1),
});

export type CanonicalModelSelection = z.infer<typeof CanonicalModelSelectionSchema>;

declare module '@makaio/contracts' {
  interface AgentSelectionKindMap {
    'canonical-model': CanonicalModelSelection;
  }
}
