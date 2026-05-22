/**
 * Handler for session.agent.attach RPC.
 *
 * Extracted from SessionOrchestrator for file size management.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentResolutionSubjects, SessionSubjects } from '@makaio/contracts';
import type {
  AdapterRuntimeOptions,
  AgentRole,
  AgentSelectionBase,
  AIReasoningLevel,
  CompressionMode,
  MessageInput,
  ProviderContext,
  ResolvedAgentConfig,
  StartAgentRequest,
} from '@makaio/contracts';
import { Turn } from '../entities/turn.js';
import { activateProviderContext } from '../../provider-context/index.js';
import { buildProviderContext, extractTextContent, resolveAdapterId } from '../session-orchestrator-helpers.js';
import { normalizeSelectionString, resolveAdapterNameById } from '../selection-utils.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { TurnStorageSubjects } from '../turns/index.js';

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
 * @param activeTurns - Shared turn state map
 * @param machineId - Optional machine ID for deterministic adapter resolution
 * @returns Cleanup function to unsubscribe
 */
export function registerAttachHandler(bus: IMakaioBus, activeTurns: Map<string, Turn>, machineId?: string): () => void {
  return bus.on(SessionSubjects.agent.attach, async (ctx) => {
    const { sessionId, agent: agentSelection, initialMessage, role: requestedRole } = ctx.payload;
    const explicitRuntime = extractRuntimeOptions(agentSelection);

    // Validate session before resolving any host-scoped selection state.
    const session = await validateSession(bus, sessionId);

    // Resolve agent selection: 'adapter' kind is handled inline; other kinds
    // are delegated to the host-tier AgentResolutionSubjects.resolve handler.
    // Project scope was removed from IMakaioSession in W1-A; host-tier handler
    // resolves scope from its own junction table when needed.
    const resolved = await resolveAttachSelection(bus, sessionId, initialMessage, agentSelection);

    // Merge explicit runtime fields with resolved values, then resolve to a concrete adapterId.
    const candidateAdapterName =
      agentSelection.kind === 'adapter' && 'adapterName' in agentSelection
        ? (agentSelection.adapterName as string | undefined)
        : resolved?.adapterName;
    // When the caller already knows the exact adapter instance (multi-host
    // topology), bypass the name-based storage lookup entirely.
    const candidateAdapterId =
      agentSelection.kind === 'adapter' && 'adapterId' in agentSelection
        ? (agentSelection.adapterId as string | undefined)
        : undefined;

    const { adapterName, adapterId } = await resolveAdapterTarget(
      bus,
      candidateAdapterName,
      candidateAdapterId,
      machineId,
    );

    const { providerConfigId: mergedProviderConfigId, providerContext } = await resolveAttachProviderSelection(
      bus,
      agentSelection.providerConfigId,
      resolved,
    );
    const { runtimeOptions, mergedModel, mergedCwd } = mergeRuntimeOptions(explicitRuntime, resolved, providerContext);
    const role = determineRole(session, requestedRole);
    const resumeAdapterSessionId = resolveResumeAdapterSessionId(session);

    const startAgentRequest = buildStartAgentRequest(
      adapterId,
      sessionId,
      initialMessage,
      role,
      runtimeOptions,
      resumeAdapterSessionId,
      resolved?.harnessId,
    );
    if (providerContext !== undefined) {
      await activateProviderContext(bus, providerContext);
    }
    const startResult = await bus.request(AdapterSubjects.startAgent, startAgentRequest);

    if (!startResult.success) {
      throw new Error(`[attach-handler] Failed to start agent: ${startResult.message}`);
    }

    // personaId is not in ResolvedAgentConfig — extract from the selection directly for kind: 'persona'.
    const personaId =
      agentSelection.kind === 'persona' ? (agentSelection as { personaId?: string }).personaId : undefined;

    const now = Date.now();
    await persistIdentityOrRollback(bus, startResult, {
      adapterName,
      sessionId,
      role,
      timestamp: now,
      personaId,
      profileId: resolved?.profileId,
      harnessId: resolved?.harnessId,
      providerConfigId: mergedProviderConfigId,
      compressionMode: resolved?.compressionMode,
      model: mergedModel,
      cwd: mergedCwd,
    });

    const turnInfo =
      initialMessage && startResult.messageId
        ? await setupTurnTracking(
            bus,
            activeTurns,
            sessionId,
            startResult.agentId,
            startResult.messageId,
            initialMessage,
          )
        : undefined;

    ctx.setResult({
      agentId: startResult.agentId,
      adapterSessionId: startResult.adapterSessionId,
      role,
      ...(turnInfo && { messageId: turnInfo.messageId, turnId: turnInfo.turnId }),
    });
  });
}

