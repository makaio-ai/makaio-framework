/**
 * Claude Code hook response composer.
 *
 * One terminal `hook.handle` composer covering every request-capable Claude
 * Code event.  Which events those are is declared in the client definition and
 * proven by the fixture manifest; `PreToolUse` and `SessionStart` are
 * request-capable today.  Observer-only events bypass this composer entirely —
 * they remain on the `hook.received` pathway with no response.
 *
 * ## Composition pipeline
 *
 * 1. **Snapshot** — query the hook response registry for contributors that
 *    match the current event and its response capabilities.
 * 2. **Collect** — run all matched contributors concurrently via
 *    {@link collectContributions}, respecting deadlines and failure policies.
 * 3. **Reduce** — merge collected effects into a single native response:
 *    - Deny takes precedence over approve (restrictive wins).
 *    - Multiple `context.append` values are concatenated.
 *    - Reasons from multiple contributors are joined with `'; '`.
 * 4. **Closed failure** — when a closed-policy contributor fails on a
 *    block-capable interaction (PreToolUse), the response converts to a
 *    deny with the failure detail.
 * 5. **No-op** — when no effects remain after reduction, return the
 *    immediate provider-valid no-op (exitCode 0, empty stdout/stderr).
 *
 * ## Native output format
 *
 * Native output is JSON on stdout. `PreToolUse` carries a permission decision:
 * ```json
 * {
 *   "hookSpecificOutput": {
 *     "hookEventName": "PreToolUse",
 *     "permissionDecision": "allow" | "deny",
 *     "permissionDecisionReason": "optional reason"
 *   }
 * }
 * ```
 *
 * Events with no decision to make carry appended context alone:
 * ```json
 * {
 *   "hookSpecificOutput": {
 *     "hookEventName": "SessionStart",
 *     "additionalContext": "..."
 *   }
 * }
 * ```
 * @packageDocumentation
 */

import type { CanonicalEffect, ProviderContributionEnvelope } from '@makaio/contracts/client';
import { CANONICAL_HOOK_RESPONSE_CAPABILITIES } from '@makaio/contracts/client';
import type { ClientHookHandleResponse, RawClientHookPayload } from '@makaio/subsystem-client';
import type { ClientHookResponseRegistry } from '@makaio/subsystem-client';
import {
  collectContributions,
  type CollectionDiagnostic,
  type CollectionResult,
  pickNonEmptyString,
} from '@makaio/subsystem-client';
import { NOOP_HOOK_HANDLE_RESPONSE } from '@makaio/subsystem-client';
import {
  CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
  claudeCodeToolResponseContract,
  rendersDecision,
  type ClaudeCodePreToolUseEffects,
  type ClaudeCodeToolDecision,
} from './hook-response-contracts.js';
import { clientDefinition } from '../definition.js';
import { CLAUDE_CODE_HOOK_SUBAGENT_START } from './schemas.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * No-op response alias for readability within this module.
 *
 * Points to the shared frozen constant from `@makaio/subsystem-client`.
 */
const NOOP_RESPONSE = NOOP_HOOK_HANDLE_RESPONSE;

// ---------------------------------------------------------------------------
// Response capabilities lookup
// ---------------------------------------------------------------------------

/**
 * Resolve the response capabilities for a given hook event name.
 *
 * Reads from the static client definition's `hookEvents` array.  Returns an
 * empty array for events without declared response capabilities (observer-
 * only or unobserved events).
 * @param eventName - Claude Code hook event name (e.g. `'PreToolUse'`).
 * @returns Array of response capability strings for the event.
 */
