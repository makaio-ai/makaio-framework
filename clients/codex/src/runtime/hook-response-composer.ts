/** Deterministic Codex 0.144.1 hook-response composition. @packageDocumentation */
import { isDeepStrictEqual } from 'node:util';
import type { CanonicalEffect, ProviderContributionEnvelope } from '@makaio/contracts/client';
import {
  collectContributions,
  NOOP_HOOK_HANDLE_RESPONSE,
  type ClientHookHandleResponse,
  type ClientHookResponseRegistry,
  type CollectionDiagnostic,
} from '@makaio/subsystem-client';
import { clientDefinition } from '../definition.js';
import { CODEX_CLIENT_ID, CODEX_CONTRACT_ID, codexProviderContractCatalog } from './hook-response-contracts.js';
import {
  CODEX_HOOK_PRE_TOOL_USE,
  CODEX_HOOK_SESSION_START,
  CODEX_HOOK_USER_PROMPT_SUBMIT,
  type RawClientHookPayload,
} from './schemas.js';

export interface ComposeCodexHookResponseOptions {
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  readonly onDiagnostics?: (diagnostics: readonly CollectionDiagnostic[]) => void;
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
 * @param eventName - Native Codex hook event name.
 * @param effects - Deterministically ordered effects to reduce.
 * @returns The terminal native hook response.
 */
function output(
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
 * Compose one terminal Codex native hook response.
 * @param registry - Active response contributor registry.
 * @param payload - Normalized native hook payload.
 * @param options - Request deadline, cancellation, and diagnostics hooks.
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
    return output(payload.eventName, [
      {
        clientId: CODEX_CLIENT_ID,
        contractId: CODEX_CONTRACT_ID,
        effects: { decision: 'block', reason: result.closedFailure.detail },
      },
    ]);
  return output(
    payload.eventName,
    result.outcomes.flatMap((outcome) => outcome.effects ?? []),
  );
}
