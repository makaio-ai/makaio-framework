/** Deterministic Codex 0.144.1 hook-response composition. @packageDocumentation */
import { isDeepStrictEqual } from 'node:util';
import { CANONICAL_HOOK_RESPONSE_CAPABILITIES } from '@makaio/contracts/client';
import type { CanonicalEffect, ProviderContributionEnvelope } from '@makaio/contracts/client';
import {
  collectContributions,
  NOOP_HOOK_HANDLE_RESPONSE,
  pickNonEmptyString,
  type ClientHookHandleResponse,
  type ClientHookResponseRegistry,
  type CollectionDiagnostic,
} from '@makaio/subsystem-client';
import { clientDefinition } from '../definition.js';
import { CODEX_CLIENT_ID, CODEX_CONTRACT_ID, codexProviderContractCatalog } from './hook-response-contracts.js';
import {
  CODEX_HOOK_PRE_TOOL_USE,
  CODEX_HOOK_SESSION_START,
  CODEX_HOOK_SUBAGENT_START,
  CODEX_HOOK_USER_PROMPT_SUBMIT,
  type RawClientHookPayload,
} from './schemas.js';

export interface ComposeCodexHookResponseOptions {
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  readonly onDiagnostics?: (diagnostics: readonly CollectionDiagnostic[]) => void;
  /**
   * Receives a `session.token` effect for the runtime to record; never
   * rendered to the client binary's stdout. When several contributors deliver
   * a token, the highest-priority contributor wins (first in the
   * deterministically ordered effects array). Omit when token recording is not
   * required.
   *
   * The sink is skipped (not called) when:
   * - Both `session_id` and `thread_id` are absent from the payload.
   * - The event is `SubagentStart` and `agent_id` is absent or empty —
   *   forwarding without an agent id would overwrite the parent session entry.
   *
   * For `SessionStart` and all other events, `agent_id` is ignored even when
   * present in the payload.
   * @param token - Opaque correlation token value.
   * @param scope - Client id, adapter session id, and optional agent id for
   *   SubagentStart. The client id is always `'codex'` from this composer.
   */
  readonly onSessionToken?: (
    token: string,
    scope: { clientId: string; adapterSessionId: string; agentId?: string },
  ) => void | Promise<void>;
}
/**
 * Resolve the declared response capabilities for one Codex event.
 * @param eventName - Native Codex hook event name.
 * @returns Declared capabilities for the event.
 */
function capabilities(eventName: string): readonly string[] {
  return (
    clientDefinition.runtimeCapabilities.hookEvents.find((event) => event.name === eventName)?.responseCapabilities ??
    []
  );
}

/**
 * Extract the winning `session.token` value from the ordered effects array.
 *
 * Effects arrive in priority-descending order (highest-priority contributor
 * first), so the first matching `session.token` effect is the winner. When the
 * event does not declare the `session.token` capability the effect is dropped
 * and `undefined` is returned — this ensures the token is only collected when
 * the contributor explicitly targeted an event that supports it.
 * @param eventName - Native Codex hook event name.
 * @param effects - Deterministically ordered effects (priority-desc).
 * @returns The winning token value, or `undefined` when absent or not supported.
 */
function extractSessionToken(
  eventName: string,
  effects: readonly (CanonicalEffect | ProviderContributionEnvelope)[],
): string | undefined {
  // Gate: only honour when the event declares the session.token capability.
  if (!capabilities(eventName).includes(CANONICAL_HOOK_RESPONSE_CAPABILITIES.sessionToken)) return undefined;
  for (const effect of effects) {
    if ('kind' in effect && effect.kind === 'session.token') return effect.value;
  }
  return undefined;
}

interface CollectedEffects {
  readonly contexts: string[];
  readonly blocks: string[];
  readonly denyReasons: string[];
  readonly updates: unknown[];
}

const FIRST_BLOCK_EVENTS: ReadonlySet<string> = new Set([
  CODEX_HOOK_SESSION_START,
  CODEX_HOOK_USER_PROMPT_SUBMIT,
  CODEX_HOOK_PRE_TOOL_USE,
]);

/**
 * Collect one provider-native effect into its composition bucket.
 * @param collected - Mutable composition buckets for this request.
 * @param effect - Provider contribution envelope to inspect.
 * @param supportsContext - Whether the current event accepts additional context.
 */
function collectProviderEffect(
  collected: CollectedEffects,
  effect: ProviderContributionEnvelope,
  supportsContext: boolean,
): void {
  if (effect.clientId !== CODEX_CLIENT_ID || effect.contractId !== CODEX_CONTRACT_ID) return;
  const value = effect.effects as Record<string, unknown>;
  if (supportsContext && typeof value.additionalContext === 'string') collected.contexts.push(value.additionalContext);
  if (value.decision === 'block' && typeof value.reason === 'string') collected.blocks.push(value.reason);
  if (value.permissionDecision === 'deny' && typeof value.permissionDecisionReason === 'string')
    collected.denyReasons.push(value.permissionDecisionReason);
  if (value.permissionDecision === 'allow' && 'updatedInput' in value) collected.updates.push(value.updatedInput);
}

