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
  CompressionMode,
  IMakaioSession,
  MessageInput,
  ProviderContext,
  ResolvedAgentConfig,
  SessionContext,
} from '@makaio/contracts';
import { extractTextContent, resolveAdapterId } from '../session-orchestrator-helpers.js';
import { normalizeSelectionString, resolveAdapterNameById } from '../selection-utils.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { resolveAttachProviderSelection } from './attach-provider-selection.js';
import { dispatchInitialAttachMessage, stopStartedAgentAfterFailure } from './attach-turn-tracking.js';
import {
  extractRuntimeOptions,
  launchAttachAgent,
  mergeRuntimeOptions,
  resolveEffectiveAttachCwd,
  type LaunchAttachAgentInput,
} from './attach-runtime-options.js';
import { evaluateNativeLocality } from '../native-locality.js';
import { seedAttachContextWithHistory } from '../context/seed-attach-context.js';
import { emitLocalityDegradeEvent } from '../session-lifecycle-events.js';
import type { SessionTurnManager } from '../session-turn-manager.js';
import type { TurnReservation } from '../session-turn-manager.js';

/** Identity metadata persisted after an attach agent starts. */
interface AttachIdentity {
  adapterName: string;
  sessionId: string;
  role: AgentRole;
  timestamp: number;
  personaId?: string;
  profileId?: string;
  harnessId?: string;
  providerConfigId?: string;
  compressionMode?: CompressionMode;
  model?: string;
  cwd?: string;
}

/** Fully resolved inputs for starting and optionally dispatching an attach turn. */
interface ResolvedAttachExecution {
  launch: LaunchAttachAgentInput;
  identity: AttachIdentity;
  session: IMakaioSession;
  initialMessage: MessageInput | undefined;
  sessionContext: SessionContext | undefined;
}

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
  const attachCleanup = bus.on(SessionSubjects.agent.attach, async (ctx) => {
    ctx.setResult(await attachAgent(bus, turnManager, machineId, ctx.payload));
  });
  const attachResolvedCleanup = bus.on(SessionSubjects.agent.attachResolved, async (ctx) => {
    if (!ctx.origin.local) {
      throw new Error('[attach-handler] session.agent.attachResolved requires a local-origin request');
    }
    ctx.setResult(
      await attachAgent(bus, turnManager, machineId, {
        ...ctx.payload,
        resolvedProviderContext:
          ctx.payload.agent.providerContext === undefined
            ? undefined
            : ProviderContextSchema.parse(ctx.payload.agent.providerContext),
      }),
    );
  });

  return () => {
    attachCleanup();
    attachResolvedCleanup();
  };
}

interface AttachAgentParams {
  readonly sessionId: string;
  readonly agent: AgentSelectionBase;
  readonly initialMessage?: MessageInput;
  readonly role?: AgentRole;
  readonly resolvedProviderContext?: ProviderContext;
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
  const { sessionId, agent: agentSelection, initialMessage, role: requestedRole, resolvedProviderContext } = params;
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
      harnessId: resolved?.harnessId,
      attachSessionContext,
    },
    identity: {
      adapterName,
      sessionId,
      role,
      timestamp: Date.now(),
      personaId: getPersonaId(agentSelection),
      profileId: resolved?.profileId,
      harnessId: resolved?.harnessId,
      providerConfigId: mergedProviderConfigId,
      compressionMode: resolved?.compressionMode,
      model: mergedModel,
      cwd: effectiveCwd,
    },
    session,
    initialMessage,
    sessionContext: attachSessionContext,
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
  const reservation: TurnReservation | undefined =
    input.initialMessage === undefined ? undefined : await turnManager.reserveTurn(input.session.sessionId);
  try {
    const startResult = await launchAttachAgent(bus, input.launch);
    await persistIdentityOrRollback(bus, startResult, input.identity);
    const turnInfo =
      reservation === undefined || input.initialMessage === undefined
        ? undefined
        : await dispatchInitialAttachMessage(
            bus,
            turnManager,
            reservation,
            startResult,
            input.session,
            input.initialMessage,
            input.sessionContext,
          );
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

/**
 * Persists agent identity fields (personaId, profileId, harnessId, providerConfigId) to agent storage.
 *
 * No-ops when none of the identity fields are set, matching the invariant
 * that only agents with resolved persona/profile/harness/provider configuration need
 * an identity record for downstream services and recovery.
 *
 * Persisted fields in this function are:
 * `agentId`, `adapterId`, `adapterName`, `sessionId`, `role`, `status`,
 * `personaId`, `profileId`, `harnessId`, `providerConfigId`, `createdAt`, `lastActivityAt`, and
 * optional `model`, `cwd`, `compressionMode`.
 *
 * Tool/approval configuration (for example `allowedTools` / `disallowedTools`)
 * stays in runtime adapter options and is intentionally not persisted by this
 * function. Bare-attach agents (no personaId, profileId, harnessId, or providerConfigId) skip
 * this function entirely, so identity fields remain absent on their
 * `MakaioSessionAgent` record.
 * @param bus - Bus instance for storage RPC
 * @param params - Agent identity parameters including resolved persona/profile/harness IDs
 */
async function persistAgentIdentity(
  bus: IMakaioBus,
  params: AttachIdentity & { agentId: string; adapterId: string },
): Promise<void> {
  if (!params.personaId && !params.profileId && !params.harnessId && !params.providerConfigId) return;
  await bus.request(AgentStorageSubjects.set, {
    agentId: params.agentId,
    agent: {
      agentId: params.agentId,
      adapterId: params.adapterId,
      adapterName: params.adapterName,
      sessionId: params.sessionId,
      role: params.role,
      status: 'idle',
      personaId: params.personaId,
      profileId: params.profileId,
      harnessId: params.harnessId,
      providerConfigId: params.providerConfigId,
      createdAt: params.timestamp,
      lastActivityAt: params.timestamp,
      ...(params.model !== undefined && { model: params.model }),
      ...(params.cwd !== undefined && { cwd: params.cwd }),
      ...(params.compressionMode !== undefined && { compressionMode: params.compressionMode }),
    },
  });
}

/**
 * Persist identity metadata and rollback the started adapter agent on failure.
 * @param bus - Bus instance for persistence and rollback calls
 * @param startResult - startAgent response with adapter/agent IDs
 * @param identity - Identity payload to persist
 */
async function persistIdentityOrRollback(
  bus: IMakaioBus,
  startResult: { agentId: string; adapterId: string },
  identity: AttachIdentity,
): Promise<void> {
  try {
    await persistAgentIdentity(bus, {
      agentId: startResult.agentId,
      adapterId: startResult.adapterId,
      adapterName: identity.adapterName,
      sessionId: identity.sessionId,
      role: identity.role,
      timestamp: identity.timestamp,
      personaId: identity.personaId,
      profileId: identity.profileId,
      harnessId: identity.harnessId,
      providerConfigId: identity.providerConfigId,
      compressionMode: identity.compressionMode,
      model: identity.model,
      cwd: identity.cwd,
    });
  } catch (error) {
    console.error('[attach-handler] Failed to persist agent identity, rolling back started agent', {
      sessionId: identity.sessionId,
      agentId: startResult.agentId,
      adapterId: startResult.adapterId,
      error,
    });
    await stopStartedAgentAfterFailure(bus, startResult, identity.sessionId, 'identity persistence failure');
    throw error;
  }
}