/** Runtime options plus model, providerContext, and reasoningEffort (top-level on startAgent but grouped here for convenience). */
type ExtractableRuntimeOptions = Partial<
  AdapterRuntimeOptions & { model: string; providerContext: ProviderContext; reasoningEffort: AIReasoningLevel }
>;

/** Result of merging explicit and resolved runtime options. */
type MergedRuntimeOptions = {
  runtimeOptions: ExtractableRuntimeOptions;
  mergedModel: string | undefined;
  mergedCwd: string | undefined;
};

/**
 * Extracts runtime options from agent selection base fields.
 * @param selection - Agent selection containing optional runtime override fields
 * @returns Filtered runtime options object
 */
function extractRuntimeOptions(selection: AgentSelectionBase): ExtractableRuntimeOptions {
  return {
    ...(selection.model !== undefined && { model: selection.model }),
    ...(selection.reasoningEffort !== undefined && { reasoningEffort: selection.reasoningEffort }),
    ...(selection.cwd !== undefined && { cwd: selection.cwd }),
    ...(selection.allowedTools !== undefined && { allowedTools: selection.allowedTools }),
    ...(selection.disallowedTools !== undefined && { disallowedTools: selection.disallowedTools }),
    ...(selection.allowedDirectories !== undefined && { allowedDirectories: selection.allowedDirectories }),
    ...(selection.systemPrompt !== undefined && { systemPrompt: selection.systemPrompt }),
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
 * Resolve the effective provider selection for attach-time agent startup.
 *
 * Converts the orchestration-level provider config ID into the runtime
 * provider execution context expected by the adapter boundary.
 * @param bus - Bus instance for provider resolution
 * @param explicitProviderConfigId - Provider config selected explicitly on the agent selection
 * @param resolved - Agent resolution result (persona/profile/virtualModel), or null for adapter kind
 * @returns Merged provider ID plus the resolved runtime provider context
 */
async function resolveAttachProviderSelection(
  bus: IMakaioBus,
  explicitProviderConfigId: string | undefined,
  resolved: ResolvedAgentConfig | null,
): Promise<{ providerConfigId: string | undefined; providerContext: ProviderContext | undefined }> {
  const providerConfigId = explicitProviderConfigId ?? resolved?.providerConfigId;
  const providerContext =
    providerConfigId !== undefined ? await buildProviderContext(bus, providerConfigId) : undefined;
  return { providerConfigId, providerContext };
}

/**
 * Removes keys whose value is `undefined` from an object literal.
 *
 * Avoids inline `...(x !== undefined && { key: x })` spread patterns that each
 * increment ESLint's complexity counter.
 * @param obj - Object potentially containing `undefined` values
 * @returns A new object with all `undefined`-valued keys omitted
 */
function omitUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Merges explicit runtime options with resolved provider execution context and agent-selection values.
 * Explicit fields take precedence over resolved values.
 * Only defined values are included in the returned options object.
 * @param explicit - Runtime options extracted directly from the agent selection
 * @param resolved - Resolved agent config from host-tier resolution (may be null for adapter kind)
 * @param providerContext - Resolved provider execution context
 * @returns Merged runtime options plus merged model and cwd for identity persistence
 */
function mergeRuntimeOptions(
  explicit: ExtractableRuntimeOptions,
  resolved: ResolvedAgentConfig | null,
  providerContext: ProviderContext | undefined,
): MergedRuntimeOptions {
  const mergedModel = explicit.model ?? resolved?.model;
  // cwd is explicit-only — ResolvedAgentConfig (persona/profile cascade) does
  // not carry a cwd field. The project's targetWorkingDirectory is resolved
  // separately by the orchestrator before attach.
  const mergedCwd = explicit.cwd;
  const runtimeOptions: ExtractableRuntimeOptions = omitUndefined({
    model: mergedModel,
    reasoningEffort: explicit.reasoningEffort ?? resolved?.reasoningEffort,
    cwd: mergedCwd,
    allowedTools: explicit.allowedTools ?? resolved?.allowedTools,
    disallowedTools: explicit.disallowedTools ?? resolved?.disallowedTools,
    allowedDirectories: explicit.allowedDirectories ?? resolved?.allowedDirectories,
    systemPrompt: explicit.systemPrompt ?? resolved?.systemPrompt,
    providerContext,
  });
  return { runtimeOptions, mergedModel, mergedCwd };
}

/** Fields from the session record needed by the attach handler. */
interface ValidatedSession {
  agents: unknown[];
  isImported?: boolean;
  isOrchestrated?: boolean;
  adapterSessionId?: string;
}

/**
 * Validates session exists and is active.
 * @param bus - Bus instance for session lookup
 * @param sessionId - Target session ID
 * @returns Session fields needed by the attach handler
 */
async function validateSession(bus: IMakaioBus, sessionId: string): Promise<ValidatedSession> {
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
 * Resolves the adapter session ID to use for native resume.
 *
 * Native resume is attempted only when:
 * - The session was imported from an external adapter (`isImported`)
 * - Makaio has explicitly marked the session as not orchestrated (`isOrchestrated === false`)
 * - The adapter session ID is known (`adapterSessionId`)
 *
 * When `isOrchestrated` is true, the adapter's history was modified by Makaio
 * and native resume would produce an inconsistent state.
 * @param session - Validated session fields
 * @returns The adapter session ID for resume mode, or undefined for fresh create
 */
function resolveResumeAdapterSessionId(session: ValidatedSession): string | undefined {
  if (session.isImported && session.isOrchestrated === false && session.adapterSessionId) {
    return session.adapterSessionId;
  }
  return undefined;
}

/**
 * Builds the startAgent request payload.
 *
 * When `resumeAdapterSessionId` is provided the request uses `mode: 'resume'`
 * so the adapter can attempt native session continuation rather than starting
 * a fresh context. If the adapter cannot honour the resume it falls back to
 * its default behaviour internally.
 *
 * For branching conversations, use session.fork to create a new session with
 * copied history, then attach agents to the new session.
 * @param adapterId - Target adapter ID
 * @param sessionId - Target session ID
 * @param initialMessage - Initial message content
 * @param role - Agent role
 * @param runtimeOptions - Runtime configuration options (may include model, providerContext, reasoningEffort)
 * @param resumeAdapterSessionId - Adapter session ID to resume (enables resume mode)
 * @param harnessId - Resolved harness ID for tool policy lookup
 * @returns StartAgentRequest payload
 */
function buildStartAgentRequest(
  adapterId: string,
  sessionId: string,
  initialMessage: MessageInput | undefined,
  role: AgentRole,
  runtimeOptions: ExtractableRuntimeOptions,
  resumeAdapterSessionId?: string,
  harnessId?: string,
): StartAgentRequest {
  if (resumeAdapterSessionId) {
    return {
      mode: 'resume',
      adapterId,
      sessionId,
      adapterSessionId: resumeAdapterSessionId,
      role,
      ...runtimeOptions,
      ...(initialMessage !== undefined && { initialMessage }),
      ...(harnessId !== undefined && { harnessId }),
    };
  }
  return {
    adapterId,
    sessionId,
    role,
    ...runtimeOptions,
    ...(initialMessage !== undefined && { initialMessage }),
    ...(harnessId !== undefined && { harnessId }),
  };
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
  params: {
    agentId: string;
    adapterId: string;
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
  },
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
  identity: {
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
  },
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
    try {
      await bus.request(AdapterSubjects.stopAgent, {
        adapterId: startResult.adapterId,
        agentId: startResult.agentId,
      });
    } catch (stopError) {
      console.error('[attach-handler] Failed to rollback started agent after identity persistence failure', {
        sessionId: identity.sessionId,
        agentId: startResult.agentId,
        adapterId: startResult.adapterId,
        error: stopError,
      });
    }
    throw error;
  }
}

/**
 * Sets up turn tracking and emits turn/message events.
 *
 * Persists the turn via storage to obtain a monotonic `turnNumber` before
 * emitting lifecycle events (which include `turnNumber` in their schema).
 * @param bus - Bus instance for event emission and storage
 * @param activeTurns - Shared turn state map
 * @param sessionId - Target session ID
 * @param agentId - Agent processing the message
 * @param messageId - User message ID
 * @param content - Message content
 * @returns Turn tracking info
 */
async function setupTurnTracking(
  bus: IMakaioBus,
  activeTurns: Map<string, Turn>,
  sessionId: string,
  agentId: string,
  messageId: string,
  content: MessageInput,
): Promise<{ messageId: string; turnId: string }> {
  const { turn: storedTurn } = await bus.request(TurnStorageSubjects.create, { sessionId });
  const turn = new Turn({
    sessionId,
    agentIds: [agentId],
    turnId: storedTurn.turnId,
    turnNumber: storedTurn.turnNumber,
  });
  turn.addMessage(messageId);
  activeTurns.set(sessionId, turn);

  await bus.emit(SessionSubjects.turn.started, {
    sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    messageId,
    agentIds: [...turn.agentIds],
  });
  await bus.emit(SessionSubjects.user_message.sent, {
    sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    messageId,
    content,
    agentIds: [...turn.agentIds],
  });
  await bus.emit(SessionSubjects.user_message.acknowledged, {
    sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    messageId,
    agentId,
  });

  return { messageId, turnId: turn.turnId };
}
