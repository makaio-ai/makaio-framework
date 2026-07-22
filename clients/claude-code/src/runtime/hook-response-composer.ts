/**
 * Claude Code hook response composer.
 *
 * One terminal `hook.handle` composer covering every request-capable Claude
 * Code event.  Currently only `PreToolUse` is request-capable (proven by the
 * Phase 0 manifest).  Observer-only events bypass this composer entirely —
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
 * PreToolUse native output is JSON on stdout:
 * ```json
 * {
 *   "hookSpecificOutput": {
 *     "hookEventName": "PreToolUse",
 *     "permissionDecision": "allow" | "deny",
 *     "permissionDecisionReason": "optional reason"
 *   }
 * }
 * ```
 * @packageDocumentation
 */

import type { CanonicalEffect, ProviderContributionEnvelope } from '@makaio/contracts/client';
import type { ClientHookHandleResponse, RawClientHookPayload } from '@makaio/subsystem-client';
import type { ClientHookResponseRegistry } from '@makaio/subsystem-client';
import { collectContributions, type CollectionDiagnostic, type CollectionResult } from '@makaio/subsystem-client';
import { NOOP_HOOK_HANDLE_RESPONSE } from '@makaio/subsystem-client';
import {
  CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
  claudeCodeToolResponseContract,
  type ClaudeCodePreToolUseEffects,
  type ClaudeCodeToolDecision,
} from './hook-response-contracts.js';
import { clientDefinition } from '../definition.js';
import { CLAUDE_CODE_HOOK_PRE_TOOL_USE } from './schemas.js';

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
  let hasAllow = false;
  let hasDeny = false;

  for (const effect of effects) {
    if ('kind' in effect && effect.kind === 'context.append') {
      // Canonical context.append effect
      appendParts.push(effect.value);
      continue;
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
  };
}

// ---------------------------------------------------------------------------
// Native output serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a PreToolUse decision into the native Claude Code output format.
 * @param decision - The resolved tool decision.
 * @param reason - Optional reason string.
 * @param additionalContext - Context appended before the tool executes.
 * @returns JSON string for the native Claude Code hook output.
 */
function serializePreToolUseOutput(
  decision: ClaudeCodeToolDecision,
  reason: string | undefined,
  additionalContext: string | undefined,
): string {
  const hookSpecificOutput: Record<string, string> = {
    hookEventName: CLAUDE_CODE_HOOK_PRE_TOOL_USE,
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
  if (eventName === CLAUDE_CODE_HOOK_PRE_TOOL_USE) {
    const stdout = serializePreToolUseOutput('deny', detail, undefined);
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
  if (reduced.decision === undefined && reduced.appendedContext === undefined) {
    // No effects remain — return the provider-valid no-op.
    return NOOP_RESPONSE;
  }

  if (eventName === CLAUDE_CODE_HOOK_PRE_TOOL_USE) {
    const effectiveDecision = reduced.decision ?? 'allow';
    const stdout = serializePreToolUseOutput(effectiveDecision, reduced.reason, reduced.appendedContext);
    return { exitCode: 0, stdout, stderr: '' };
  }

  return NOOP_RESPONSE;
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

  // 5. Reduce effects and build response
  const reduced = reduceEffects(allEffects);
  return buildResponseFromEffects(reduced, eventName);
}
