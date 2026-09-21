/**
 * Zod schemas for the gateway extension public contract.
 *
 * All schemas use `.strict()` to reject unrecognised fields at runtime.
 * Import types from the same file or from `./namespace.ts` when only
 * type-level access is required.
 * @packageDocumentation
 */

import { z } from 'zod';

/**
 * Outcome classification for a routed request.
 *
 * - `completed` — the upstream returned an HTTP response (status is non-null).
 * - `aborted` — the client disconnected before the upstream responded (status is null).
 * - `upstream-unreachable` — a network or DNS error prevented the upstream
 *   connection (status is null).
 */
export const RequestOutcomeSchema = z.enum(['completed', 'aborted', 'upstream-unreachable']);

/** Inferred TypeScript type for a request outcome. */
export type RequestOutcome = z.infer<typeof RequestOutcomeSchema>;

/**
 * Shared fields present in every `requestRouted` event variant.
 *
 * Not exported directly — consumers import {@link RequestRoutedEventSchema} and
 * its inferred type instead.
 */
const RequestRoutedEventBaseSchema = z.object({
  /**
   * Name of the upstream that handled the request, as declared in the
   * `upstreams` config map (e.g. `"anthropic"`, `"anthropic-work"`,
   * `"litellm"`). Useful for telemetry when multiple named upstreams of the
   * same kind exist.
   */
  upstream: z.string(),

  /**
   * Anthropic Messages API path that was requested.
   * Always one of the two routed endpoints.
   */
  path: z.enum(['/v1/messages', '/v1/messages/count_tokens']),

  /**
   * Model identifier extracted from the incoming request body.
   * This is the value Claude Code sent — it may differ from `upstreamModel`
   * when a rule applies a model substitution.
   */
  requestedModel: z.string(),

  /**
   * Model identifier forwarded to the upstream.
   * Equals `requestedModel` when no model substitution was applied.
   */
  upstreamModel: z.string(),

  /**
   * Outcome of the routed request.
   *
   * `status` is non-null exactly when `outcome` is `"completed"`. For
   * `"aborted"` and `"upstream-unreachable"`, no HTTP status code is available
   * and `status` is `null`.
   */
  outcome: RequestOutcomeSchema,

  /**
   * HTTP status code returned by the upstream, or `null` when the request did
   * not complete (outcome is `"aborted"` or `"upstream-unreachable"`).
   * When non-null, always a valid HTTP status in the range 100–599.
   */
  status: z.number().int().min(100).max(599).nullable(),

  /**
   * Wall-clock duration from when the request body is fully read into memory
   * to when the upstream response headers arrive, in milliseconds.
   * Always non-negative.
   */
  durationMs: z.number().nonnegative(),

  /**
   * Whether the upstream response was streamed as Server-Sent Events.
   * Derived from the presence of `stream: true` in the request body.
   */
  streamed: z.boolean(),
});

/**
 * Anthropic-branch variant of the routed-request event.
 *
 * `ruleIndex` is the zero-based index of the matching rule, or `null` when the
 * request fell through to the default Anthropic target (no rule matched).
 */
const AnthropicRequestRoutedEventSchema = RequestRoutedEventBaseSchema.extend({
  /** Discriminator identifying the Anthropic upstream branch. */
  target: z.literal('anthropic'),
  /**
   * Zero-based index of the rule that matched, or `null` when the request
   * used the default Anthropic target because no rule matched.
   */
  ruleIndex: z.number().int().nonnegative().nullable(),
}).strict();

/**
 * LiteLLM-branch variant of the routed-request event.
 *
 * `ruleIndex` is the zero-based index of the rule that matched, or `null` when
 * the LiteLLM upstream is the gateway's configured default and no rule matched.
 */
const LitellmRequestRoutedEventSchema = RequestRoutedEventBaseSchema.extend({
  /** Discriminator identifying the LiteLLM upstream branch. */
  target: z.literal('litellm'),
  /**
   * Zero-based index of the rule that matched, or `null` when the LiteLLM
   * upstream is the configured default and no rule matched.
   */
  ruleIndex: z.number().int().nonnegative().nullable(),
}).strict();

/**
 * Schema for the event emitted after every routed request.
 *
 * One event is published per request, regardless of outcome. Consumers can
 * subscribe to `GatewaySubjects.requestRouted` on the bus to collect routing
 * telemetry without coupling to the gateway implementation.
 *
 * The schema is a discriminated union on `target` that enforces the invariant:
 * - `status` is non-null exactly when `outcome` is `"completed"`; it is `null`
 *   for `"aborted"` and `"upstream-unreachable"` outcomes.
 * - `ruleIndex` is `null` when no rule matched (default route); non-null when
 *   a rule matched, for both anthropic and litellm targets.
 */
export const RequestRoutedEventSchema = z
  .discriminatedUnion('target', [AnthropicRequestRoutedEventSchema, LitellmRequestRoutedEventSchema])
  .refine((event) => (event.outcome === 'completed') === (event.status !== null), {
    message:
      'status must be non-null when outcome is "completed" and null when outcome is "aborted" or "upstream-unreachable".',
  });

/** Inferred TypeScript type for a routed-request event payload. */
export type RequestRoutedEvent = z.infer<typeof RequestRoutedEventSchema>;
