/**
 * Body and header preparation for the LiteLLM forwarding branch.
 *
 * Implements the reasoning-mode table from the gateway design: mutates the
 * outgoing JSON body (model rename, thinking field, LiteLLM control params)
 * and replaces authentication headers before the forwarding layer sends the
 * request to the LiteLLM upstream.
 *
 * **Division of responsibility with the forwarding layer:**
 * This module only prepares the body bytes and the logical header set.
 * Hop-by-hop filtering (`connection`, `transfer-encoding`, `host`,
 * `content-length`, etc.) is the forwarding layer's responsibility.
 * See `proxy/forward.ts` and `proxy/headers.ts` for that logic. Keeping these
 * concerns in separate modules lets each be tested and reasoned about
 * independently.
 * @packageDocumentation
 */

import type { LitellmRouteDecision } from './types.js';
import type { ReasoningMode } from '../config.js';

/**
 * Budget-token mapping for the `fixed` reasoning effort levels.
 *
 * Maps the three human-readable effort tiers to the concrete `budget_tokens`
 * value inserted into the `thinking` field. The thresholds mirror LiteLLM's
 * documented reverse mapping from `reasoning_effort` (low / medium / high) to
 * an approximate thinking budget and are validated against the live LiteLLM
 * instance during the smoke test (AC11).
 */
export const EFFORT_BUDGET_TOKENS: Readonly<Record<'low' | 'medium' | 'high', number>> = {
  low: 1024,
  medium: 2048,
  high: 4096,
};

/**
 * Error thrown by {@link parseMessagesBody} when the request body is not a
 * valid JSON object or is missing a non-empty `model` string field.
 */
export class InvalidMessagesBodyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidMessagesBodyError';
  }
}

/**
 * Return value of {@link parseMessagesBody} — the fully-parsed body object
 * and the extracted model string ready for rule matching.
 */
export interface ParsedMessagesBody {
  /** The top-level body as a plain object; all fields intact. */
  parsed: Record<string, unknown>;
  /** The non-empty `model` string extracted from `parsed`. */
  model: string;
}

/**
 * Narrows an `unknown` value to `Record<string, unknown>`.
 * @param value - Value to test.
 * @returns `true` when `value` is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge `"reasoning_effort"` into the body's `allowed_openai_params` field,
 * creating it when absent and deduplicating when the string is already present.
 *
 * Any non-array value of `allowed_openai_params` is replaced by a fresh array
 * containing only `"reasoning_effort"`.
 * @param body - Mutated in place.
 */
function mergeAllowedOpenaiParams(body: Record<string, unknown>): void {
  const existing = body['allowed_openai_params'];
  if (Array.isArray(existing)) {
    if (!existing.includes('reasoning_effort')) {
      body['allowed_openai_params'] = [...existing, 'reasoning_effort'];
    }
  } else {
    body['allowed_openai_params'] = ['reasoning_effort'];
  }
}

/**
 * Apply the configured reasoning-mode mutations to the body in place.
 *
 * | Mode | Mutation |
 * |---|---|
 * | `passthrough` | Adds / merges `allowed_openai_params: ["reasoning_effort"]`. |
 * | `drop` | Removes `thinking` and `output_config.effort` from the body (deletes `output_config` entirely when only `effort` was present), then sets `drop_params: true`. |
 * | `fixed` | Replaces `thinking` with `{ type: "enabled", budget_tokens }` and adds `allowed_openai_params`. |
 * @param body - Mutated in place.
 * @param reasoning - Reasoning-mode configuration from the matched rule.
 */
function applyReasoningMode(body: Record<string, unknown>, reasoning: ReasoningMode): void {
  if (reasoning.mode === 'passthrough') {
    mergeAllowedOpenaiParams(body);
  } else if (reasoning.mode === 'drop') {
    delete body['thinking'];
    if (isRecord(body['output_config'])) {
      // prepareLitellmBody never mutates caller-owned input. `body` is only a
      // shallow copy, so its `output_config` is still the caller's object;
      // deleting from it in place would break that guarantee.
      const outputConfig = { ...body['output_config'] };
      delete outputConfig['effort'];
      if (Object.keys(outputConfig).length === 0) {
        delete body['output_config'];
      } else {
        body['output_config'] = outputConfig;
      }
    }
    body['drop_params'] = true;
  } else {
    // fixed mode: replace thinking with the budget object, then add allowed_openai_params.
    // max_tokens is deliberately left untouched and the budget is not capped against it:
    // the Anthropic API invariant `budget_tokens < max_tokens` does not govern this path.
    // The config schema only admits `fixed` for rules whose targets are all litellm
    // upstreams, and LiteLLM maps budget_tokens to a provider reasoning-effort tier
    // instead of forwarding it to the Anthropic API (verified live: budget 1024 with
    // max_tokens 32 is accepted). Capping at max_tokens - 1 would also fall below
    // Anthropic's own 1024 minimum for small max_tokens, i.e. model the wrong contract.
    body['thinking'] = {
      type: 'enabled',
      budget_tokens: EFFORT_BUDGET_TOKENS[reasoning.effort],
    };
    mergeAllowedOpenaiParams(body);
  }
}

