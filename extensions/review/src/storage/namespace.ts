import { z } from 'zod';
import { createExtensionStorageNamespace } from '@makaio/storage-core';
import '@makaio/storage-drizzle';
import { reviewFindings } from './schema.js';
import { ReviewFindingSchema, FindingTargetSchema, FindingStatusSchema } from '@makaio/contracts';

/**
 * Review extension storage namespace.
 * Provides typed subjects for all review findings storage operations.
 */
export const ReviewStorageNamespace = createExtensionStorageNamespace('review', {
  schemas: {
    'findings.upsert': {
      request: z.object({ finding: ReviewFindingSchema }),
      response: z.object({ id: z.string() }),
    },
    'findings.upsertBatch': {
      request: z.object({ findings: z.array(ReviewFindingSchema) }),
      response: z.object({ upserted: z.number() }),
    },
    'findings.list': {
      request: z.object({
        target: FindingTargetSchema,
        status: FindingStatusSchema.optional(),
      }),
      response: z.object({ findings: z.array(ReviewFindingSchema) }),
    },
    'findings.get': {
      request: z.object({ id: z.string() }),
      response: z.object({ finding: ReviewFindingSchema.nullable() }),
    },
  },
  extensions: {
    drizzle: { reviewFindings },
  },
});

export const ReviewStorageSubjects = ReviewStorageNamespace.subjects;
