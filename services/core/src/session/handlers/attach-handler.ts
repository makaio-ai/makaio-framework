/**
 * Handler for session.agent.attach RPC.
 *
 * Extracted from SessionOrchestrator for file size management.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentResolutionSubjects, ProviderContextSchema, SessionSubjects } from '@makaio/contracts';
import type {
  AgentRole,
  AgentSelectionBase,
  IMakaioSession,
  MessageInput,
  ResolvedAgentConfig,
  SessionContext,
} from '@makaio/contracts';
import { buildTurnInitiator, extractTextContent, resolveAdapterId } from '../session-orchestrator-helpers.js';
import { normalizeSelectionString, resolveAdapterNameById } from '../selection-utils.js';
import { resolveAttachProviderSelection } from './attach-provider-selection.js';
import type { AttachAgentParams, ResolvedAttachExecution } from './attach-execution-types.js';
import {
  assertSessionActiveAfterStart,
  dispatchInitialAttachMessage,
  stopStartedAgentAfterFailure,
} from './attach-turn-tracking.js';
import { persistIdentityOrRollback, rollbackPersistedIdentity } from './attach-identity-persistence.js';
import {
  extractRuntimeOptions,
  launchAttachAgent,
  mergeRuntimeOptions,
  resolveEffectiveAttachCwd,
} from './attach-runtime-options.js';
import { evaluateNativeLocality } from '../native-locality.js';
import { seedAttachContextWithHistory } from '../context/seed-attach-context.js';
import { emitLocalityDegradeEvent } from '../session-lifecycle-events.js';
import type { SessionTurnManager } from '../session-turn-manager.js';
import type { TurnReservation } from '../session-turn-manager.js';
import { SessionAgentAttachError } from './attach-error.js';
import { SessionAttachCloseGate } from './session-attach-close-gate.js';

/**
 * Registers the session.agent.attach RPC handler.
 *
 * Explicitly attaches a fresh agent to a session with full control over:
 * - Role assignment (lead vs member)
 * - Optional initial message
 *
 * For branching conversations (fork), use session.fork to create a new session
 * with copied history, then attach agents to the new session.
 * @param bus - Bus instance for communication
 * @param turnManager - Shared owner of session turn lifecycle state
 * @param machineId - Optional machine ID for deterministic adapter resolution
 * @returns Cleanup function to unsubscribe
 */
export function registerAttachHandler(
  bus: IMakaioBus,
  turnManager: SessionTurnManager,
  machineId?: string,
): () => void {
  const closeGate = new SessionAttachCloseGate();
  const attachCleanup = bus.on(SessionSubjects.agent.attach, async (ctx) => {
    ctx.setResult(
      await attachAgent(bus, turnManager, machineId, {
        ...ctx.payload,
        assertAttachCommitAllowed: () => closeGate.assertAttachCommitAllowed(ctx.payload.sessionId),
      }),
    );
  });
  const attachResolvedCleanup = bus.on(SessionSubjects.agent.attachResolved, async (ctx) => {
    if (!ctx.origin.local) {
      throw new Error('[attach-handler] session.agent.attachResolved requires a local-origin request');
    }
    const admissionAssertion = ctx.payload.assertInitialMessageAdmission;
    if (admissionAssertion !== undefined && typeof admissionAssertion !== 'function') {
      throw new Error('[attach-handler] assertInitialMessageAdmission must be a function');
    }
    ctx.setResult(
      await attachAgent(bus, turnManager, machineId, {
        ...ctx.payload,
        assertAttachCommitAllowed: () => closeGate.assertAttachCommitAllowed(ctx.payload.sessionId),
        assertInitialMessageAdmission: admissionAssertion as (() => void) | undefined,
        resolvedProviderContext:
          ctx.payload.agent.providerContext === undefined
            ? undefined
            : ProviderContextSchema.parse(ctx.payload.agent.providerContext),
      }),
    );
  });
  const closeMiddlewareCleanup = closeGate.registerCloseMiddleware(bus);

  return () => {
    attachCleanup();
    attachResolvedCleanup();
    closeMiddlewareCleanup();
  };
}

interface AdapterCandidate {
  readonly adapterName: string | undefined;
  readonly adapterId: string | undefined;
}

