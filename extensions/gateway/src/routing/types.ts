/**
 * Pure types for the gateway routing layer.
 *
 * This module contains only TypeScript type definitions — no runtime code.
 * The routing table (`compileRules`, `decideRoute`), strategy layer, and
 * proxy layer import these shared types to stay decoupled from each other's
 * implementation.
 * @packageDocumentation
 */

import type { ReasoningMode } from '../config.js';

/**
 * Resolved target for an Anthropic-branch request.
 *
 * When `auth` is `null`, the gateway forwards the original request bytes and
 * all non-hop-by-hop headers (including `Authorization`, `x-api-key`,
 * `anthropic-beta`, `anthropic-version`) to `url` unchanged — this preserves
 * subscription OAuth tokens end-to-end. When `auth` is non-null, the gateway
 * replaces client credentials: `x-api-key` is set to the resolved key and
 * `authorization` is removed.
 *
 * **Security:** `auth.apiKey` is resolved plaintext. It must never be logged,
 * stored, or included in the `requestRouted` bus event.
 */
export interface AnthropicRouteTarget {
  readonly kind: 'anthropic';
  /** Name of the upstream as declared in the `upstreams` config map. */
  readonly name: string;
  /** Base URL of the Anthropic upstream, e.g. `https://api.anthropic.com`. */
  readonly url: string;
  /**
   * Resolved API-key credential, or `null` when operating in pass-through mode.
   *
   * `null` → forward original client auth intact (subscription OAuth).
   * Non-null → substitute `x-api-key: <apiKey>` and remove `authorization`.
   *
   * **Security:** the resolved key must never be logged.
   */
  readonly auth: { readonly apiKey: string } | null;
}

/**
 * Resolved target for a LiteLLM-branch request.
 *
 * The gateway mutates the request body (model rename, reasoning-mode injection)
 * and replaces authentication headers (sets `Authorization: Bearer <key>`,
 * removes `x-api-key`) before forwarding to `url`.
 *
 * **Security:** `masterKey` is the resolved plaintext credential. It must
 * never be logged, stored, or included in the `requestRouted` bus event.
 * The credential service resolves the credential reference at extension
 * startup; this resolved value is held only in memory for the lifetime of
 * the service.
 */
export interface LitellmRouteTarget {
  readonly kind: 'litellm';
  /** Name of the upstream as declared in the `upstreams` config map. */
  readonly name: string;
  /** Base URL of the LiteLLM proxy, e.g. `http://127.0.0.1:4000`. */
  readonly url: string;
  /**
   * Resolved plaintext master key forwarded as `Authorization: Bearer <key>`.
   * Must never be logged.
   */
  readonly masterKey: string;
  /**
   * Reasoning-mode configuration controlling how `thinking` and related
   * LiteLLM control fields are injected into the outgoing body.
   */
  readonly reasoning: ReasoningMode;
}

/**
 * Discriminated union of the two upstream targets the gateway can select.
 *
 * Use `target.kind` to narrow to {@link AnthropicRouteTarget} or
 * {@link LitellmRouteTarget}.
 */
export type RouteTarget = AnthropicRouteTarget | LitellmRouteTarget;

/**
 * Routing decision that selected the Anthropic upstream.
 *
 * Invariant: `ruleIndex` is `null` when the request fell through to the default
 * target (no rule matched); it is a non-negative integer when an explicit rule
 * matched.
 */
export interface AnthropicRouteDecision {
  /** Resolved Anthropic upstream target. */
  readonly target: AnthropicRouteTarget;
  /**
   * Zero-based index of the matching rule, or `null` when the default
   * (no-rule) target was used.
   */
  readonly ruleIndex: number | null;
  /**
   * Model identifier forwarded to the upstream. Equals the requested model
   * because Anthropic targets do not support model substitution.
   */
  readonly upstreamModel: string;
}

/**
 * Routing decision that selected the LiteLLM upstream.
 *
 * `ruleIndex` is `null` when the LiteLLM upstream is the gateway's configured
 * default and no rule matched. It is a non-negative integer when an explicit
 * rule matched and selected this LiteLLM target.
 */
export interface LitellmRouteDecision {
  /** Resolved LiteLLM upstream target with master key already populated. */
  readonly target: LitellmRouteTarget;
  /**
   * Zero-based index of the rule that matched, or `null` when this upstream
   * is the configured default and no rule matched.
   */
  readonly ruleIndex: number | null;
  /**
   * Model identifier to be sent to the upstream. Equals the requested model
   * when no model substitution was applied; otherwise the rule's `model` value.
   */
  readonly upstreamModel: string;
}

/**
 * Fully resolved routing decision for a single incoming request.
 *
 * Produced by `decideRoute` and consumed by the proxy layer and the
 * `requestRouted` event emitter. Use `decision.target.kind` to narrow to
 * {@link AnthropicRouteDecision} or {@link LitellmRouteDecision}.
 */
export type RouteDecision = AnthropicRouteDecision | LitellmRouteDecision;