/**
 * Collect canonical and provider-native effects for one event.
 * @param eventName - Native Codex hook event name.
 * @param effects - Deterministically ordered effects to collect.
 * @returns Effects grouped by native output behavior.
 */
function collectEffects(
  eventName: string,
  effects: readonly (CanonicalEffect | ProviderContributionEnvelope)[],
): CollectedEffects {
  const collected: CollectedEffects = { contexts: [], blocks: [], denyReasons: [], updates: [] };
  const supportsContext = capabilities(eventName).includes('context.append');
  for (const effect of effects) {
    if ('kind' in effect) {
      if (supportsContext && effect.kind === 'context.append') collected.contexts.push(effect.value);
    } else {
      collectProviderEffect(collected, effect, supportsContext);
    }
  }
  return collected;
}

/**
 * Select the native block reason according to the pinned event rule.
 * @param eventName - Native Codex hook event name.
 * @param blocks - Ordered block reasons.
 * @returns The selected reason, or `undefined` when no block was contributed.
 */
function selectBlockReason(eventName: string, blocks: readonly string[]): string | undefined {
  if (blocks.length === 0) return undefined;
  return FIRST_BLOCK_EVENTS.has(eventName) ? blocks[0] : blocks.join('\n\n');
}

/**
 * Serialize a native Codex response.
 * @param body - Native JSON response body.
 * @returns Hook handle response with the serialized body on stdout.
 */
function serialize(body: Record<string, unknown>): ClientHookHandleResponse {
  return { exitCode: 0, stdout: JSON.stringify(body), stderr: '' };
}

/**
 * Render a blocking native response outside PreToolUse.
 * @param eventName - Native Codex hook event name.
 * @param reason - Selected block reason.
 * @param hookSpecificOutput - Event-specific context output.
 * @param hasContext - Whether context was contributed.
 * @returns Blocking native response.
 */
function renderBlock(
  eventName: string,
  reason: string,
  hookSpecificOutput: Record<string, unknown>,
  hasContext: boolean,
): ClientHookHandleResponse {
  const context = hasContext ? { hookSpecificOutput } : {};
  if (eventName === CODEX_HOOK_SESSION_START) return serialize({ continue: false, stopReason: reason, ...context });
  return serialize({ decision: 'block', reason, ...context });
}

/**
 * Render the precedence-sensitive PreToolUse response.
 * @param collected - Effects grouped by native behavior.
 * @param blockReason - Selected block reason, if any.
 * @param hookSpecificOutput - Mutable native event-specific output.
 * @returns A terminal response, or `undefined` when only context remains to render.
 */
function renderPreToolUse(
  collected: CollectedEffects,
  blockReason: string | undefined,
  hookSpecificOutput: Record<string, unknown>,
): ClientHookHandleResponse | undefined {
  if (blockReason !== undefined)
    return serialize({
      decision: 'block',
      reason: blockReason,
      ...(collected.contexts.length ? { hookSpecificOutput } : {}),
    });
  if (collected.denyReasons.length > 0) {
    hookSpecificOutput.permissionDecision = 'deny';
    hookSpecificOutput.permissionDecisionReason = collected.denyReasons.join('\n');
  } else if (collected.updates.length > 0) {
    hookSpecificOutput.permissionDecision = 'allow';
    hookSpecificOutput.updatedInput = collected.updates[0];
  }
  return undefined;
}
/**
 * Reduce ordered effects into one provider-valid Codex response.
 *
 * The single place that knows what Codex native hook output looks like. Both
 * the terminal `hook.handle` composer and the evidence-capture probe resolve
 * their native shape through this function, so a shape proven against the
 * pinned binary and a shape emitted at runtime cannot drift apart.
 * @param eventName - Native Codex hook event name.
 * @param effects - Deterministically ordered effects to reduce.
 * @returns The terminal native hook response.
 */