/** Locality resolution result for an attach operation. */
interface AttachLocalityResult {
  /** Adapter session ID to use for native resume mode, or undefined for fresh create. */
  resumeAdapterSessionId: string | undefined;
  /** Session context carrying the locality verdict for non-native paths. */
  attachSessionContext: SessionContext | undefined;
}

/**
 * Safely evaluate a boolean predicate against an optional bus RPC.
 *
 * Wraps the common try / requestOptional / unhandled→false / catch→false
 * pattern used by adapter capability and liveness probes. The caller
 * supplies a `query` thunk that calls `bus.requestOptional(...)` and an
 * `evaluate` predicate that interprets a successful response.
 * @param query - Thunk returning the `requestOptional` promise
 * @param evaluate - Predicate applied when the request is handled
 * @returns Result of `evaluate` on success, `false` on missing handler or error
 */
async function probeOptionalCapability<T>(
  query: () => Promise<{ handled: true; data: T } | { handled: false }>,
  evaluate: (data: T) => boolean,
): Promise<boolean> {
  try {
    const result = await query();
    if (!result.handled) return false;
    return evaluate(result.data);
  } catch {
    return false;
  }
}

/**
 * Queries the target adapter's declared capabilities via bus and checks
 * whether `session:resume` is present.
 *
 * Uses `requestOptional` so adapters that have not registered a
 * `getCapabilities` handler are treated as non-resume-capable rather than
 * causing a bus timeout.
 * @param bus - Bus instance for the capability query
 * @param adapterId - Resolved adapter instance ID
 * @returns `true` when the adapter declares `session:resume`
 */
async function adapterSupportsResume(bus: IMakaioBus, adapterId: string): Promise<boolean> {
  return probeOptionalCapability(
    () => bus.requestOptional(AdapterSubjects.getCapabilities, { adapterId }),
    (data) => new Set(data.capabilities).has('session:resume'),
  );
}

/**
 * Checks whether any live agent in the adapter registry is already using the
 * given provider-native session ID.
 *
 * A provider-native session has exactly one live writer. When a second agent
 * attempts to resume the same `adapterSessionId`, it would mutate the first
 * agent's conversation. This guard ensures attach degrades to
 * fresh-with-history instead.
 *
 * This is a best-effort guard: the definitive serialization happens in the
 * adapter's `startAgent` handler via `registry.claimAdapterSession()`, which
 * atomically rejects a second concurrent resume for the same provider session.
 *
 * Uses `requestOptional` so adapters that have not registered a `listAgents`
 * handler are treated as having no live writer (safe default: the adapter
 * cannot confirm liveness, so the resume attempt proceeds).
 * @param bus - Bus instance for the agent query
 * @param adapterId - Resolved adapter instance ID
 * @param adapterSessionId - Provider-native session ID to check
 * @returns `true` when a live agent already holds the adapter session
 */
async function adapterSessionHasLiveWriter(
  bus: IMakaioBus,
  adapterId: string,
  adapterSessionId: string,
): Promise<boolean> {
  return probeOptionalCapability(
    () => bus.requestOptional(AdapterSubjects.listAgents, { adapterId }),
    (data) => data.agents.some((a) => a.adapterSessionId === adapterSessionId),
  );
}

/**
 * Resolves the native locality verdict for a resume attach and returns both
 * the resume adapter session ID (present only for native) and the session
 * context to forward (present only for non-native).
 *
 * Queries the target adapter's `session:resume` capability via bus so that
 * adapters without native resume produce a `degrade('adapter-unsupported')`
 * verdict upfront, rather than relying solely on the downstream
 * `AIAgent.supportsNativeResume()` fallback.
 *
 * When the structural locality check passes (`native`), an additional
 * live-writer guard verifies no existing agent in the adapter registry is
 * already using the same `adapterSessionId`. Resuming into an occupied
 * provider session would share/mutate another agent's conversation, so the
 * attach degrades to `agent-already-started` fresh-with-history instead.
 * @param input - Bus for the capability lookup, resolved adapter instance ID,
 *   stable adapter type name, validated session record, local machine identity,
 *   and effective working directory for the locality evaluator
 * @returns Resolved resume adapter session ID and optional non-native session context
 */
