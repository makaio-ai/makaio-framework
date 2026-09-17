/**
 * Rule compilation and model routing for the gateway extension.
 *
 * This module is pure and synchronous — it performs no I/O. Compile the
 * routing configuration once at extension startup with {@link compileRules},
 * then call {@link decideRoute} per incoming request to obtain a fully
 * resolved {@link RouteDecision}.
 * @packageDocumentation
 */

import type { GatewayConfig, ReasoningMode } from '../config.js';
import { DEFAULT_REASONING_MODE } from '../config.js';
import type {
  AnthropicRouteDecision,
  AnthropicRouteTarget,
  LitellmRouteDecision,
  LitellmRouteTarget,
  RouteDecision,
  RouteTarget,
} from './types.js';
import { createTargetSelector } from './strategy.js';
import type { TargetSelector } from './strategy.js';

// ---------------------------------------------------------------------------
// Internal types (not exported — callers use CompiledRules opaquely)
// ---------------------------------------------------------------------------

/**
 * @internal One pre-compiled routing entry corresponding to one config rule.
 */
type CompiledEntry = {
  /**
   * Tests `model` against this rule's compiled glob pattern.
   * @param model - Model string from the incoming request body.
   * @returns `true` when the model matches this rule's pattern.
   */
  readonly matcher: (model: string) => boolean;
  /**
   * Selector that picks one target from the candidate list.
   * Created once per entry via {@link createTargetSelector}.
   */
  readonly selector: TargetSelector;
  /**
   * Pre-built target list corresponding to the rule's `to` names.
   * Always non-empty (guaranteed by schema refinement).
   */
  readonly candidates: ReadonlyArray<RouteTarget>;
  /**
   * Optional model override from the rule. Applied as `upstreamModel` when
   * the rule matches; the original requested model is used when undefined.
   */
  readonly ruleModel: string | undefined;
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Pre-compiled routing table produced by {@link compileRules}.
 *
 * Treat this as an opaque handle — obtain it once at extension startup via
 * {@link compileRules} and pass it to {@link decideRoute} for every request.
 * Do not read or construct the internal fields directly.
 */
export interface CompiledRules {
  /**
   * @internal Ordered compiled entries; use {@link decideRoute} to evaluate.
   */
  readonly entries: ReadonlyArray<CompiledEntry>;
  /**
   * @internal Fallback target applied when no entry matches the requested model.
   */
  readonly defaultTarget: RouteTarget;
}

// ---------------------------------------------------------------------------
// Pattern compilation helper
// ---------------------------------------------------------------------------

/**
 * Compiles a rule `match` pattern into a linear-time glob matcher.
 *
 * The only supported metacharacter is `*`, which matches any run of characters
 * including the empty run and line terminators. Every other character is a
 * literal, including all regex metacharacters (`.`, `+`, `?`, `(`, `)`, `[`,
 * `]`, `{`, `}`, `^`, `$`, `|`, `\`). Matching is anchored and case-sensitive,
 * so a pattern without `*` is an exact comparison.
 *
 * **Why not a regex:** translating `*` to `[\s\S]*` makes a pattern such as
 * `a*a*a*…*z` backtrack catastrophically against a long non-matching input,
 * turning an operator-supplied rule into a denial-of-service vector. The
 * two-pointer scan below never backtracks: the anchored prefix and suffix are
 * compared once, and each interior segment is located with a single forward
 * `indexOf` from the current cursor. Taking the leftmost occurrence of every
 * interior segment is optimal — an earlier match never leaves less room for
 * the remaining segments — so greedy scanning is exact, not an approximation.
 * The worst case is O(n·m) in input and pattern length with no exponential term.
 * @param pattern - The `match` field value from a gateway routing rule.
 * @returns A predicate testing one model string against the pattern.
 */
function compileGlobMatcher(pattern: string): (value: string) => boolean {
  const [prefix = '', ...tail] = pattern.split('*');

  // No wildcard at all — the pattern is an exact, case-sensitive comparison.
  if (tail.length === 0) {
    return (value) => value === pattern;
  }

  const suffix = tail[tail.length - 1] ?? '';
  // Interior segments must appear in order between prefix and suffix. Empty
  // segments come from adjacent wildcards (`a**b`) and constrain nothing.
  const interior = tail.slice(0, -1).filter((segment) => segment.length > 0);

  return (value: string): boolean => {
    if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;

    // Interior segments may only occupy the region between the anchored
    // prefix and the anchored suffix.
    let cursor = prefix.length;
    const limit = value.length - suffix.length;
    if (limit < cursor) return false;

    for (const segment of interior) {
      const found = value.indexOf(segment, cursor);
      if (found === -1 || found + segment.length > limit) return false;
      cursor = found + segment.length;
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Target building helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an upstream name to an {@link AnthropicRouteTarget}.
 *
 * When the upstream is configured with `auth`, looks up the resolved API key
 * from `resolvedSecrets`. Throws with a message naming the upstream (never the
 * secret value) when an expected entry is missing.
 * @param name - Upstream name as declared in the `upstreams` config map.
 * @param url - Base URL of the Anthropic upstream.
 * @param authApiKeyRef - The credential reference string, or `undefined` when
 *   the upstream operates in pass-through mode (no `auth` block configured).
 * @param resolvedSecrets - Map of upstream name → resolved plaintext credential.
 * @returns A resolved {@link AnthropicRouteTarget}.
 * @throws When `authApiKeyRef` is defined but `resolvedSecrets` has no entry
 *   for `name`.
 */
function buildAnthropicTarget(
  name: string,
  url: string,
  authApiKeyRef: string | undefined,
  resolvedSecrets: ReadonlyMap<string, string>,
): AnthropicRouteTarget {
  if (authApiKeyRef === undefined) {
    return { kind: 'anthropic', name, url, auth: null };
  }

  const apiKey = resolvedSecrets.get(name);
  if (apiKey === undefined) {
    throw new Error(
      `Anthropic upstream "${name}" is configured with auth.apiKey but its credential was not resolved. ` +
        `Ensure the credential service resolved the ref for upstream "${name}".`,
    );
  }
  return { kind: 'anthropic', name, url, auth: { apiKey } };
}

/**
 * Resolve an upstream name to a {@link LitellmRouteTarget}.
 *
 * Looks up the resolved master key from `resolvedSecrets`. Throws with a
 * message naming the upstream (never the secret value) when the entry is
 * missing.
 * @param name - Upstream name as declared in the `upstreams` config map.
 * @param url - Base URL of the LiteLLM proxy.
 * @param resolvedSecrets - Map of upstream name → resolved plaintext credential.
 * @param reasoning - Reasoning mode to embed in the target.
 * @returns A resolved {@link LitellmRouteTarget}.
 * @throws When `resolvedSecrets` has no entry for `name`.
 */
function buildLitellmTarget(
  name: string,
  url: string,
  resolvedSecrets: ReadonlyMap<string, string>,
  reasoning: ReasoningMode,
): LitellmRouteTarget {
  const masterKey = resolvedSecrets.get(name);
  if (masterKey === undefined) {
    throw new Error(
      `LiteLLM upstream "${name}" requires a master key but its credential was not resolved. ` +
        `Ensure the credential service resolved the ref for upstream "${name}".`,
    );
  }
  return { kind: 'litellm', name, url, masterKey, reasoning };
}

/**
 * Resolve the configured default upstream name to a {@link RouteTarget}.
 *
 * For LiteLLM default upstreams, reasoning defaults to `passthrough` because
 * there is no rule-level reasoning configuration for the fallback path.
 * @param config - Validated gateway configuration.
 * @param resolvedSecrets - Map of upstream name → resolved plaintext credential.
 * @returns The resolved {@link RouteTarget} for the default upstream.
 * @throws When the default upstream config is missing or a required secret
 *   is absent from `resolvedSecrets`.
 */
function buildDefaultTarget(config: GatewayConfig, resolvedSecrets: ReadonlyMap<string, string>): RouteTarget {
  const name = config.default;
  const upstream = config.upstreams[name];
  if (upstream === undefined) {
    // The config refinement ensures this cannot happen; the guard keeps the
    // invariant compiler-verified.
    throw new Error(`Default upstream "${name}" is not defined in the "upstreams" config map.`);
  }

  if (upstream.kind === 'anthropic') {
    return buildAnthropicTarget(name, upstream.url, upstream.auth?.apiKey, resolvedSecrets);
  }

  // upstream.kind === 'litellm' — passthrough is the safe default reasoning mode.
  return buildLitellmTarget(name, upstream.url, resolvedSecrets, DEFAULT_REASONING_MODE);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compiles the gateway routing configuration into an efficient lookup table.
 *
 * Each rule's `match` pattern is compiled to a glob matcher exactly once. Targets are
 * pre-populated by resolving upstream names against `config.upstreams` and
 * looking up each required credential in `resolvedSecrets`. The default target
 * is also built at compile time from `config.default`.
 *
 * Call this once at extension startup and pass the result to
 * {@link decideRoute} for every incoming request.
 * @param config - Validated gateway configuration from {@link parseGatewayConfig}.
 * @param resolvedSecrets - Map of upstream name → resolved plaintext credential.
 *   Must contain an entry for every upstream that requires a credential:
 *   Anthropic upstreams with `auth.apiKey` and all LiteLLM upstreams. A missing
 *   entry throws an error naming the upstream but never the secret value.
 * @returns An opaque compiled routing table for use with {@link decideRoute}.
 * @throws When a required credential entry is missing from `resolvedSecrets`,
 *   naming the upstream but never the secret value.
 */
export function compileRules(config: GatewayConfig, resolvedSecrets: ReadonlyMap<string, string>): CompiledRules {
  const entries: CompiledEntry[] = config.rules.map((rule) => {
    const matcher = compileGlobMatcher(rule.match);
    const selector = createTargetSelector(rule.strategy);

    // Build the candidate target list for this rule.
    const candidates: RouteTarget[] = rule.to.map((name) => {
      const upstream = config.upstreams[name];
      if (upstream === undefined) {
        // Schema refinement ensures this cannot happen at runtime.
        throw new Error(`Upstream "${name}" referenced in a rule is not defined in "upstreams".`);
      }

      if (upstream.kind === 'anthropic') {
        return buildAnthropicTarget(name, upstream.url, upstream.auth?.apiKey, resolvedSecrets);
      }

      // upstream.kind === 'litellm'
      const reasoning = rule.reasoning ?? DEFAULT_REASONING_MODE;
      return buildLitellmTarget(name, upstream.url, resolvedSecrets, reasoning);
    });

    return { matcher, selector, candidates, ruleModel: rule.model };
  });

  const defaultTarget = buildDefaultTarget(config, resolvedSecrets);

  return { entries, defaultTarget };
}

/**
 * Selects the routing decision for an incoming request's model identifier.
 *
 * Rules are evaluated in the order they appear in the original configuration.
 * The first rule whose pattern matches `model` produces the decision. The
 * rule's selector then picks one target from its candidate list. If no rule
 * matches, the request is routed to the default target with `ruleIndex: null`.
 * @param model - The `model` field extracted from the incoming request body.
 * @param compiled - The pre-compiled routing table from {@link compileRules}.
 * @returns A fully resolved {@link RouteDecision} with the selected target,
 *   the matching rule index (or `null` for the default), and the effective
 *   upstream model identifier.
 */
export function decideRoute(model: string, compiled: CompiledRules): RouteDecision {
  for (const [i, entry] of compiled.entries.entries()) {
    if (entry.matcher(model)) {
      const target = entry.selector.select(entry.candidates);
      const upstreamModel = entry.ruleModel ?? model;

      if (target.kind === 'anthropic') {
        const decision: AnthropicRouteDecision = { target, ruleIndex: i, upstreamModel };
        return decision;
      }

      // target.kind === 'litellm'
      const decision: LitellmRouteDecision = { target, ruleIndex: i, upstreamModel };
      return decision;
    }
  }

  // No rule matched — fall back to the default target with ruleIndex: null.
  const defaultTarget = compiled.defaultTarget;
  if (defaultTarget.kind === 'anthropic') {
    const decision: AnthropicRouteDecision = {
      target: defaultTarget,
      ruleIndex: null,
      upstreamModel: model,
    };
    return decision;
  }

  // Default target is LiteLLM. ruleIndex: null signals "no rule matched".
  const decision: LitellmRouteDecision = {
    target: defaultTarget,
    ruleIndex: null,
    upstreamModel: model,
  };
  return decision;
}
