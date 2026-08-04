import { z } from 'zod';
import { JsonSchemaRecordSchema } from '../shared/json-value.js';

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

/**
 * Serializable normalized outcome of a single Reaction invocation.
 *
 * A handler that resolves normally maps to `{ success: true }`; a handler
 * that throws maps to `{ success: false }` with a plain error message.
 * Cancellation is cooperative: a handler that resolves despite an abort
 * still yields `{ success: true }` — only dispatches that are already
 * aborted or already past their deadline before handler entry are
 * guaranteed failure outcomes. The outcome intentionally carries no retry,
 * ordering, or durability semantics — every host dispatch is an independent
 * invocation.
 */
export const ReactionOutcomeSchema = z.discriminatedUnion('success', [
  z.object({
    /** The handler completed without throwing. */
    success: z.literal(true),
  }),
  z.object({
    /** The handler threw, or the dispatch was rejected before handler entry. */
    success: z.literal(false),
    /** Normalized failure details. */
    error: z.object({
      /** Human-readable failure message extracted from the thrown value. */
      message: z.string(),
    }),
  }),
]);

/** Serializable normalized outcome of a single Reaction invocation. */
export type ReactionOutcome = z.infer<typeof ReactionOutcomeSchema>;