async function resolveAttachLocality(input: {
  bus: IMakaioBus;
  adapterId: string;
  adapterName: string;
  session: IMakaioSession;
  machineId: string | undefined;
  effectiveCwd: string | undefined;
}): Promise<AttachLocalityResult> {
  const { bus, adapterId, adapterName, session, machineId, effectiveCwd } = input;
  const adapterCanResume = await adapterSupportsResume(bus, adapterId);
  const verdict = evaluateNativeLocality({
    intent: 'resume',
    session,
    localMachineId: machineId,
    adapterSupportsNative: adapterCanResume,
    targetAdapterName: adapterName,
    currentCwd: session.targetWorkingDirectory,
    targetCwd: effectiveCwd,
  });

  // A native verdict implies the evaluator saw a non-empty adapterSessionId,
  // so the explicit narrow here can only pass — it replaces a non-null assertion.
  if (verdict.kind === 'native' && session.adapterSessionId !== undefined) {
    const hasLiveWriter = await adapterSessionHasLiveWriter(bus, adapterId, session.adapterSessionId);
    if (hasLiveWriter) {
      const degraded = { kind: 'degrade' as const, reason: 'agent-already-started' as const };
      void emitLocalityDegradeEvent(bus, {
        sessionId: session.sessionId,
        intent: 'resume',
        verdict: degraded,
        adapterId,
      });
      return {
        resumeAdapterSessionId: undefined,
        attachSessionContext: { nativeLocality: degraded },
      };
    }
  }

  // Emit for non-native evaluator verdicts (degrade or foreign).
  if (verdict.kind !== 'native') {
    void emitLocalityDegradeEvent(bus, {
      sessionId: session.sessionId,
      intent: 'resume',
      verdict,
      adapterId,
    });
  }

  return {
    resumeAdapterSessionId: verdict.kind === 'native' ? session.adapterSessionId : undefined,
    attachSessionContext: verdict.kind !== 'native' ? { nativeLocality: verdict } : undefined,
  };
}

/**
 * Attach an agent to a session.
 * @param bus - Bus instance for storage, resolution, and adapter startup
 * @param turnManager - Shared owner of the initial-message turn lifecycle
 * @param machineId - Optional machine ID for deterministic adapter resolution
 * @param params - Attach request fields plus optional resolved provider context
 * @returns Attach response payload
 */
async function attachAgent(
  bus: IMakaioBus,
  turnManager: SessionTurnManager,
  machineId: string | undefined,
  params: AttachAgentParams,
) {
  const {
    sessionId,
    agent: agentSelection,
    initialMessage,
    responseSchema,
    source,
    extensionId,
    assertAttachCommitAllowed,
    assertInitialMessageAdmission,
    role: requestedRole,
    resolvedProviderContext,
  } = params;
  const explicitRuntime = extractRuntimeOptions(agentSelection);
  const session = await validateSession(bus, sessionId);
  const resolved = await resolveAttachSelection(bus, sessionId, initialMessage, agentSelection);
  const adapterCandidate = resolveAdapterCandidate(agentSelection, resolved);
  const { adapterName, adapterId } = await resolveAdapterTarget(
    bus,
    adapterCandidate.adapterName,
    adapterCandidate.adapterId,
    machineId,
  );

  const { providerConfigId: mergedProviderConfigId, providerContext } = await resolveAttachProviderSelection(
    bus,
    adapterName,
    agentSelection.providerConfigId,
    resolved,
    resolvedProviderContext,
  );
  const { runtimeOptions, mergedModel, mergedCwd } = mergeRuntimeOptions(explicitRuntime, resolved, providerContext);
  const { effectiveCwd, effectiveRuntimeOptions } = resolveEffectiveAttachCwd(
    mergedCwd,
    session.targetWorkingDirectory,
    runtimeOptions,
  );
  const role = determineRole(session, requestedRole);
  const locality = await resolveAttachLocality({ bus, adapterId, adapterName, session, machineId, effectiveCwd });
  const { resumeAdapterSessionId } = locality;
  // Seed non-native paths with existing history so the fresh provider context is populated.
  const attachSessionContext = locality.attachSessionContext
    ? await seedAttachContextWithHistory(bus, sessionId, locality.attachSessionContext)
    : undefined;
  return executeResolvedAttach(bus, turnManager, {
    launch: {
      adapterId,
      sessionId,
      role,
      effectiveRuntimeOptions,
      resumeAdapterSessionId,
      harnessId: params.harnessId ?? resolved?.harnessId,
      attachSessionContext,
    },
    identity: {
      adapterName,
      sessionId,
      role,
      timestamp: Date.now(),
      personaId: getPersonaId(agentSelection),
      profileId: resolved?.profileId,
      harnessId: params.harnessId ?? resolved?.harnessId,
      providerConfigId: mergedProviderConfigId,
      compressionMode: resolved?.compressionMode,
      model: mergedModel,
      cwd: effectiveCwd,
    },
    session,
    initialMessage,
    responseSchema,
    initiator: buildTurnInitiator(source, extensionId),
    sessionContext: attachSessionContext,
    assertAttachCommitAllowed: () => assertAttachCommitAllowed?.(),
    assertInitialMessageAdmission,
  });
}