/**
 * Parse and validate the raw bytes of an Anthropic Messages request body.
 *
 * Shared by both forwarding branches to extract the `model` field for rule
 * matching. The returned `parsed` object is used directly as the input to
 * {@link prepareLitellmBody} for the LiteLLM branch; the Anthropic branch
 * forwards the original bytes unchanged.
 * @param bytes - UTF-8 encoded request body bytes.
 * @returns The parsed body and the extracted model string.
 * @throws {@link InvalidMessagesBodyError} When the body is not valid JSON, not
 *   a JSON object, or is missing a non-empty `model` string field.
 */
export function parseMessagesBody(bytes: Uint8Array): ParsedMessagesBody {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InvalidMessagesBodyError('Request body is not valid JSON.');
  }

  if (!isRecord(raw)) {
    throw new InvalidMessagesBodyError('Request body must be a JSON object, not an array or primitive.');
  }

  const model = raw['model'];
  if (typeof model !== 'string' || model.length === 0) {
    throw new InvalidMessagesBodyError('Request body must contain a non-empty "model" string field.');
  }

  return { parsed: raw, model };
}

/**
 * Prepare the outgoing request body for the LiteLLM forwarding branch.
 *
 * Applies the full rule: sets the upstream model, injects the reasoning-mode
 * control fields, and serialises to UTF-8 bytes. Every key not listed below
 * is copied verbatim (same value, same insertion-order position as
 * `JSON.stringify` preserves).
 *
 * Keys that may be modified:
 * - `model` — always set to `decision.upstreamModel`.
 * - `allowed_openai_params` — added or merged for `passthrough` / `fixed` modes.
 * - `drop_params` — set to `true` for the `drop` mode.
 * - `thinking` — removed for `drop` mode; replaced with a fixed budget object for `fixed` mode.
 * - `output_config` — `effort` key removed for `drop` mode; `output_config` itself removed when only `effort` was present.
 *
 * Keys that are never touched: `system`, `messages`, `tools`, `metadata`,
 * `cache_control`, `stream`, `max_tokens`, and all other fields in the body.
 * @param parsed - Already-parsed request body from {@link parseMessagesBody}.
 * @param decision - Resolved routing decision containing the upstream model and
 *   the reasoning-mode configuration from the matched rule.
 * @returns UTF-8 encoded bytes of the mutated JSON body.
 */
export function prepareLitellmBody(
  parsed: Record<string, unknown>,
  decision: LitellmRouteDecision,
): Uint8Array<ArrayBuffer> {
  const body: Record<string, unknown> = { ...parsed, model: decision.upstreamModel };
  applyReasoningMode(body, decision.target.reasoning);
  return new TextEncoder().encode(JSON.stringify(body));
}

/**
 * Prepare the outgoing request headers for the LiteLLM forwarding branch.
 *
 * Expects `incoming` to have already been processed by `filterRequestHeaders`
 * so that all hop-by-hop and `Connection`-nominated headers are absent. This
 * ordering is critical for security: a client-supplied `Connection: authorization`
 * nomination would otherwise cause the forwarding layer to strip the injected
 * master key after this function sets it.
 *
 * Returns a copy of the pre-filtered headers with `authorization` replaced by
 * the resolved master key and `x-api-key` removed.
 * @param incoming - Pre-filtered headers (hop-by-hop and Connection-nominated
 *   names already removed by `filterRequestHeaders` in the caller).
 * @param masterKey - Resolved plaintext master key. Must never be logged.
 * @returns A new {@link Headers} instance with authentication fields replaced.
 */
export function prepareLitellmHeaders(incoming: Headers, masterKey: string): Headers {
  const headers = new Headers(incoming);
  headers.set('authorization', `Bearer ${masterKey}`);
  headers.delete('x-api-key');
  return headers;
}
