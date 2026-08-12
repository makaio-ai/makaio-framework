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
  NativeLocalityVerdict,
  ResolvedAgentConfig,
} from '@makaio/contracts';
import { buildTurnInitiator, extractTextContent } from '../session-orchestrator-helpers.js';
import type { MachineScopedAdapterInstance } from '../utils/resolution.js';
import { resolveAttachAdapterTarget } from './attach-adapter-target.js';
import { resolveAttachProviderSelection } from './attach-provider-selection.js';
import type {
  AttachAgentParams,
  AttachLeadTransition,
  AttachLocalityResult,
  ResolvedAttachExecution,
} from './attach-execution-types.js';
import { assertSessionActiveAfterStart, dispatchInitialAttachMessage } from './attach-turn-tracking.js';
import { retireStartedAttach, startReservedAttachAgent } from './attach-start.js';
import { extractRuntimeOptions, mergeRuntimeOptions, resolveEffectiveAttachCwd } from './attach-runtime-options.js';
import { evaluateNativeLocality } from '../native-locality.js';
import { runExclusiveStart } from '../ownership/index.js';
import { resolveSessionResumeIdentity } from '../session-resume-identity.js';
import { emitLocalityDegradeEvent } from '../session-lifecycle-events.js';
import type { SessionTurnManager } from '../session-turn-manager.js';
import type { TurnReservation } from '../session-turn-manager.js';
import { AttachStartError, SessionAgentAttachError } from './attach-error.js';
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
 * Resolves the **structural** native locality verdict for a resume attach and
 * returns both the resume adapter session ID (present only for native) and the
 * session context to forward (present only for non-native).
 *
 * Queries the target adapter's `session:resume` capability via bus so that
 * adapters without native resume produce a `degrade('adapter-unsupported')`
 * verdict upfront, rather than relying solely on the downstream
 * `AIAgent.supportsNativeResume()` fallback.
 *
 * **Structural, and nothing more.** Whether the provider session is actually
 * free is decided by the reservation, in the transaction that takes it — never
 * here. The live-writer probe this function used to run could not decide the
 * case it existed for: an abandoned provider session is by definition the one no
 * live agent claims, so a probe accepts exactly the session a second writer must
 * not touch. Occupancy is now a compare-and-swap on the ownership key, and a
 * `native` verdict returned here can still degrade a step later.
 *
 * The provider session is resolved exactly once, through
 * {@link resolveSessionResumeIdentity}, and that single value feeds both roles
 * below: the locality evaluator's currency check (which degrades to
 * `adapter-session-moved` for an unconfirmed movement) and the resume target
 * returned to the caller. Reading `session.adapterSessionId` per role is what
 * previously let a resume target diverge from the session the locality verdict
 * was computed for.
 *
 * Currency is re-read here instead of taken from the validated snapshot the
 * caller loaded. Agent selection, adapter resolution, and provider resolution sit
 * between the two points, and a provider-session movement the lead agent
 * persisted during that window is already committed by the time locality is
 * decided — resolving it from the earlier snapshot resumes a thread the row no
 * longer advertises. Only currency is refreshed: the structural fields the
 * evaluator reads (machine, cwd, adapter identity) must stay consistent with the
 * `effectiveCwd` the caller derived from that same snapshot.
 * @param input - Bus for the capability lookup and currency re-read, resolved
 *   adapter instance ID, stable adapter type name, validated session record,
 *   local machine identity, and effective working directory for the locality evaluator
 * @returns Resolved resume adapter session ID and optional non-native session context
 */
async function resolveAttachLocality(input: {
  bus: IMakaioBus;
  instance: MachineScopedAdapterInstance;
  adapterName: string;
  session: IMakaioSession;
  effectiveCwd: string | undefined;
}): Promise<AttachLocalityResult> {
  const { bus, adapterName, session, effectiveCwd } = input;
  const { adapterId, machineId } = input.instance;
  // **The instance arrives with the machine it belongs to, or the attach never got
  // here.** An instance ID is a one-way hash of `(machineId, adapterName)`, so a
  // caller that hands over an instance and nothing else hands over an instance
  // without its owner — and {@link resolveAttachAdapterTarget} refuses that pair
  // outright rather than letting the attempt proceed under a guessed machine. So
  // the whole attach runs in one machine's namespace: the verdict below is
  // evaluated against it, and so are the reservation and the settlement.
  //
  // `machineId` can still be absent here, for the one shape that is honest about
  // it — a runtime with no machine identity at all, deriving an unscoped instance
  // for itself. The evaluator answers that with its own `missing-machine-id`
  // degrade, which is why this function no longer decides one of its own.

  // Independent reads: the session's own row and what the adapter can do.
  const [current, adapterCanResume] = await Promise.all([
    bus.request(SessionSubjects.get, { sessionId: session.sessionId }),
    adapterSupportsResume(bus, adapterId),
  ]);
  const resumeIdentity = resolveSessionResumeIdentity(current.session ?? session);
  const verdict = evaluateNativeLocality({
    intent: 'resume',
    session,
    localMachineId: machineId,
    adapterSupportsNative: adapterCanResume,
    targetAdapterName: adapterName,
    currentCwd: session.targetWorkingDirectory,
    targetCwd: effectiveCwd,
    resumeIdentity,
  });
  if (verdict.kind !== 'native') {
    return degradedAttachLocality(bus, session, adapterId, verdict);
  }
  return { resumeAdapterSessionId: resumeIdentity.adapterSessionId, attachSessionContext: undefined };
}

