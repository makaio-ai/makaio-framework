import { z } from 'zod';

import { EvidenceValueSchema } from './evidence.js';

/** Request to resolve one immutable evidence pointer. */
export const EvidenceResolveRequestSchema = z.strictObject({
  evidence: EvidenceValueSchema,
});

const TextEvidenceContentSchema = z.strictObject({
  kind: z.literal('text'),
  text: z.string(),
});

// Keep this tuple exact so adding an evidence source also requires adding its paired resolution response.
const EvidenceSchemas = EvidenceValueSchema.options satisfies readonly [z.ZodObject, z.ZodObject, z.ZodObject];
const [GitFileEvidenceSchema, ConfluencePageEvidenceSchema, ArtifactEvidenceSchema] = EvidenceSchemas;

/** Successful resolution, preserving each source's valid location pairings. */
export const EvidenceResolveResponseSchema = z.union([
  GitFileEvidenceSchema.pick({ source: true, location: true }).extend({ content: TextEvidenceContentSchema }),
  ConfluencePageEvidenceSchema.pick({ source: true, location: true }).extend({ content: TextEvidenceContentSchema }),
  ArtifactEvidenceSchema.pick({ source: true, location: true }).extend({ content: TextEvidenceContentSchema }),
]);

/** Request to resolve one immutable evidence pointer. */
export type EvidenceResolveRequest = z.infer<typeof EvidenceResolveRequestSchema>;

/** Fully resolved evidence content with its actual source and location. */
export type EvidenceResolveResponse = z.infer<typeof EvidenceResolveResponseSchema>;
