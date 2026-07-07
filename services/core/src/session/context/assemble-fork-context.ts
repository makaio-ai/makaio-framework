import type { IMakaioBus } from '@makaio/bus-core';
import type { IMakaioSession, NativeForkDirective, NativeLocalityVerdict, SessionContext } from '@makaio/contracts';
import { TurnStorageSubjects } from '../turns/index.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { getFullConversation } from './get-full-conversation.js';
import { convertSessionMessage } from './convert-session-message.js';
import { evaluateNativeLocality } from '../native-locality.js';
import { emitLocalityDegradeEvent } from '../session-lifecycle-events.js';

/**
 * Resolve the effective adapter name for the fork locality check.
 *
 * Falls back to the source session's adapter name when the caller does not
 * supply a target adapter name (e.g. route-to-agents with mixed adapters).
 * Returns an empty string as last resort so the evaluator skips the mismatch
 * check for truly unknown targets.
 * @param targetAdapterName - Explicit target adapter name, if known
 * @param sourceSession - Source session being forked
 * @returns Effective adapter name for the locality evaluator
 */
function resolveEffectiveForkAdapterName(targetAdapterName: string | undefined, sourceSession: IMakaioSession): string {
  return targetAdapterName ?? sourceSession.adapterName ?? '';
}

/** Adapter capability signals required before emitting a native fork directive. */
export interface AssembleForkContextCapabilities {
  /** Adapter declares provider-native fork support for the selected target. */
  readonly adapterSupportsNativeFork: boolean;
  /** Adapter declares support for provider-native mid-history/checkpoint fork. */
  readonly midHistoryForkSupported: boolean;
}

/**
 * Build a fresh-with-history context by injecting the full conversation and
 * attaching the given locality verdict. Shared by the non-native path and
 * the mid-history degrade path.
 * @param bus - Bus instance for RPC calls
 * @param sessionId - Session whose projected conversation should be loaded
 * @param originalContext - Original sessionContext to spread into the result
 * @param session - The fork session (for forkTransforms detection)
 * @param verdict - Locality verdict to attach
 * @returns SessionContext with messageHistory injected
 */
async function buildFreshWithHistory(
  bus: IMakaioBus,
  sessionId: string,
  originalContext: SessionContext | undefined,
  session: IMakaioSession,
  verdict: NativeLocalityVerdict,
): Promise<SessionContext> {
  // Emit the degrade event at the converging fork-degrade path.
  // Both evaluator-determined degrades and fork-point-unresolvable flow here.
  void emitLocalityDegradeEvent(bus, { sessionId, intent: 'fork', verdict });

  const contextResult = await getFullConversation(bus, sessionId);
  const messageHistory = contextResult.messages.map(convertSessionMessage);
  return {
    ...originalContext,
    messageHistory,
    isFirstTurn: true,
    hasNewTransforms: session.forkTransforms !== undefined,
    nativeLocality: verdict,
  };
}

/**
 * Resolve the provider-native message ID for a mid-history fork point.
 *
 * `session.forkPointMessageId` is a session-storage UUID assigned by the
 * fork handler.  The adapter layer needs the provider-native
 * `adapterMessageId` (used as `resumeSessionAt` in the Claude SDK path).
 * @param bus - Bus instance for the message lookup
 * @param storageMessageId - Session-storage message ID of the fork point
 * @returns The provider-native message ID, or `undefined` when the stored
 *   message has no `adapterMessageId` (e.g. locally-created messages where
 *   SessionBridge stamped a fresh UUID)
 */
async function resolveForkPointAdapterMessageId(
  bus: IMakaioBus,
  storageMessageId: string,
): Promise<string | undefined> {
  const { message } = await bus.request(MessageStorageSubjects.get, {
    messageId: storageMessageId,
  });
  return message?.adapterMessageId ?? undefined;
}

/**
 * Assemble fork context for a session's first turn.
 *
 * For fork sessions on their first turn, this:
 * 1. Detects if this is a fork session (has parentSessionId)
 * 2. Checks if this is the first turn (via isNewTurn flag + storage query)
 * 3. Evaluates native locality for the source (parent) session
 * 4a. If native: returns a fork directive without message history injection
 * 4b. Otherwise: calls getFullConversation() to get projected context with transforms,
 *     converts SessionMessage[] to Message[] format, and attaches the locality verdict
 * 5. Returns enriched SessionContext
 *
 * If not a fork first turn, returns the original sessionContext unchanged.
 * @param bus - Bus instance for RPC calls
 * @param session - Session to check for fork context
 * @param sessionId - Session ID
 * @param originalContext - Original sessionContext from payload
 * @param isNewTurn - Whether this is a new turn (avoids race with just-created turn record)
 * @param localMachineId - Stable machine identity of the current host process
 * @param capabilities - Adapter capability signals resolved by the caller
 * @param targetCwd - Effective working directory for the new agent, overriding
 *   `session.targetWorkingDirectory` in the locality check. Callers that resolve
 *   a per-request cwd override (e.g. a send payload `cwd` field) must pass the
 *   resolved value here so the native-fork evaluation and the eventual
 *   `startAgent` call operate on the same cwd — preventing a mismatch where
 *   locality is approved against the stored session cwd but the agent starts in
 *   a different directory.
 * @param targetAdapterName - Stable adapter type name of the target adapter.
 *   Compared against the source session's adapterName to prevent cross-adapter
 *   fork — sending a provider session ID to a different adapter type would
 *   corrupt the conversation. Undefined when the caller cannot determine the
 *   target adapter (e.g. route-to-agents with mixed adapters); in that case the
 *   adapter-mismatch check is skipped.
 * @returns Enriched or original SessionContext
 */