/**
 * Announce a non-native verdict and shape the context the attach seeds from.
 *
 * One place, so every non-native verdict is announced and carried the same way.
 * @param bus - Bus the event is emitted on.
 * @param session - Session the attach is for.
 * @param adapterId - Adapter instance the attach targets.
 * @param verdict - The non-native verdict the evaluator returned.
 * @returns The locality result: no resume target, and the verdict to seed with.
 */
function degradedAttachLocality(
  bus: IMakaioBus,
  session: IMakaioSession,
  adapterId: string,
  verdict: NativeLocalityVerdict,
): AttachLocalityResult {
  void emitLocalityDegradeEvent(bus, {
    sessionId: session.sessionId,
    intent: 'resume',
    verdict,
    adapterId,
  });
  return { resumeAdapterSessionId: undefined, attachSessionContext: { nativeLocality: verdict } };
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
  const { adapterName, instance } = await resolveAttachAdapterTarget(bus, {
    selection: agentSelection,
    resolved,
    sessionId,
    localMachineId: machineId,
  });

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
  const { role, leadTransition } = determineRole(session, requestedRole);
  const locality = await resolveAttachLocality({
    bus,
    session,
    effectiveCwd,
    instance,
    adapterName,
  });
  return executeResolvedAttach(bus, turnManager, {
    launch: {
      adapterId: instance.adapterId,
      sessionId,
      role,
      effectiveRuntimeOptions,
      harnessId: params.harnessId ?? resolved?.harnessId,
    },
    identity: {
      adapterName,
      sessionId,
      role,
      personaId: getPersonaId(agentSelection),
      profileId: resolved?.profileId,
      harnessId: params.harnessId ?? resolved?.harnessId,
      providerConfigId: mergedProviderConfigId,
      compressionMode: resolved?.compressionMode,
      model: mergedModel,
      cwd: effectiveCwd,
    },
    locality,
    expectedLeadAgentId: session.leadAgentId ?? null,
    leadTransition,
    instance,
    session,
    initialMessage,
    responseSchema,
    initiator: buildTurnInitiator(source, extensionId),
    assertAttachCommitAllowed: () => assertAttachCommitAllowed?.(),
    assertInitialMessageAdmission,
  });
}

/**
 * Mint the attach's agent identity and run the whole attempt under it.
 *
 * Attach becomes a caller-owned start here: it mints the identity, and from that
 * moment the row, the reservation and the dispatch all belong to it. The attempt
 * runs inside the in-flight-start seam for the *whole* of its life — start,
 * settlement, commit and initial turn — so there is no instant at which the
 * `starting` row it wrote is visible without an entry a concurrent consumer can
 * join instead of opening a second lifecycle beside it.
 * @param bus - Bus used for adapter lifecycle, persistence, and routing.
 * @param turnManager - Owner of session turn slots and completion state.
 * @param input - Fully resolved attach launch, identity, and message inputs.
 * @returns Attach response containing canonical turn identity when a message was dispatched.
 */
async function executeResolvedAttach(bus: IMakaioBus, turnManager: SessionTurnManager, input: ResolvedAttachExecution) {
  const agentId = crypto.randomUUID();
  let result: Awaited<ReturnType<typeof runAttachAttempt>> | undefined;
  await runExclusiveStart(agentId, async () => {
    result = await runAttachAttempt(bus, turnManager, agentId, input);
    // Every modeled attach refusal throws, so reaching here is a live connector.
    return 'connected';
  }).settled;
  if (result === undefined) {
    // Unreachable: the identity is minted here, so the seam has no existing
    // entry to hand back instead of running the attempt.
    throw new SessionAgentAttachError(
      'agent_attach',
      new Error(`[attach-handler] attach for agent ${agentId} produced no result`),
    );
  }
  return result;
}

