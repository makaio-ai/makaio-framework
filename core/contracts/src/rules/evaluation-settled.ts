import { z } from 'zod';
import { EvaluationIdSchema, RuleIdSchema } from './identifiers.js';
import { EventFactsCauseSchema } from './event.js';
import { StoppedBySchema } from './evaluation.js';

const EvaluationSettledBaseSchema = z.strictObject({
  /** Identifier of the settled evaluation. */
  evaluationId: EvaluationIdSchema,
  /** Rule the evaluation concerns. */
  ruleId: RuleIdSchema,
  /** What caused the occasion. */
  cause: EventFactsCauseSchema,
  /** Group the rule belongs to, when it belongs to one. */
  group: z.string().optional(),
  /** Why the evaluation settled this way, when known. */
  reason: z.string().optional(),
});

/**
 * Payload of the volatile hint `makaio:rules.evaluation-settled`, for every
 * final state of an evaluation, including `not-matched` and `stopped`.
 *
 * Without any promise, for observers. No rule names it (`hint-subject`).
 */
export const EvaluationSettledSchema = z.discriminatedUnion('state', [
  EvaluationSettledBaseSchema.extend({
    state: z.literal('stopped'),
    /** Who stopped the rule and with what reach, when known. */
    stoppedBy: StoppedBySchema.optional(),
  }),
  EvaluationSettledBaseSchema.extend({
    state: z.enum(['not-matched', 'accepted', 'rejected', 'failed']),
  }),
]);
/** @see {@link EvaluationSettledSchema} */
export type EvaluationSettled = z.infer<typeof EvaluationSettledSchema>;
