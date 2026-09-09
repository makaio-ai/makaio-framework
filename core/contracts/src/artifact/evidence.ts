import { z } from 'zod';

import { ArtifactRefSchema } from './artifact-reference.js';
import { ArtifactDataPathSchema } from './kind-registration.js';

/** A nonblank identity that remains enforceable after JSON Schema conversion. */
const EvidenceIdentitySchema = z.string().min(1).regex(/\S/);

/** Location covering the complete pinned source. */
const WholeSourceLocationSchema = z.strictObject({
  kind: z.literal('whole-source'),
});

/** A contiguous one-based line range within a pinned Git file. */
const LinesLocationSchema = z.strictObject({
  kind: z.literal('lines'),
  startLine: z.number().int().positive(),
  lineCount: z.number().int().positive(),
});

/** A data-relative path within a pinned artifact revision. */
const ArtifactDataPathLocationSchema = z.strictObject({
  kind: z.literal('data-path'),
  path: ArtifactDataPathSchema,
});

/** A Git file pinned to a complete SHA-1 or SHA-256 object ID. */
const GitFileEvidenceSourceSchema = z.strictObject({
  kind: z.literal('git-file'),
  repository: EvidenceIdentitySchema,
  path: EvidenceIdentitySchema,
  commit: z.string().regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/),
});

/** A Confluence page pinned to a positive page version. */
const ConfluencePageEvidenceSourceSchema = z.strictObject({
  kind: z.literal('confluence-page'),
  site: EvidenceIdentitySchema,
  pageId: EvidenceIdentitySchema,
  version: z.number().int().positive(),
});

/** An immutable artifact revision used as direct evidence. */
const ArtifactEvidenceSourceSchema = z.strictObject({
  kind: z.literal('artifact'),
  reference: ArtifactRefSchema,
});

/**
 * A direct, immutable evidence pointer attached to an artifact revision.
 *
 * Each source variant declares only the location kinds meaningful for that
 * source. The structural union preserves these pairings in generated JSON
 * Schema, without relying on Zod-only refinements.
 */
export const EvidenceValueSchema = z
  .union([
    z.strictObject({
      source: GitFileEvidenceSourceSchema,
      location: z.union([WholeSourceLocationSchema, LinesLocationSchema]),
      excerpt: z.string().optional(),
    }),
    z.strictObject({
      source: ConfluencePageEvidenceSourceSchema,
      location: WholeSourceLocationSchema,
      excerpt: z.string().optional(),
    }),
    z.strictObject({
      source: ArtifactEvidenceSourceSchema,
      location: z.union([WholeSourceLocationSchema, ArtifactDataPathLocationSchema]),
      excerpt: z.string().optional(),
    }),
  ])
  .meta({
    title: 'EvidenceValue',
    description: 'An immutable, directly cited source and its source-specific location.',
  });

/** Direct, immutable evidence pointer attached to an artifact revision. */
export type EvidenceValue = z.infer<typeof EvidenceValueSchema>;
