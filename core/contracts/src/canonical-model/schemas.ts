import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { AdapterSelectionSchema } from '../adapter/schemas/agent-resolution.js';
import { AgentResolutionContextSchema } from '../agent-resolution/index.js';
import { ResolvableCanonicalModelSchema } from './types.js';

/**
 * Resolved adapter selection produced by framework canonical-model resolution.
 *
 * Canonical-model resolution is intentionally limited to adapter/provider/model
 * routing. Host-only virtual-model expansion happens at the higher-level
 * agent-resolution seam.
 */
// `safeExtend()` is the stock Zod 4 API for object schemas in this repo.
// We use it here to preserve the adapter selection base contract while
// narrowing the resolved kind to the concrete runtime adapter shape.
export const CanonicalModelResolvedSelectionSchema = AdapterSelectionSchema.safeExtend({
  kind: z.literal('adapter'),
  adapterName: z.string(),
  providerConfigId: z.string(),
  model: z.string(),
});

export type CanonicalModelResolvedSelection = z.infer<typeof CanonicalModelResolvedSelectionSchema>;

/**
 * Bus schemas for framework canonical-model resolution.
 *
 * Each key becomes a subject identifier as `canonicalModel.<key>`.
 */
export const CanonicalModelSchemas = {
  resolve: {
    request: z.object({
      /** Pre-parsed framework-resolvable canonical model. */
      parsed: ResolvableCanonicalModelSchema,
      /** Optional resolution context for future framework-owned routing seams. */
      context: AgentResolutionContextSchema.optional(),
    }),
    response: CanonicalModelResolvedSelectionSchema,
  },
} satisfies SchemaRecord;
