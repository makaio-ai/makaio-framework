import { z } from 'zod';
import { ContributionNameSchema } from '@makaio/core';
import { JsonValueSchema } from '../shared/json-value.js';
import { EntryIdSchema } from '../journal/identifiers.js';
import { EventFactsSchema } from './event.js';
import { EvaluationIdSchema, RuleIdSchema } from './identifiers.js';
import { RuleExclusionSchema } from './rule.js';

/** Page size used when a paged `makaio:rules.evaluations` request omits `limit`. */
export const RULES_EVALUATIONS_PAGE_DEFAULT_LIMIT = 50;

/** Largest page size a paged `makaio:rules.evaluations` request may ask for. */
export const RULES_EVALUATIONS_PAGE_MAX_LIMIT = 500;

/**
 * Reference to one rule set, as the host's rule source names it.
 */
export const RuleSetRefSchema = z
  .object({
    /** Identifier of the rule set. */
    id: z.string().min(1),
    /** Digest of the rule set's content; the kernel may cache by this value. */
    digest: z.string().min(1),
  })
  .strict();
/** @see {@link RuleSetRefSchema} */
export type RuleSetRef = z.infer<typeof RuleSetRefSchema>;

/**
 * How one rule stopped another, or several: the stopping rules and the reach
 * of their stop.
 */
export const StoppedBySchema = z
  .object({
    ruleIds: z.array(RuleIdSchema),
    reach: z.enum(['group', 'event']),
  })
  .strict();
/** @see {@link StoppedBySchema} */
export type StoppedBy = z.infer<typeof StoppedBySchema>;

/**
 * View of one group's decision, inside {@link CauseEvaluationView}.
 */
export const GroupEvaluationViewSchema = z
  .object({
    /** Name of the group; `null` means a rule without a group. */
    group: z.string().nullable(),
    /** Strategy that decided the group. */
    strategy: ContributionNameSchema,
    /** Members, descending by priority; the last is the fallback. */
    members: z.array(z.object({ ruleId: RuleIdSchema, priority: z.number().optional() }).strict()),
    /** Members that acted; the winner under `makaio.first-match`. */
    acting: z.array(RuleIdSchema),
    /** Members stopped, with who caused the stop and the reach of the stop. */
    stopped: z.array(
      z.object({ ruleId: RuleIdSchema, by: z.array(RuleIdSchema), reach: z.enum(['group', 'event']) }).strict(),
    ),
    /** Members that did not match. */
    notMatched: z.array(RuleIdSchema),
    /** State of the group's decision. */
    state: z.enum(['pending', 'decided']),
    /** Why the decision is not final yet or failed, for example a transient error or `strategy-invalid`. */
    reason: z.string().optional(),
  })
  .strict();
/** @see {@link GroupEvaluationViewSchema} */
export type GroupEvaluationView = z.infer<typeof GroupEvaluationViewSchema>;

/**
 * View of the occasion an evaluation arose from, with every rule the
 * occasion concerns.
 */
export const CauseEvaluationViewSchema = z
  .object({
    /** Rule set in effect for this occasion. */
    ruleSet: RuleSetRefSchema,
    /** Facts of the occasion. */
    event: EventFactsSchema,
    /** State of the decision over the rules with reach `'event'`. */
    state: z.enum(['pending', 'decided']),
    /** Rules with reach `'event'`: who matched, whom that stopped. */
    eventStops: z
      .object({
        matched: z.array(RuleIdSchema),
        stopped: z.array(RuleIdSchema),
      })
      .strict()
      .optional(),
    /** Every group a rule of this occasion belongs to. */
    groups: z.array(GroupEvaluationViewSchema),
    /** Rules that are not switchable off. */
    mandatory: z.array(RuleIdSchema),
    /** Every exclusion, with who caused it. */
    excluded: z.array(RuleExclusionSchema),
  })
  .strict();
/** @see {@link CauseEvaluationViewSchema} */
export type CauseEvaluationView = z.infer<typeof CauseEvaluationViewSchema>;

/**
 * View of one part of an evaluation: the reaction run for one resolved
 * element of `each`, or the one part of a rule without `each`.
 */