/**
 * Start the resolved agent and dispatch an initial message through an exclusive turn reservation.
 *
 * Two stages, and the difference matters to the rollback. The start owns the
 * agent row and ends committed — the reserved start is complete the moment its
 * settlement is accepted. The initial turn is the *next* operation, and a
 * failure there unwinds a start that already succeeded: the claims are retired,
 * the connector is stopped, and the row goes to `dead` from wherever the
 * connector left it.
 * @param bus - Bus used for adapter lifecycle, persistence, and routing.
 * @param turnManager - Owner of session turn slots and completion state.
 * @param agentId - Caller-minted agent identity, already registered with the seam.
 * @param input - Fully resolved attach launch, identity, and message inputs.
 * @returns Attach response containing canonical turn identity when a message was dispatched.
 */
async function runAttachAttempt(
  bus: IMakaioBus,
  turnManager: SessionTurnManager,
  agentId: string,
  input: ResolvedAttachExecution,
) {
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
    let started;
    try {
      started = await startReservedAttachAgent(bus, {
        agentId,
        launch: input.launch,
        identity: input.identity,
        locality: input.locality,
        expectedLeadAgentId: input.expectedLeadAgentId,
        leadTransition: input.leadTransition,
        instance: input.instance,
      });
    } catch (error) {
      throw new SessionAgentAttachError('agent_attach', error);
    }
    const { startResult } = started;
    // **After the start completed, not inside it.** A close can land while the
    // provider is still starting, and the close handler cannot evict an agent
    // that had not entered the adapter registry yet — so the attach has to look
    // again. Looking *before* the settlement put a storage round trip between a
    // live connector and the claim on the key it confirmed, which is a window
    // for a second writer and, on failure, a retirement that never named that
    // key. Ordered behind the settlement, the same failure retires a start whose
    // key is held, through the teardown a committed start already has — and a
    // session that is *gone* rather than closed is reported by the settlement
    // itself, which releases the key cleanly.
    try {
      await assertSessionActiveAfterStart(bus, input.session.sessionId);
    } catch (error) {
      await retireStartedAttach(bus, started);
      throw new SessionAgentAttachError('agent_attach', error);
    }
    let turnInfo;
    if (reservation === undefined || input.initialMessage === undefined) {
      try {
        input.assertAttachCommitAllowed();
      } catch (error) {
        await retireStartedAttach(bus, started);
        throw new SessionAgentAttachError('agent_attach', error);
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
        started.sessionContext,
        assertAdmission,
      ).catch(async (error: unknown) => {
        await retireStartedAttach(bus, started);
        throw new SessionAgentAttachError('initial_message', error);
      });
    }
    return {
      agentId,
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
  if (session.status !== 'active') {
    throw new AttachStartError(
      'session-not-active',
      `[attach-handler] Session is not active: ${sessionId} (${session.status})`,
      'not-dispatched',
      undefined,
      session.status,
    );
  }
  return session;
}

/**
 * Determine role and designation semantics from distinct snapshot facts.
 *
 * Agent count selects the implicit role. Replacement, however, requires the
 * session's designated lead to be among the materialized agents: member-only
 * sessions and stale unmaterialized designations both receive their first real
 * lead and must retain it as the recovery target on a later failure.
 * @param session - Current session with agents array
 * @param requestedRole - Explicitly requested role (optional)
 * @returns Resolved role and the semantic designation transition it represents.
 */
function determineRole(
  session: Pick<IMakaioSession, 'agents' | 'leadAgentId'>,
  requestedRole?: AgentRole,
): AttachRoleDecision {
  const isFirstAgent = session.agents.length === 0;
  const role = requestedRole ?? (isFirstAgent ? 'lead' : 'member');
  const hasMaterializedLead =
    session.leadAgentId !== undefined && session.agents.some((agent) => agent.agentId === session.leadAgentId);
  return {
    role,
    leadTransition: role === 'member' ? 'none' : hasMaterializedLead ? 'replace' : 'fresh',
  };
}

/** Semantic attach role together with its designation transition. */
interface AttachRoleDecision {
  /** Role written onto the new agent row. */
  readonly role: AgentRole;
  /** Whether this attempt leaves designation untouched, creates it, or replaces it. */
  readonly leadTransition: AttachLeadTransition;
}
