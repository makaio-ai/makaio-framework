/**
 * Configuration schema and types for the gateway extension.
 *
 * The gateway reads this config from the extension config store. Values are
 * supplied either through `packageConfigDefaults` in the runtime config file
 * (`makaio.config.*`) or through the host's extension config store. Upstream
 * URLs must be absolute `http:`/`https:` URLs without credentials, query
 * string, or fragment; credential references follow the standard
 * {@link CredentialRef} format understood by the credential service.
 *
 * The `rules` array has no schema-driven settings form (no array-of-objects
 * widget exists); supply it through one of the two config sources above.
 * @packageDocumentation
 */

import { CredentialRefSchema } from '@makaio/contracts/config';
import { parseExtensionConfig } from '@makaio/contracts/extension';
import { z } from 'zod';

/**
 * Pattern for valid upstream names: ASCII letters, digits, underscores, and
 * hyphens. Applied to both `upstreams` record keys and `default` / `to` values.
 */
const UPSTREAM_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * Schema for an upstream name.
 *
 * Names must be non-empty strings matching `[A-Za-z0-9_-]+`. The same pattern
 * is enforced on `upstreams` record keys, the `default` field, and every entry
 * in each rule's `to` field.
 */
const UpstreamNameSchema = z
  .string()
  .min(1, { message: 'Upstream name must not be empty.' })
  .regex(UPSTREAM_NAME_REGEX, { message: 'Upstream name must match [A-Za-z0-9_-]+.' });

/**
 * Validate an upstream base URL beyond plain URL syntax.
 *
 * An upstream base URL is a proxy target that the gateway appends a path and
 * the client's own query string to. Anything that would silently change the
 * outgoing request is rejected here rather than at forward time:
 *
 * - a non-`http:`/`https:` protocol cannot be proxied by `fetch`;
 * - embedded `user:password` credentials would leak into the upstream request
 *   and bypass the configured `auth` / `masterKey` seam;
 * - a query string would be dropped, because the client's own query string is
 *   the one appended when the upstream URL is built;
 * - a fragment is never transmitted and can only mislead the operator.
 *
 * A path prefix is allowed, so `http://127.0.0.1:4000/api` is a valid base.
 * @param value - Raw URL string from the upstream config entry.
 * @param ctx - Zod refinement context used to report every violation found.
 */
function refineUpstreamUrl(value: string, ctx: z.RefinementCtx): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Upstream URL must be an absolute URL.' });
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: 'Upstream URL must use the http or https protocol.' });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    ctx.addIssue({ code: 'custom', message: 'Upstream URL must not contain a username or password.' });
  }
  // Check the raw string rather than parsed.search/hash so that a trailing
  // `?` or `#` (which URL-parses to an empty search/hash string) is still
  // caught. A client query string is appended when the upstream URL is built,
  // so even an empty marker would silently alter the outgoing request.
  if (value.includes('?')) {
    ctx.addIssue({ code: 'custom', message: 'Upstream URL must not contain a query string.' });
  }
  if (value.includes('#')) {
    ctx.addIssue({ code: 'custom', message: 'Upstream URL must not contain a fragment.' });
  }
}

/**
 * Schema for an upstream base URL.
 *
 * Accepts an absolute `http:`/`https:` URL with an optional path prefix and
 * rejects embedded credentials, query strings, and fragments — see
 * {@link refineUpstreamUrl} for the rationale behind each rejection.
 *
 * Leading and trailing ASCII whitespace is stripped before validation so that
 * values supplied through environment-sourced config files are not silently
 * broken by editors or shell expansions that add surrounding spaces.
 */
const UpstreamUrlSchema = z.string().trim().url().superRefine(refineUpstreamUrl);

/**
 * Reasoning-mode configuration for a LiteLLM-targeted rule.
 *
 * Controls how the gateway modifies the `thinking` parameter and related
 * LiteLLM control fields before forwarding a request.
 *
 * | Mode | Effect on the outgoing body |
 * |---|---|
 * | `passthrough` | Adds `allowed_openai_params: ["reasoning_effort"]`; forwards `thinking` as sent. |
 * | `drop` | Removes `thinking` and `output_config.effort` from the outgoing body (removes `output_config` entirely when only `effort` was present), then adds `drop_params: true`. |
 * | `fixed` | Replaces `thinking` with `{ type: "enabled", budget_tokens }` mapped from `effort` (low→1024, medium→2048, high→4096) and adds `allowed_openai_params`. |
 */