export const EvaluationPartViewSchema = z
  .object({
    /** The resolved element of `each`, when the rule declares one. */
    item: JsonValueSchema.optional(),
    /** Kind of reaction run for this part. */
    reaction: ContributionNameSchema,
    /** Key of the part. */
    key: z.string(),
    /** State of the part. */
    state: z.enum(['pending', 'accepted', 'rejected', 'failed']),
    /** Why the part is pending, rejected or failed. */
    reason: z.string().optional(),
    /** Result the reaction returned, when it declares one. */
    result: JsonValueSchema.optional(),
  })
  .strict();
/** @see {@link EvaluationPartViewSchema} */
export type EvaluationPartView = z.infer<typeof EvaluationPartViewSchema>;

/**
 * Zod schema of the state of one rule's evaluation; shared by
 * {@link EvaluationViewSchema} and the `ruleId` branch of
 * {@link RulesEvaluationsRequestSchema}.
 */
export const EvaluationStateSchema = z.enum(['pending', 'not-matched', 'stopped', 'accepted', 'rejected', 'failed']);
/** @see {@link EvaluationStateSchema} */
export type EvaluationState = z.infer<typeof EvaluationStateSchema>;

const EvaluationViewBaseSchema = z
  .object({
    /** Identifier of the evaluation. */
    evaluationId: EvaluationIdSchema,
    /** Rule this evaluation concerns. */
    ruleId: RuleIdSchema,
    /** Rule set in effect for this occasion. */
    ruleSet: RuleSetRefSchema,
    /** Facts of the occasion. */
    event: EventFactsSchema,
    /** Group the rule belongs to, when it belongs to one. */
    group: z.string().optional(),
    /** Why the evaluation is pending, stopped, rejected or failed. */
    reason: z.string().optional(),
    /** Number of retries so far. */
    retries: z.number().int().min(0),
    /** ISO date-time before which the evaluation is not retried. */
    notBefore: z.iso.datetime({ offset: true }).optional(),
    /** Parts the evaluation ran or will run. */
    parts: z.array(EvaluationPartViewSchema),
  })
  .strict();

/**
 * View of one rule's evaluation on one occasion.
 */
export const EvaluationViewSchema = z.discriminatedUnion('state', [
  EvaluationViewBaseSchema.extend({
    state: z.literal('stopped'),
    /** Who stopped the rule and with what reach, when known. */
    stoppedBy: StoppedBySchema.optional(),
  }),
  EvaluationViewBaseSchema.extend({
    state: EvaluationStateSchema.exclude(['stopped']),
  }),
]);
/** @see {@link EvaluationViewSchema} */
export type EvaluationView = z.infer<typeof EvaluationViewSchema>;

/**
 * Request of `getEvaluations`, at the bus `makaio:rules.evaluations`.
 *
 * With `entryId` or `evaluationId` the core returns the evaluation of the
 * occasion with every evaluation it carries. Only the `ruleId` branch reads
 * in pages, with `limit` and an opaque `cursor`; the order of pages is not a
 * promise of time order.
 */
export const RulesEvaluationsRequestSchema = z.union([
  z.object({ entryId: EntryIdSchema }).strict(),
  z.object({ evaluationId: EvaluationIdSchema }).strict(),
  z
    .object({
      ruleId: RuleIdSchema,
      since: z.iso.datetime({ offset: true }).optional(),
      state: EvaluationStateSchema.optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(RULES_EVALUATIONS_PAGE_MAX_LIMIT)
        .default(RULES_EVALUATIONS_PAGE_DEFAULT_LIMIT),
      cursor: z.string().min(1).optional(),
    })
    .strict(),
]);
/** @see {@link RulesEvaluationsRequestSchema} */
export type RulesEvaluationsRequest = z.input<typeof RulesEvaluationsRequestSchema>;

/**
 * Response of `getEvaluations`.
 */
export const RulesEvaluationsResponseSchema = z
  .object({
    /** View of the occasion, present only for the `entryId` and `evaluationId` branches of the request. */
    cause: CauseEvaluationViewSchema.optional(),
    /** The evaluations the request asked for. */
    evaluations: z.array(EvaluationViewSchema),
    /** Opaque token for the next page; absent on the last page. */
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
/** @see {@link RulesEvaluationsResponseSchema} */
export type RulesEvaluationsResponse = z.infer<typeof RulesEvaluationsResponseSchema>;