/**
 * Start the resolved agent and dispatch an initial message through an exclusive turn reservation.
 * @param bus - Bus used for adapter lifecycle, persistence, and routing.
 * @param turnManager - Owner of session turn slots and completion state.
 * @param input - Fully resolved attach launch, identity, and message inputs.
 * @returns Attach response containing canonical turn identity when a message was dispatched.
 */
async function executeResolvedAttach(bus: IMakaioBus, turnManager: SessionTurnManager, input: ResolvedAttachExecution) {
  // Idle-only attach does not consume a turn slot. Initial-message attach must
  // reserve before provider startup so it cannot race an active or pending turn.
  let reservation: TurnReservation | undefined;
  try {
    reservation =
      input.initialMessage === undefined ? undefined : await turnManager.reserveTurn(input.session.sessionId);
  } catch (error) {
    throw new SessionAgentAttachError('initial_message', error);
  }
  try {
    let identityPersisted = false;
    let startResult;
    try {
      startResult = await launchAttachAgent(bus, input.launch);
      await assertSessionActiveAfterStart(bus, startResult, input.session.sessionId);
      identityPersisted = await persistIdentityOrRollback(bus, startResult, input.identity);
    } catch (error) {
      throw new SessionAgentAttachError('agent_attach', error);
    }
    let turnInfo;
    if (reservation === undefined || input.initialMessage === undefined) {
      try {
        input.assertAttachCommitAllowed();
      } catch (error) {
        const attachError = identityPersisted
          ? await rollbackPersistedIdentity(bus, startResult.agentId, error)
          : error;
        await stopStartedAgentAfterFailure(
          bus,
          startResult,
          input.session.sessionId,
          'session close won attach commit',
        );
        throw new SessionAgentAttachError('agent_attach', attachError);
      }
    } else {
      const assertAdmission = () => {
        input.assertAttachCommitAllowed();
        input.assertInitialMessageAdmission?.();
      };
      turnInfo = await dispatchInitialAttachMessage(
        bus,
        turnManager,
        reservation,
        startResult,
        input.session,
        input.initialMessage,
        input.responseSchema,
        input.initiator,
        input.sessionContext,
        assertAdmission,
      ).catch(async (error: unknown) => {
        const attachError = identityPersisted
          ? await rollbackPersistedIdentity(bus, startResult.agentId, error)
          : error;
        throw new SessionAgentAttachError('initial_message', attachError);
      });
    }
    return {
      agentId: startResult.agentId,
      adapterSessionId: startResult.adapterSessionId,
      role: input.identity.role,
      ...(turnInfo && { messageId: turnInfo.messageId, turnId: turnInfo.turnId }),
    };
  } finally {
    if (reservation !== undefined) turnManager.releaseTurnReservation(reservation);
  }
}

/**
 * Extract persona identity metadata from persona selections.
 * @param selection - Agent selection used for attach startup
 * @returns Persona identifier when the selection is persona-based
 */
function getPersonaId(selection: AgentSelectionBase): string | undefined {
  return selection.kind === 'persona' ? (selection as { personaId?: string }).personaId : undefined;
}

/**
 * Select explicit adapter fields before falling back to resolved agent metadata.
 * @param selection - Agent selection from the attach request
 * @param resolved - Host-resolved agent metadata, or null for direct adapter selections
 * @returns Candidate adapter name and instance ID for runtime resolution
 */
function resolveAdapterCandidate(
  selection: AgentSelectionBase,
  resolved: ResolvedAgentConfig | null,
): AdapterCandidate {
  return {
    adapterName:
      selection.kind === 'adapter' && 'adapterName' in selection
        ? (selection.adapterName as string | undefined)
        : resolved?.adapterName,
    adapterId:
      selection.kind === 'adapter' && 'adapterId' in selection
        ? (selection.adapterId as string | undefined)
        : undefined,
  };
}

