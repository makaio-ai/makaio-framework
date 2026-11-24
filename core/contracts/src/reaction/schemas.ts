import { z } from 'zod';
import { JsonSchemaRecordSchema, JsonValueSchema } from '../shared/json-value.js';

/**
 * Serializable descriptor advertising a contributed Reaction.
 *
 * A descriptor is discovery metadata only: it carries the Reaction identity,
 * a human-readable description, and a derived JSON Schema representation of
 * the parameter shape. It can never synthesize or transport the Reaction's
 * executable handler — runtime truth is always the live
 * {@link ReactionDefinition} contributed by the owning extension.
 *
 * The `kind` field is the canonical Reaction identity in the form
 * `<extension-name>.<reaction-name>`. Namespace ownership is enforced by the
 * Reaction registry at contribution time, not by this schema.
 */
export const ReactionDescriptorSchema = z.object({
  /**
   * Canonical Reaction kind: `<extension-name>.<reaction-name>`.
   * Namespace enforcement happens in the Reaction registry.
   */
  kind: z.string().min(1),
  /** Human-readable description of what this Reaction does when invoked. */
  description: z.string().min(1),
  /**
   * Derived JSON Schema representation of the Reaction's parameter shape.
   *
   * Produced from the live Zod `parameterSchema` with the `$schema` dialect
   * marker stripped. Consumers use this for discovery and form rendering;
   * runtime validation always uses the live Zod schema.
   *
   * Validated as a JSON-safe record so the descriptor stays serializable —
   * functions, `bigint`, and other non-JSON values are rejected.
   */
  parameterSchema: JsonSchemaRecordSchema,
});

/** Serializable descriptor advertising a contributed Reaction. */
export type ReactionDescriptor = z.infer<typeof ReactionDescriptorSchema>;

/** Framework-defined Reaction failure codes. Contributed outcomes may use additional codes. */
export const FrameworkReactionFailureCodeSchema = z.enum([
  'unknown-reaction',
  'invalid-parameters',
  'cancelled',
  'handler-failed',
  'outcome-unknown',
]);

/** Machine-readable failure code defined by the framework. */
export type FrameworkReactionFailureCode = z.infer<typeof FrameworkReactionFailureCodeSchema>;

/**
 * Outcome of a single Reaction invocation. There is one `ReactionOutcome`, a
 * discriminator over `state`; the evaluation decides from it whether a part
 * is done, retried, or failed for good.
 *
 * - `'accepted'` — the reaction ran; `result` carries its result, when it declares one.
 * - `'rejected'` — the reaction refused on business grounds, for good; `code` and `reason` say why.
 * - `'failed'` — the part is terminal; `code` and `reason` say why.
 * - `'retry'` — a transient condition; the part stays pending and is retried later.
 *
 * If the dispatch is cancelled or misses its deadline without a handler
 * outcome, a keyed Reaction yields `'retry'`. Evaluation may dispatch it
 * again after restart with the same key. An unkeyed Reaction instead yields
 * `'failed'` with code `'outcome-unknown'` and is never retried automatically.
 * Codes on contributed outcomes are extensible strings.
 */
export const ReactionOutcomeSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('accepted'),
      /** Result of the reaction, when it declares a `resultSchema`. */
      result: JsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal('rejected'),
      /** Stable machine-readable classification of the refusal. */
      code: z.string(),
      /** Human-readable reason for the refusal. */
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      state: z.literal('failed'),
      /** Stable machine-readable classification of the failure. */
      code: z.string(),
      /** Human-readable reason for the failure. */
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      state: z.literal('retry'),
      /** Human-readable reason the invocation is retried. */
      reason: z.string(),
    })
    .strict(),
]);

/** Outcome of a single Reaction invocation. */
export type ReactionOutcome = z.infer<typeof ReactionOutcomeSchema>;