export const ReasoningModeSchema = z.discriminatedUnion('mode', [
  /**
   * Pass the `thinking` parameter through unchanged and add
   * `allowed_openai_params: ["reasoning_effort"]` so LiteLLM allows the field.
   * This is the safest default for models that support thinking natively.
   */
  z.object({ mode: z.literal('passthrough') }).strict(),

  /**
   * Strip the thinking controls before forwarding: `thinking` and
   * `output_config.effort` are removed from the outgoing body (and
   * `output_config` with them when `effort` was its only key), then
   * `drop_params: true` is set so LiteLLM discards anything else it does not
   * recognise. Use when the upstream model does not support thinking at all.
   */
  z.object({ mode: z.literal('drop') }).strict(),

  /**
   * Override the `thinking` field with a fixed budget and add
   * `allowed_openai_params`. Useful when Claude Code sends
   * `thinking: { type: "adaptive" }` but the upstream model needs an explicit
   * token budget.
   * Low/medium/high map to 1024/2048/4096 tokens respectively.
   */
  z
    .object({
      mode: z.literal('fixed'),
      /** Budget level — maps to a concrete `budget_tokens` value. */
      effort: z.enum(['low', 'medium', 'high']),
    })
    .strict(),
]);

/** Inferred TypeScript type for a reasoning-mode configuration. */
export type ReasoningMode = z.infer<typeof ReasoningModeSchema>;

/** Default reasoning mode applied when a LiteLLM-targeted rule omits `reasoning`. */
export const DEFAULT_REASONING_MODE: ReasoningMode = { mode: 'passthrough' };

/**
 * Schema for the target-selection strategy on a routing rule.
 *
 * The strategy controls which upstream is chosen when `to` lists multiple
 * candidates. Currently only `static` (first candidate) is implemented;
 * `round-robin` and other strategies are seam-safe additions that require only
 * a new union member and a new selector implementation.
 */
export const StrategySchema = z
  .discriminatedUnion('kind', [
    /**
     * Always select the first upstream listed in `to`.
     *
     * When `to` contains a single name, `static` is equivalent to unconditional
     * selection.
     */
    z.object({ kind: z.literal('static') }).strict(),
  ])
  .default({ kind: 'static' });

/** Inferred TypeScript type for a target-selection strategy configuration. */
export type StrategyConfig = z.infer<typeof StrategySchema>;

/**
 * Schema for an Anthropic-kind upstream.
 *
 * Without `auth`, the gateway forwards the client's own credentials byte-exact
 * (subscription OAuth). With `auth`, the gateway replaces client auth: sets
 * `x-api-key` to the resolved key and removes the `authorization` header.
 */
