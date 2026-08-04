import type { IMakaioSession, NativeLocalityVerdict, SessionContext } from '@makaio/contracts';
import type { SessionResumeIdentity } from './session-resume-identity.js';

/**
 * Describes whether the session resume/fork intent is a native continuation
 * or a new fork branching from an existing session.
 */
export type NativeLocalityIntent = 'resume' | 'fork';

/**
 * All inputs required for the native locality evaluator.
 */
export interface NativeLocalityInput {
  /** Whether this is a resume or fork operation. */
  readonly intent: NativeLocalityIntent;
  /** The session being resumed or forked. */
  readonly session: IMakaioSession;
  /**
   * The stable machine identity of the current host process.
   * Undefined when the framework host has not yet resolved machine identity.
   */
  readonly localMachineId: string | undefined;
  /**
   * Whether the adapter for this session declares native resume/fork capability.
   * Adapters that cannot natively replay/branch must always inject history.
   */
  readonly adapterSupportsNative: boolean;
  /**
   * Stable adapter type name of the target adapter (e.g. 'claude-code', 'codex-mcp').
   *
   * Compared against `session.adapterName` to prevent cross-adapter resume/fork:
   * sending a Claude provider session ID to a Codex adapter (or vice versa) would
   * corrupt the provider conversation. When the session has no stored adapterName
   * (legacy records, sessions created before adapter identity tracking), the check
   * is skipped — the downstream adapter will reject an incompatible session ID.
   */
  readonly targetAdapterName: string;
  /**
   * Working directory of the current adapter instance.
   * Only relevant when `targetCwd` is also supplied.
   */
  readonly currentCwd?: string;
  /**
   * Requested working directory for the resumed or forked session.
   * When it differs from `currentCwd`, native operation cannot reuse the
   * existing connector.
   */
  readonly targetCwd?: string;
  /**
   * Turn-scoped context signals produced by the session orchestrator.
   * Used to detect compression, connector swaps, and pending transforms.
   */
  readonly sessionContext?: SessionContext;
  /**
   * Whether the underlying adapter supports forking at a mid-history message.
   * Required when `session.forkPointMessageId` is set and `intent === 'fork'`.
   */
  readonly midHistoryForkSupported?: boolean;
  /**
   * Resume currency the caller resolved for this session.
   *
   * `session.adapterSessionId` is immutable origin provenance, so callers that
   * track currency must resolve it with {@link resolveSessionResumeIdentity} and
   * pass the result here. When present it is authoritative — including when it
   * resolves to no usable provider session, which must never silently fall back
   * to the origin column.
   *
   * Omit it to read the origin column directly. That is correct only for callers
   * whose sessions cannot have moved their provider identity.
   */
  readonly resumeIdentity?: SessionResumeIdentity;
}

/**
 * Returns true when pending or stored transforms prevent native history reuse.
 * Extracted to keep `evaluateNativeLocality` within the complexity budget.
 * @param session - The session to inspect
 * @param sessionContext - Optional turn-scoped context signals
 * @returns `true` when the session or context carries transforms that diverge
 *   the provider-native history from the orchestrated view
 */
function hasTransforms(session: IMakaioSession, sessionContext: SessionContext | undefined): boolean {
  return sessionContext?.hasNewTransforms === true || session.forkTransforms !== undefined;
}

/**
 * Returns true when the target adapter identity differs from the session's
 * stored adapter identity. Skips the check for legacy sessions that lack a
 * stored adapterName.
 * @param session - The session to inspect for a stored adapter type name
 * @param targetAdapterName - The adapter type name being targeted
 * @returns `true` when the adapter identities mismatch
 */
function isAdapterMismatch(session: IMakaioSession, targetAdapterName: string): boolean {
  return session.adapterName !== undefined && targetAdapterName !== session.adapterName;
}

/**
 * Disqualify the operation when the session has no usable resume currency.
 *
 * Owns both currency-related verdicts so `evaluateNativeLocality` keeps one
 * decision point for "is there a provider session to work with at all":
 * a moved-but-unconfirmed identity and a missing identity are different
 * reasons for the same structural failure.
 * @param input - Locality evaluation input
 * @returns Degrade verdict when there is no usable currency, `undefined` otherwise
 */
function evaluateResumeCurrency(input: NativeLocalityInput): NativeLocalityVerdict | undefined {
  if (input.resumeIdentity?.movedUnconfirmed === true) {
    return { kind: 'degrade', reason: 'adapter-session-moved' };
  }
  const resumeAdapterSessionId = input.resumeIdentity
    ? input.resumeIdentity.adapterSessionId
    : input.session.adapterSessionId;
  if (!resumeAdapterSessionId) {
    return { kind: 'degrade', reason: 'no-adapter-session' };
  }
  return undefined;
}

/**
 * Evaluates whether a session can use native resume or fork, or must fall back
 * to history injection.
 *
 * Checks are ordered from cheapest/most common disqualifier to most specific so
 * that callers pay no cost for conditions that are almost never hit:
 *
 * 1. Adapter capability declaration
 * 2. Provider-native session ID presence
 * 3. Machine identity availability and ownership
 * 4. Structural constraints (imports + orchestration, compression, transforms,
 *    connector swap, CWD mismatch)
 * 5. Mid-history fork support
 * @param input - All signals needed to determine locality
 * @returns A {@link NativeLocalityVerdict} describing the outcome
 */
export function evaluateNativeLocality(input: NativeLocalityInput): NativeLocalityVerdict {
  const { session, sessionContext } = input;

  if (!input.adapterSupportsNative) {
    return { kind: 'degrade', reason: 'adapter-unsupported' };
  }

  // The provider session ID belongs to the adapter that created it. Resuming or
  // forking into a different adapter type would send the wrong provider protocol
  // (e.g. Claude session ID to Codex). Skip the check for legacy sessions that
  // lack a stored adapterName — the downstream adapter rejects incompatible IDs.
  if (isAdapterMismatch(session, input.targetAdapterName)) {
    return { kind: 'degrade', reason: 'adapter-mismatch' };
  }

  const currencyVerdict = evaluateResumeCurrency(input);
  if (currencyVerdict) {
    return currencyVerdict;
  }

  if (!session.machineId) {
    return { kind: 'degrade', reason: 'missing-machine-id' };
  }

  if (!input.localMachineId) {
    return { kind: 'degrade', reason: 'missing-machine-id' };
  }

  if (session.machineId !== input.localMachineId) {
    return { kind: 'foreign', machineId: session.machineId };
  }

  // A session that was both imported and modified by orchestration cannot be
  // natively resumed: the provider-native history diverges from the orchestrated
  // view and the two cannot be reconciled without history injection.
  if (session.isImported && session.isOrchestrated === true) {
    return { kind: 'degrade', reason: 'hybrid-imported-orchestrated' };
  }

  if (sessionContext?.hasCompression) {
    return { kind: 'degrade', reason: 'compression-present' };
  }

  // Pending transforms or stored fork transforms indicate the provider-native
  // history has diverged from the orchestrated history.
  if (hasTransforms(session, sessionContext)) {
    return { kind: 'degrade', reason: 'transforms-present' };
  }

  if (sessionContext?.hasConnectorSwap) {
    return { kind: 'degrade', reason: 'connector-swap' };
  }

  if (input.currentCwd && input.targetCwd && input.currentCwd !== input.targetCwd) {
    return { kind: 'degrade', reason: 'cwd-mismatch' };
  }

  if (input.intent === 'fork' && session.forkPointMessageId && input.midHistoryForkSupported !== true) {
    return { kind: 'degrade', reason: 'mid-history-unsupported' };
  }

  return { kind: 'native' };
}
