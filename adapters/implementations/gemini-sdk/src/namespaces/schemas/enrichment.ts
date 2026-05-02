import { z } from 'zod';

/**
 * Schema for adapter-enriched event metadata.
 * Added to all events emitted to the bus for context tracking.
 *
 * Two-phase enrichment:
 * - adapterId/adapterName: Always present (session-manager-scoped)
 * - agentId: Conditional (only after handleStartAgent registration)
 */
export const AdapterEnrichmentSchema = z.object({
  agentId: z.string(), // Agent-scoped (after registration)
  adapterId: z.string(), // Session-manager-scoped (always present)
  adapterName: z.string(), // Session-manager-scoped (always present)
});

export type AdapterEnrichment = z.infer<typeof AdapterEnrichmentSchema>;