export function renderCodexNativeResponse(
  eventName: string,
  effects: readonly (CanonicalEffect | ProviderContributionEnvelope)[],
): ClientHookHandleResponse {
  const collected = collectEffects(eventName, effects);
  if (
    collected.updates.length > 1 &&
    collected.updates.some((candidate) => !isDeepStrictEqual(candidate, collected.updates[0]))
  ) {
    throw new Error('Conflicting Codex PreToolUse input.update effects');
  }
  const hookSpecificOutput: Record<string, unknown> = { hookEventName: eventName };
  if (collected.contexts.length) hookSpecificOutput.additionalContext = collected.contexts.join('\n');
  const blockReason = selectBlockReason(eventName, collected.blocks);
  if (eventName === CODEX_HOOK_PRE_TOOL_USE) {
    const response = renderPreToolUse(collected, blockReason, hookSpecificOutput);
    if (response !== undefined) return response;
  } else if (blockReason !== undefined) {
    return renderBlock(eventName, blockReason, hookSpecificOutput, collected.contexts.length > 0);
  }
  if (!collected.contexts.length && collected.denyReasons.length === 0 && collected.updates.length === 0)
    return NOOP_HOOK_HANDLE_RESPONSE;
  return serialize({ hookSpecificOutput });
}
/**
 * Derive the session-token storage scope for a Codex hook event.
 *
 * `SubagentStart` requires a non-empty `agent_id` in the payload.  The hook
 * normalizers that feed this composer reject subagent events without an id,
 * so a missing id signals a malformed event.  Forwarding without an `agentId`
 * would store the token under the parent session key and overwrite it; the
 * sink is skipped instead (returns `undefined`).
 *
 * `SessionStart` and every other event are always session-scoped.  Even when
 * a stray `agent_id` appears in the payload it is never adopted — doing so
 * would create a spurious subagent-scoped entry.
 * @param eventName - Codex hook event name.
 * @param rawPayload - The inner `payload` object from the hook envelope.
 * @returns Scope to forward to the token sink, or `undefined` to skip it.
 */
function resolveSessionTokenScope(
  eventName: string,
  rawPayload: Record<string, unknown>,
): { clientId: string; adapterSessionId: string; agentId?: string } | undefined {
  // Codex aliases session_id as thread_id on some events.
  const adapterSessionId = pickNonEmptyString(rawPayload, 'session_id') ?? pickNonEmptyString(rawPayload, 'thread_id');
  if (adapterSessionId === undefined) return undefined;

  if (eventName === CODEX_HOOK_SUBAGENT_START) {
    const agentId = pickNonEmptyString(rawPayload, 'agent_id');
    // SubagentStart without a non-empty agent_id is malformed: skip the sink
    // rather than storing the token under the parent session key.
    if (agentId === undefined) return undefined;
    return { clientId: 'codex', adapterSessionId, agentId };
  }

  // All other events (including SessionStart) are session-scoped only;
  // agent_id is never adopted from the payload.
  return { clientId: 'codex', adapterSessionId };
}

/**
 * Compose one terminal Codex native hook response.
 * @param registry - Active response contributor registry.
 * @param payload - Normalized native hook payload.
 * @param options - Request deadline, cancellation, diagnostics hooks, and
 *   optional session-token sink.
 * @returns The composed native response envelope.
 */
export async function composeCodexHookResponse(
  registry: ClientHookResponseRegistry,
  payload: RawClientHookPayload,
  options?: ComposeCodexHookResponseOptions,
): Promise<ClientHookHandleResponse> {
  const snapshot = registry.snapshot(
    CODEX_CLIENT_ID,
    CODEX_CONTRACT_ID,
    payload.eventName,
    capabilities(payload.eventName),
  );
  if (!snapshot.length) return NOOP_HOOK_HANDLE_RESPONSE;
  const result = await collectContributions(
    snapshot,
    CODEX_CLIENT_ID,
    options?.deadline,
    options?.signal,
    payload.eventName,
    payload.payload,
    codexProviderContractCatalog,
  );
  if (result.diagnostics.length) options?.onDiagnostics?.(result.diagnostics);
  if (result.closedFailure)
    return renderCodexNativeResponse(payload.eventName, [
      {
        clientId: CODEX_CLIENT_ID,
        contractId: CODEX_CONTRACT_ID,
        effects: { decision: 'block', reason: result.closedFailure.detail },
      },
    ]);

  const effects = result.outcomes.flatMap((outcome) => outcome.effects ?? []);

  // Extract the session token before rendering — the token is a host-side
  // canonical effect that is never written to the client binary's stdout.
  //
  // Trust boundary (F1): a directly connected bus peer could submit a forged
  // `hook.handle` request with another session's `session_id`/`thread_id` and,
  // if the installed contributor issues a token per invocation, overwrite the
  // legitimate token in the store.  No fix is applied here because:
  // (a) The bus trust boundary is the bus secret: any authenticated peer that
  //     can reach `hook.handle` already controls far stronger effects on that
  //     session — model context via `context.append`, permission decisions on
  //     `PreToolUse` — so overwriting a correlation token adds no privilege.
  // (b) The token correlates; it never authorizes.  The consumer contract is
  //     correlation-only, so a forged token mis-correlates at worst and cannot
  //     grant access.
  // (c) Caller authentication for hook ingress is a bus-level concern shared
  //     by every host-local hook subject and is not something this capability
  //     can address in isolation.
  const token = extractSessionToken(payload.eventName, effects);
  if (token !== undefined && options?.onSessionToken !== undefined) {
    // Scope is event-aware: SubagentStart requires a non-empty agent_id
    // (absent → skip); all other events are session-only.
    const scope = resolveSessionTokenScope(payload.eventName, payload.payload);
    if (scope !== undefined) {
      await options.onSessionToken(token, scope);
    }
  }

  return renderCodexNativeResponse(payload.eventName, effects);
}
