import { z } from 'zod';
import { EvaluationIdSchema } from './identifiers.js';

/**
 * Request to set a failed evaluation, with its failed parts, back to pending.
 *
 * At the bus `makaio:rules.reprocess`. A decision already recorded — over the
 * rules with reach `'event'`, a group, or a rule — is never evaluated against
 * the rules again; reprocessing never makes a stopped or non-matching rule
 * act.
 */
export const RulesReprocessRequestSchema = z
  .object({
    /** The failed evaluation to reset. */
    evaluationId: EvaluationIdSchema,
  })
  .strict();
/** @see {@link RulesReprocessRequestSchema} */
export type RulesReprocessRequest = z.infer<typeof RulesReprocessRequestSchema>;

/**
 * Outcome of a `makaio:rules.reprocess` request.
 */
export const RulesReprocessResponseSchema = z.discriminatedUnion('success', [
  z
    .object({
      success: z.literal(true),
      /** The evaluation and its failed parts were set back to pending. */
      status: z.literal('requeued'),
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      /** `not-found`: no such evaluation. `not-failed`: the evaluation is not failed. */
      code: z.enum(['not-found', 'not-failed']),
    })
    .strict(),
]);
/** @see {@link RulesReprocessResponseSchema} */
export type RulesReprocessResponse = z.infer<typeof RulesReprocessResponseSchema>;