function resolveEventCapabilities(eventName: string): readonly string[] {
  const hookEvents = clientDefinition.runtimeCapabilities?.hookEvents;
  if (!hookEvents) return [];

  for (const decl of hookEvents) {
    if (decl.name === eventName) {
      return decl.responseCapabilities ?? [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Effect reduction
// ---------------------------------------------------------------------------

/**
 * Intermediate result of reducing collected effects into a native response.
 */
interface ReducedEffects {
  /** The winning tool decision, if any contributor produced one. */
  readonly decision: ClaudeCodeToolDecision | undefined;
  /** Concatenated reason string from all contributors. */
  readonly reason: string | undefined;
  /** Concatenated context.append values. */
  readonly appendedContext: string | undefined;
  /**
   * Session correlation token from the highest-priority contributor that
   * produced a `session.token` canonical effect, if any.
   *
   * When multiple contributors deliver a token, the first effect in the
   * flat effects array wins. Effects are assembled from collection outcomes
   * in priority order (highest first), so the first `session.token` effect
   * belongs to the highest-priority contributor — the same ordering strategy
   * used for `appendedContext` concatenation.
   *
   * This bucket is never written to stdout. `buildResponseFromEffects` ignores
   * it; the composer reads it separately and forwards it to `onSessionToken`
   * when the hook event declares the `session.token` response capability.
   */
  readonly sessionToken: string | undefined;
}

/**
 * Reduce a flat array of effects from all successful contributors into a
 * single merged result.
 *
 * Rules:
 * - Deny takes precedence over approve (restrictive wins).
 * - Multiple context.append values are concatenated with newlines.
 * - Reasons from all contributors are concatenated with `'; '`.
 * @param effects - Flat array of canonical effects and provider envelopes.
 * @returns Reduced effects ready for serialization.
 */
function reduceEffects(effects: ReadonlyArray<CanonicalEffect | ProviderContributionEnvelope>): ReducedEffects {
  let decision: ClaudeCodeToolDecision | undefined;
  const reasons: string[] = [];
  const appendParts: string[] = [];
  let sessionToken: string | undefined;
  let hasAllow = false;
  let hasDeny = false;

  for (const effect of effects) {
    if ('kind' in effect) {
      if (effect.kind === 'context.append') {
        // Canonical context.append effect
        appendParts.push(effect.value);
        continue;
      }
      if (effect.kind === 'session.token') {
        // Canonical session.token effect — first wins (highest-priority
        // contributor, since outcomes are ordered highest-priority first).
        sessionToken ??= effect.value;
        continue;
      }
    }

    // Provider contribution envelope
    const envelope = effect as ProviderContributionEnvelope<ClaudeCodePreToolUseEffects>;
    if (envelope.clientId !== 'claude-code' || envelope.contractId !== CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID) {
      continue;
    }

    const envEffects = envelope.effects;
    if (envEffects.decision === 'allow') {
      hasAllow = true;
    } else if (envEffects.decision === 'deny') {
      hasDeny = true;
    }
    if (envEffects.reason) {
      reasons.push(envEffects.reason);
    }
  }

  if (hasAllow && hasDeny) {
    // Restrictive precedence: deny wins over allow
    decision = 'deny';
  } else if (hasDeny) {
    decision = 'deny';
  } else if (hasAllow) {
    decision = 'allow';
  }

  return {
    decision,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    appendedContext: appendParts.length > 0 ? appendParts.join('\n') : undefined,
    sessionToken,
  };
}

// ---------------------------------------------------------------------------
// Native output serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a permission decision into the native Claude Code output format.
 * @param eventName - Native Claude Code hook event the decision belongs to.
 * @param decision - The resolved tool decision.
 * @param reason - Optional reason string.
 * @param additionalContext - Context appended before the tool executes.
 * @returns JSON string for the native Claude Code hook output.
 */
function serializeDecisionOutput(
  eventName: string,
  decision: ClaudeCodeToolDecision,
  reason: string | undefined,
  additionalContext: string | undefined,
): string {
  const hookSpecificOutput: Record<string, string> = {
    hookEventName: eventName,
    permissionDecision: decision,
  };

  if (reason !== undefined) {
    hookSpecificOutput['permissionDecisionReason'] = reason;
  }
  if (additionalContext !== undefined) {
    hookSpecificOutput['additionalContext'] = additionalContext;
  }

  return JSON.stringify({ hookSpecificOutput });
}

/**
 * Serialize appended context for an event that carries no permission decision.
 *
 * Claude Code's documented shape for context contribution outside PreToolUse is
 * `hookSpecificOutput.additionalContext` with no decision fields. Events that
 * cannot render a decision must never receive one.
 * @param eventName - Native Claude Code hook event name.
 * @param additionalContext - Context to append.
 * @returns JSON string for the native Claude Code hook output.
 */
function serializeContextOutput(eventName: string, additionalContext: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } });
}

// ---------------------------------------------------------------------------
// Collection result to response
// ---------------------------------------------------------------------------

/**
 * Convert a closed failure into a deny response for block-capable
 * interactions.
 * @param detail - The closed failure detail string.
 * @param eventName - The hook event name.
 * @returns A deny response, or the no-op if the event is not block-capable.
 */
function closedFailureToResponse(detail: string, eventName: string): ClientHookHandleResponse {
  if (rendersDecision(eventName)) {
    const stdout = serializeDecisionOutput(eventName, 'deny', detail, undefined);
    return { exitCode: 0, stdout, stderr: '' };
  }

  // Non-block-capable events cannot produce a deny on closed failure.
  return NOOP_RESPONSE;
}

/**
 * Build the final response from collected and reduced effects.
 * @param reduced - Reduced effects from all contributors.
 * @param eventName - The hook event name.
 * @returns The native Claude Code hook handle response.
 */
function buildResponseFromEffects(reduced: ReducedEffects, eventName: string): ClientHookHandleResponse {
  if (rendersDecision(eventName)) {
    if (reduced.decision === undefined && reduced.appendedContext === undefined) {
      // No effects remain — return the provider-valid no-op.
      return NOOP_RESPONSE;
    }
    const effectiveDecision = reduced.decision ?? 'allow';
    const stdout = serializeDecisionOutput(eventName, effectiveDecision, reduced.reason, reduced.appendedContext);
    return { exitCode: 0, stdout, stderr: '' };
  }

  // Every other event renders appended context only; it has no decision to make.
  if (reduced.appendedContext === undefined) return NOOP_RESPONSE;
  return { exitCode: 0, stdout: serializeContextOutput(eventName, reduced.appendedContext), stderr: '' };
}

/**
 * Render collected effects into the native Claude Code hook response.
 *
 * The single place that knows what Claude Code native hook output looks like.
 * Both the terminal `hook.handle` composer and the evidence-capture probe
 * resolve their native shape through this function, so a shape proven against
 * the pinned binary and a shape emitted at runtime cannot drift apart.
 * @param eventName - Native Claude Code hook event name.
 * @param effects - Canonical effects and provider envelopes to render.
 * @returns Native Claude Code hook handle response.
 */
export function renderClaudeCodeNativeResponse(
  eventName: string,
  effects: ReadonlyArray<CanonicalEffect | ProviderContributionEnvelope>,
): ClientHookHandleResponse {
  return buildResponseFromEffects(reduceEffects(effects), eventName);
}

// ---------------------------------------------------------------------------
// Session-token scope resolution
// ---------------------------------------------------------------------------

/**
 * Derive the session-token storage scope for a hook event.
 *
 * `SubagentStart` requires a non-empty `agent_id` in the payload.  The hook
 * normalizers that feed this composer reject subagent events without an id,
 * so a missing id here signals a malformed event.  Forwarding the token
 * without an `agentId` would store it under the parent session key and
 * overwrite the parent token; the sink is skipped instead (returns
 * `undefined`).
 *
 * `SessionStart` and every other event that may later declare the capability
 * are always session-scoped.  Even when a stray `agent_id` appears in the
 * payload it is never adopted — doing so would create a spurious
 * subagent-scoped entry.
 * @param eventName - Claude Code hook event name.
 * @param rawPayload - The inner `payload` object from the hook envelope.
 * @returns Scope to forward to the token sink, or `undefined` to skip it.
 */
function resolveSessionTokenScope(
  eventName: string,
  rawPayload: Record<string, unknown>,
): { clientId: string; adapterSessionId: string; agentId?: string } | undefined {
  const adapterSessionId = pickNonEmptyString(rawPayload, 'session_id');
  if (adapterSessionId === undefined) return undefined;

  if (eventName === CLAUDE_CODE_HOOK_SUBAGENT_START) {
    const agentId = pickNonEmptyString(rawPayload, 'agent_id');
    // SubagentStart without a non-empty agent_id is malformed: skip the sink
    // rather than storing the token under the parent session key.
    if (agentId === undefined) return undefined;
    return { clientId: 'claude-code', adapterSessionId, agentId };
  }

  // All other events (including SessionStart) are session-scoped only;
  // agent_id is never adopted from the payload.
  return { clientId: 'claude-code', adapterSessionId };
}

// ---------------------------------------------------------------------------
// Public composer
// ---------------------------------------------------------------------------

/**
 * Options for composing a hook response, carrying request-scoped context
 * from the bus handler into the collection pipeline.
 */
export interface ComposeHookResponseOptions {
  /** Absolute deadline from the originating bus request, if any. */
  readonly deadline?: number;
  /** Abort signal from the originating bus request, if any. */
  readonly signal?: AbortSignal;
  /** Receives non-fatal contributor diagnostics at the service boundary. */
  readonly onDiagnostics?: (diagnostics: readonly CollectionDiagnostic[]) => void;
  /**
   * Receives a `session.token` effect for the runtime to record; never
   * rendered to the client binary.
   *
   * Called when the hook event declares the `session.token` response
   * capability and a contributor produced a `session.token` canonical effect.
   * The scope carries the adapter session id (hook payload `session_id`) and,
   * for SubagentStart events, the agent id (`agent_id`).
   *
   * The sink is skipped (not called) when:
   * - `session_id` is absent — the token cannot be scoped at all.
   * - The event is `SubagentStart` and `agent_id` is absent or empty —
   *   forwarding without an agent id would overwrite the parent session entry.
   *
   * For `SessionStart` and all other events, `agent_id` is ignored even when
   * present in the payload.
   */
  readonly onSessionToken?: (
    token: string,
    scope: { clientId: string; adapterSessionId: string; agentId?: string },
  ) => void | Promise<void>;
}

/**
 * Compose a terminal `hook.handle` response for a Claude Code request-mode
 * hook event.
 *
 * Orchestrates the full pipeline: snapshot, collect, reduce, and serialize.
 * Returns the provider-valid no-op when no contributors match or all
 * contributors produce no effects.
 *
 * Observer-only events should not reach this composer — the service
 * dispatches them on the `hook.received` pathway instead.
 * @param registry - Hook response contributor registry.
 * @param payload - Raw hook payload from the `hook.handle` request.
 * @param options - Request-scoped deadline and signal from the bus context.
 * @returns Native Claude Code hook handle response.
 */
export async function composeHookResponse(
  registry: ClientHookResponseRegistry,
  payload: RawClientHookPayload,
  options?: ComposeHookResponseOptions,
): Promise<ClientHookHandleResponse> {
  const { eventName } = payload;
  const capabilities = resolveEventCapabilities(eventName);

  // 1. Snapshot matching contributors
  const snapshot = registry.snapshot('claude-code', CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID, eventName, capabilities);

  if (snapshot.length === 0) {
    return NOOP_RESPONSE;
  }

  // 2. Collect contributions concurrently
  const result: CollectionResult = await collectContributions(
    snapshot,
    'claude-code',
    options?.deadline,
    options?.signal,
    eventName,
    payload.payload,
    claudeCodeToolResponseContract,
  );
  if (result.diagnostics.length > 0) options?.onDiagnostics?.(result.diagnostics);

  // 3. Handle closed failure
  if (result.closedFailure) {
    return closedFailureToResponse(result.closedFailure.detail, eventName);
  }

  // 4. Gather all effects from successful outcomes
  const allEffects: Array<CanonicalEffect | ProviderContributionEnvelope> = [];
  for (const outcome of result.outcomes) {
    if (outcome.effects) {
      allEffects.push(...outcome.effects);
    }
  }

  if (allEffects.length === 0) {
    return NOOP_RESPONSE;
  }

  // 5. Reduce all collected effects
  const reduced = reduceEffects(allEffects);

  // 6. Forward the session token to the sink when the event declares the
  //    capability.  Scope resolution is event-aware: SubagentStart requires a
  //    non-empty agent_id (absent → skip); all other events are session-only.
  //
  //    Trust boundary (F1): a directly connected bus peer could submit a forged
  //    `hook.handle` request with another session's `session_id` and, if the
  //    installed contributor issues a token per invocation, overwrite the
  //    legitimate token in the store.  No fix is applied here because:
  //    (a) The bus trust boundary is the bus secret: any authenticated peer that
  //        can reach `hook.handle` already controls far stronger effects on that
  //        session — model context via `context.append`, permission decisions on
  //        `PreToolUse` — so overwriting a correlation token adds no privilege.
  //    (b) The token correlates; it never authorizes.  The consumer contract is
  //        correlation-only, so a forged token mis-correlates at worst and
  //        cannot grant access.
  //    (c) Caller authentication for hook ingress is a bus-level concern shared
  //        by every host-local hook subject and is not something this capability
  //        can address in isolation.
  if (
    reduced.sessionToken !== undefined &&
    capabilities.includes(CANONICAL_HOOK_RESPONSE_CAPABILITIES.sessionToken) &&
    options?.onSessionToken !== undefined
  ) {
    const scope = resolveSessionTokenScope(eventName, payload.payload);
    if (scope !== undefined) {
      await options.onSessionToken(reduced.sessionToken, scope);
    }
  }

  // 7. Render the native response (sessionToken bucket is never written to stdout)
  return buildResponseFromEffects(reduced, eventName);
}
