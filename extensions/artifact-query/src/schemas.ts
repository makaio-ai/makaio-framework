import { z } from 'zod';
import { ArtifactDataPathSchema, ArtifactRefSchema } from '@makaio/contracts';

/** Per-invocation bound for artifact selections; this is not a token or payload-size budget. */
export const MAX_ARTIFACT_READS_PER_REQUEST = 100;
/** Per-selection bound for declared field paths; this is not a token or payload-size budget. */
export const MAX_ARTIFACT_FIELDS_PER_READ = 100;

const ArtifactReadRefSchema = z.strictObject({
  kind: ArtifactRefSchema.shape.kind,
  id: ArtifactRefSchema.shape.id,
  revision: ArtifactRefSchema.shape.revision.optional(),
});

const ArtifactReadSelectorSchema = z
  .strictObject({
    ref: ArtifactReadRefSchema,
    view: z.string().trim().min(1).optional(),
    fields: z.array(ArtifactDataPathSchema).min(1).max(MAX_ARTIFACT_FIELDS_PER_READ).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.view !== undefined && value.fields !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'Specify either view or fields, not both',
      });
    }
  });

/** Input accepted by the selected artifact read tool. */
export const ReadArtifactsInputSchema = z.strictObject({
  purpose: z.string().trim().min(1).describe('One short sentence explaining why these artifacts are needed.'),
  reads: z.array(ArtifactReadSelectorSchema).min(1).max(MAX_ARTIFACT_READS_PER_REQUEST),
});

const ArtifactReadSelectionSchema = z.strictObject({
  mode: z.enum(['view', 'fields', 'full', 'fallback']),
  view: z.string().optional(),
  fields: z.array(ArtifactDataPathSchema),
  omittedAbsentFields: z.array(ArtifactDataPathSchema),
  guidance: z.string().optional(),
});

const ArtifactReadSuccessSchema = z.strictObject({
  ok: z.literal(true),
  ref: ArtifactRefSchema,
  title: z.string(),
  data: z.record(z.string(), z.unknown()),
  selection: ArtifactReadSelectionSchema,
});

const ArtifactReadFailureSchema = z.strictObject({
  ok: z.literal(false),
  ref: ArtifactReadRefSchema,
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

/** Ordered item-level outcomes for one selected artifact read. */
export const ReadArtifactsOutputSchema = z.strictObject({
  results: z.array(z.union([ArtifactReadSuccessSchema, ArtifactReadFailureSchema])),
});

export type ReadArtifactsInput = z.infer<typeof ReadArtifactsInputSchema>;
export type ReadArtifactsOutput = z.infer<typeof ReadArtifactsOutputSchema>;