export async function assembleForkContext(
  bus: IMakaioBus,
  session: IMakaioSession,
  sessionId: string,
  originalContext?: SessionContext,
  isNewTurn?: boolean,
  localMachineId?: string,
  capabilities?: AssembleForkContextCapabilities,
  targetCwd?: string,
  targetAdapterName?: string,
): Promise<SessionContext | undefined> {
  const shouldInheritParentHistory =
    session.parentSessionId !== undefined &&
    (session.contextInheritance === 'parent-history' ||
      (session.contextInheritance === undefined && session.branchKind !== 'subagent'));

  // Skip if this child does not inherit parent history or context already has messageHistory.
  if (!shouldInheritParentHistory || originalContext?.messageHistory) {
    return originalContext;
  }

  // Determine if this is the first turn.
  // Use isNewTurn flag combined with storage query to distinguish
  // "just the one we created" from "had prior turns".
  const { turns } = await bus.request(TurnStorageSubjects.getBySession, {
    sessionId,
    limit: 2,
  });
  const isFirstTurn = !!isNewTurn && turns.length <= 1;

  if (!isFirstTurn) {
    return originalContext;
  }

  const parentSessionId = session.parentSessionId;
  if (parentSessionId === undefined) {
    return originalContext;
  }

  const { session: sourceSession } = await bus.request(SessionStorageSubjects.get, {
    sessionId: parentSessionId,
  });

  if (sourceSession === null) {
    return originalContext;
  }

  // Evaluate native locality for the source session to determine fork strategy.
  // Use the caller-supplied targetCwd when present so callers with a per-request
  // cwd override evaluate locality against the same directory they will pass to
  // startAgent — preventing an approve-against-A/launch-with-B mismatch.
  const effectiveTargetCwd = targetCwd ?? session.targetWorkingDirectory;
  const verdict = evaluateNativeLocality({
    intent: 'fork',
    session: {
      ...sourceSession,
      forkPointMessageId: session.forkPointMessageId,
      forkTransforms: session.forkTransforms,
    },
    localMachineId,
    adapterSupportsNative: capabilities?.adapterSupportsNativeFork === true,
    // When targetAdapterName is not supplied (e.g. route-to-agents with mixed
    // adapters), fall back to the source session's adapterName so the identity
    // check is a no-op match rather than a false mismatch. The route-to-agents
    // path degrades nativeFork anyway, so this is safe.
    targetAdapterName: resolveEffectiveForkAdapterName(targetAdapterName, sourceSession),
    currentCwd: sourceSession.targetWorkingDirectory,
    targetCwd: effectiveTargetCwd,
    sessionContext: originalContext,
    midHistoryForkSupported: capabilities?.midHistoryForkSupported === true,
  });

  // A native verdict implies the evaluator saw a source adapterSessionId; the
  // explicit narrow keeps that invariant type-checked instead of asserted.
  const sourceAdapterSessionId = sourceSession.adapterSessionId;
  if (verdict.kind === 'native' && sourceAdapterSessionId !== undefined) {
    // Mid-history fork: resolve the provider-native message ID. The session
    // stores a session-storage UUID, but the adapter needs the adapterMessageId
    // (forwarded as resumeSessionAt in the Claude SDK path).
    if (session.forkPointMessageId !== undefined) {
      const adapterMsgId = await resolveForkPointAdapterMessageId(bus, session.forkPointMessageId);
      if (adapterMsgId === undefined) {
        // Degrade: the provider cannot resolve this checkpoint.
        return buildFreshWithHistory(bus, sessionId, originalContext, session, {
          kind: 'degrade',
          reason: 'fork-point-unresolvable',
        });
      }
      const nativeFork: NativeForkDirective = {
        sourceSessionId: parentSessionId,
        sourceAdapterSessionId,
        forkPointMessageId: adapterMsgId,
        ...(session.targetWorkingDirectory !== undefined && { targetWorkingDirectory: session.targetWorkingDirectory }),
      };
      return { ...originalContext, nativeLocality: verdict, nativeFork, isFirstTurn: true };
    }

    // Fork-at-head: no checkpoint needed, just branch from the tip.
    const nativeFork: NativeForkDirective = {
      sourceSessionId: parentSessionId,
      sourceAdapterSessionId,
      ...(session.targetWorkingDirectory !== undefined && { targetWorkingDirectory: session.targetWorkingDirectory }),
    };
    return { ...originalContext, nativeLocality: verdict, nativeFork, isFirstTurn: true };
  }

  // Non-native fork: inject message history and attach the locality verdict.
  return buildFreshWithHistory(bus, sessionId, originalContext, session, verdict);
}