export const AnthropicUpstreamSchema = z
  .object({
    /**
     * Discriminator selecting the Anthropic upstream kind. The original body is
     * forwarded byte-exact; headers are forwarded except hop-by-hop headers,
     * `host`, and `content-length`.
     */
    kind: z.literal('anthropic'),
    /**
     * Base URL of the Anthropic API. Defaults to `https://api.anthropic.com`.
     * Override to point at an Anthropic-compatible proxy or staging environment.
     */
    url: UpstreamUrlSchema.default('https://api.anthropic.com'),
    /**
     * Optional API-key authentication override.
     *
     * When present, the gateway substitutes client credentials: `x-api-key` is
     * set to the resolved key and `authorization` is removed from the outgoing
     * request. When omitted, the client's own credentials are forwarded intact,
     * preserving subscription OAuth tokens end-to-end.
     *
     * **Security:** the resolved key is held only in memory and is never logged.
     */
    auth: z
      .object({
        /**
         * Credential reference for the Anthropic API key.
         * Resolved at gateway startup; never stored as plaintext.
         * Supported formats: `env:VAR`, `file:/path`, `keychain:svc:acct`, `stored:...`.
         */
        apiKey: CredentialRefSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Schema for a LiteLLM-kind upstream.
 *
 * The gateway replaces authentication headers (`Authorization: Bearer <key>`,
 * removes `x-api-key`), optionally renames the model, and injects
 * reasoning-control fields before forwarding to `url`.
 */
export const LitellmUpstreamSchema = z
  .object({
    /**
     * Discriminator selecting the LiteLLM upstream kind. The gateway mutates
     * the request body and authentication headers before forwarding.
     */
    kind: z.literal('litellm'),
    /**
     * Base URL of the LiteLLM proxy, e.g. `http://127.0.0.1:4000`.
     * The gateway appends `/v1/messages` or `/v1/messages/count_tokens` when
     * forwarding requests.
     */
    url: UpstreamUrlSchema,
    /**
     * Credential reference for the LiteLLM master key.
     *
     * Resolved at gateway startup via the credential service. Supported formats:
     * - `env:LITELLM_MASTER_KEY` — environment variable
     * - `file:/path/to/key` — file contents
     * - `keychain:<service>:<account>` — OS keychain
     * - `stored:providerConfig:<configId>:<key>` — credential store
     */
    masterKey: CredentialRefSchema,
  })
  .strict();

/** Discriminated union of the two supported upstream kinds. */
const UpstreamConfigSchema = z.discriminatedUnion('kind', [AnthropicUpstreamSchema, LitellmUpstreamSchema]);

/** Inferred TypeScript type for an Anthropic upstream configuration. */
export type AnthropicUpstreamConfig = z.infer<typeof AnthropicUpstreamSchema>;

/** Inferred TypeScript type for a LiteLLM upstream configuration. */
export type LitellmUpstreamConfig = z.infer<typeof LitellmUpstreamSchema>;

/** Inferred TypeScript type for any upstream configuration. */
export type UpstreamConfig = z.infer<typeof UpstreamConfigSchema>;

/**
 * Schema for a single routing rule.
 *
 * Rules are evaluated in order; the first match wins. If no rule matches, the
 * request is forwarded to the upstream named by `default`. The `match` field
 * accepts an exact model identifier (e.g. `claude-opus-4-5`) or a glob pattern
 * where `*` is the only supported metacharacter (e.g. `deepseek-*`). All other
 * characters are treated as literals.
 *
 * The `model` and `reasoning` fields are valid only when every upstream
 * referenced by `to` has `kind: "litellm"`. This is enforced by a top-level
 * config refinement rather than the rule schema because the check requires
 * knowledge of the full `upstreams` record.
 */
export const GatewayRuleSchema = z
  .object({
    /**
     * Model identifier or glob to match against the request body `model` field.
     * The only supported glob metacharacter is `*`. An empty string is rejected.
     */
    match: z.string().min(1, { message: 'Rule match must be a non-empty string.' }),
    /**
     * Name or non-empty list of upstream names to route matching requests to.
     *
     * A single string routes to one upstream. A non-empty array provides multiple
     * candidates; which candidate is selected depends on `strategy`. Every name
     * must be defined in the `upstreams` record (validated by a top-level config
     * refinement). Always resolved to an array after parsing.
     */
    to: z
      .union([UpstreamNameSchema, z.array(UpstreamNameSchema).min(1)])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    /**
     * Target-selection strategy when `to` provides multiple candidates.
     *
     * Defaults to `{ kind: "static" }`, which always selects the first candidate.
     * Round-robin and other strategies are planned as future additions.
     */
    strategy: StrategySchema,
    /**
     * Upstream model name to substitute in the forwarded body.
     *
     * When omitted, the original model string is preserved. Valid only when all
     * upstreams referenced by `to` have `kind: "litellm"`.
     */
    model: z.string().min(1).optional(),
    /**
     * Controls how the gateway handles the `thinking` parameter and related
     * LiteLLM control fields. Valid only when all upstreams referenced by `to`
     * have `kind: "litellm"`. When omitted for LiteLLM targets, `passthrough`
     * is applied at compile time.
     */
    reasoning: ReasoningModeSchema.optional(),
  })
  .strict();

/** Inferred TypeScript type for a single routing rule. */
export type GatewayRule = z.infer<typeof GatewayRuleSchema>;

/**
 * Top-level configuration schema for the gateway extension.
 *
 * A valid config always requires at least the upstream named by `default`
 * to be present in `upstreams`; an empty `upstreams` map fails the refinement.
 */
export const GatewayConfigSchema = z
  .object({
    /**
     * Named upstream map.
     *
     * Keys must match `[A-Za-z0-9_-]+`. Each value is a discriminated upstream
     * config (`kind: "anthropic"` or `kind: "litellm"`). The map must contain
     * at least the upstream identified by `default`.
     */
    upstreams: z.record(UpstreamNameSchema, UpstreamConfigSchema).default({}),
    /**
     * Name of the upstream used when no rule matches a request.
     *
     * Defaults to `"anthropic"`. Must be a key present in `upstreams`. A
     * `litellm` upstream is valid here when all unmatched traffic should be
     * routed through LiteLLM.
     */
    default: UpstreamNameSchema.default('anthropic'),
    /**
     * Ordered list of routing rules.
     *
     * Rules are evaluated in declaration order; the first match wins. Requests
     * that match no rule are forwarded to the upstream named by `default`. An
     * empty list routes all requests to the default upstream.
     */
    rules: z.array(GatewayRuleSchema).default([]),
    /**
     * Optional credential reference for the gateway's own access token.
     *
     * The gateway is a credential-injecting proxy: it can replace client
     * authentication with a gateway-owned Anthropic key or LiteLLM master key.
     * The host's bus HMAC protects only the bus WebSocket, so as soon as the
     * host listens on a non-loopback address (`makaio serve --lan-bind`, or a
     * non-loopback `--host`) the HTTP graph — and therefore this sub-app — is
     * reachable by anything on the network.
     *
     * When this field is set, every request under the gateway prefix must carry
     * an `x-gateway-token` header equal to the resolved value; anything else is
     * rejected with 401 before routing, so no `requestRouted` event is emitted.
     * The header is stripped before the request is forwarded upstream.
     *
     * When omitted, the gateway performs no authentication of its own and must
     * only be exposed on loopback.
     *
     * Unlike upstream secrets, this reference is always resolved when present —
     * the "referenced upstream" pruning does not apply to it.
     */
    accessToken: CredentialRefSchema.optional(),
    /**
     * Maximum accepted request body size in bytes.
     *
     * Requests are buffered in memory before routing, so an unbounded body is a
     * memory-exhaustion vector. A request is rejected with 413 when its declared
     * `content-length` exceeds this value, or when the streamed body exceeds it
     * while being read. Neither rejection emits a `requestRouted` event, because
     * the request never reached a routing decision.
     *
     * Defaults to 64 MiB: Claude Code prompts carrying a large context window
     * routinely exceed several MiB, so a smaller cap would reject valid traffic.
     */
    maxBodyBytes: z
      .number()
      .int()
      .positive({ message: 'maxBodyBytes must be a positive integer.' })
      .default(64 * 1024 * 1024),
  })
  .strict()
  .superRefine((config, ctx) => {
    // Use own-key semantics so reserved names like "constructor" or "__proto__"
    // are rejected instead of matching an inherited property.
    if (!Object.hasOwn(config.upstreams, config.default)) {
      ctx.addIssue({
        code: 'custom',
        message: `Default upstream "${config.default}" is not defined in "upstreams". Add a "${config.default}" entry to the "upstreams" map.`,
      });
    }
  })
  .superRefine((config, ctx) => {
    for (const [ruleIndex, rule] of config.rules.entries()) {
      // Guard: `to` may not be an array when the rule's `to` field failed to
      // parse (e.g. the name failed UpstreamNameSchema). Skip so the
      // refinement does not throw a TypeError on a partially-valid shape.
      if (!Array.isArray(rule.to)) continue;
      for (const name of rule.to) {
        if (!Object.hasOwn(config.upstreams, name)) {
          ctx.addIssue({
            code: 'custom',
            message: `Rule at index ${ruleIndex} references upstream "${name}" which is not defined in "upstreams".`,
          });
        }
      }
    }
  })
  .superRefine((config, ctx) => {
    for (const [ruleIndex, rule] of config.rules.entries()) {
      // Guard: skip partially-valid rules where `to` did not transform to an array.
      if (!Array.isArray(rule.to)) continue;
      if (rule.model === undefined && rule.reasoning === undefined) continue;
      const allLitellm = rule.to.every(
        (name) => Object.hasOwn(config.upstreams, name) && config.upstreams[name]?.kind === 'litellm',
      );
      if (!allLitellm) {
        ctx.addIssue({
          code: 'custom',
          message: `Rule at index ${ruleIndex}: "model" and "reasoning" are only valid when every upstream referenced by "to" has kind "litellm".`,
        });
      }
    }
  })
  .superRefine((config, ctx) => {
    for (const [ruleIndex, rule] of config.rules.entries()) {
      // Guard: skip partially-valid rules where `to` did not transform to an array.
      if (!Array.isArray(rule.to)) continue;
      const seen = new Set<string>();
      for (const name of rule.to) {
        if (seen.has(name)) {
          ctx.addIssue({
            code: 'custom',
            message: `Rule at index ${ruleIndex} has duplicate upstream "${name}" in the "to" list.`,
          });
        }
        seen.add(name);
      }
    }
  });

/** Inferred TypeScript type for the fully-resolved gateway configuration. */
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/**
 * Parse and validate raw extension config, applying schema defaults.
 *
 * Wraps {@link parseExtensionConfig} with the {@link GatewayConfigSchema}.
 * Parsing `undefined` (no stored config) applies defaults but then fails the
 * default-upstream refinement — a valid gateway config always requires at
 * least one explicitly defined upstream in `upstreams`.
 * @param raw - Raw config value from `ExtensionContext.config` (may be undefined).
 * @returns Validated and defaulted gateway config.
 * @throws When `raw` does not conform to {@link GatewayConfigSchema}.
 */
export function parseGatewayConfig(raw: unknown): GatewayConfig {
  return parseExtensionConfig(GatewayConfigSchema, raw);
}