/**
 * Resolves a concrete adapter target from the candidate adapter selection.
 *
 * At least one of `candidateAdapterName` or `candidateAdapterId` must be
 * non-empty; the function throws otherwise.
 *
 * When `candidateAdapterId` is provided, adapter storage is consulted to
 * obtain the canonical `adapterName`. If `candidateAdapterName` is also
 * provided and differs from the stored name, an error is thrown to prevent
 * silent identity mismatches (F7 guard).
 *
 * When only `candidateAdapterName` is provided, resolution falls back to the
 * name-based registry lookup via `resolveAdapterId`.
 * @param bus - Bus instance for adapter resolution
 * @param candidateAdapterName - Explicit or persona-resolved adapter name
 * @param candidateAdapterId - Explicit adapter instance UUID, bypasses name resolution when present
 * @param machineId - Optional machine ID for deterministic adapter resolution
 * @returns Resolved adapterName and adapterId
 */
async function resolveAdapterTarget(
  bus: IMakaioBus,
  candidateAdapterName: string | undefined,
  candidateAdapterId: string | undefined,
  machineId: string | undefined,
): Promise<{ adapterName: string; adapterId: string }> {
  const normalizedAdapterName = normalizeSelectionString(candidateAdapterName);
  const normalizedAdapterId = normalizeSelectionString(candidateAdapterId);

  if (!normalizedAdapterName && !normalizedAdapterId) {
    throw new Error(
      '[attach-handler] adapterName or adapterId is required — provide one explicitly or via persona/profile/virtualModel resolution',
    );
  }

  if (normalizedAdapterId) {
    const adapterName = await resolveAdapterNameById(
      bus,
      normalizedAdapterId,
      normalizedAdapterName,
      '[attach-handler] ',
    );
    return { adapterName, adapterId: normalizedAdapterId };
  }

  // At this point normalizedAdapterId is undefined and the early guard ensures
  // normalizedAdapterName is non-undefined — TS cannot narrow through thrown
  // guards at the top of the function, so we re-assert here to keep strict mode happy.
  const resolvedName = normalizedAdapterName as string;
  const adapterId = await resolveAdapterId(bus, resolvedName, machineId);
  return { adapterName: resolvedName, adapterId };
}

/**
 * Resolve the agent selection for attach-time startup.
 *
 * For `kind: 'adapter'`, no resolution is needed — adapter fields are passed
 * directly on the selection. For other kinds (persona, profile, virtual-model),
 * delegates to the host-tier `AgentResolutionSubjects.resolve` handler.
 * @param bus - Bus instance for resolution RPCs
 * @param sessionId - Session receiving the attached agent
 * @param initialMessage - Optional initial message used for prompt-aware resolution
 * @param selection - Agent selection from the attach request payload
 * @returns Resolved agent config fields, or `null` when kind is 'adapter'
 */
async function resolveAttachSelection(
  bus: IMakaioBus,
  sessionId: string,
  initialMessage: MessageInput | undefined,
  selection: AgentSelectionBase,
): Promise<ResolvedAgentConfig | null> {
  if (selection.kind === 'adapter') {
    return null;
  }
  const promptText = initialMessage ? extractTextContent(initialMessage) : undefined;
  return bus.request(AgentResolutionSubjects.resolve, {
    selection,
    context: { sessionId, promptText },
  });
}

/**
 * Validates session exists and is active.
 * @param bus - Bus instance for session lookup
 * @param sessionId - Target session ID
 * @returns The full session record
 */
async function validateSession(bus: IMakaioBus, sessionId: string): Promise<IMakaioSession> {
  const { session } = await bus.request(SessionSubjects.get, { sessionId });
  if (!session) throw new Error(`[attach-handler] Session not found: ${sessionId}`);
  if (session.status !== 'active') throw new Error(`[attach-handler] Session is not active: ${sessionId}`);
  return session;
}

/**
 * Determines agent role based on existing agents and requested role.
 * @param session - Current session with agents array
 * @param requestedRole - Explicitly requested role (optional)
 * @returns Resolved agent role
 */
function determineRole(session: { agents: unknown[] }, requestedRole?: AgentRole): AgentRole {
  const isFirstAgent = session.agents.length === 0;
  return requestedRole ?? (isFirstAgent ? 'lead' : 'member');
}
