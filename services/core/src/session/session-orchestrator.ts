import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  CanonicalModelSubjects,
  SessionContextSchema,
  SessionSubjects,
  type AdapterSelection,
  type AgentSelectionBase,
  type CanonicalModelSelection,
  type IMakaioSession,
  type MessageInput,
  type ResolvedProviderContext,
  type SessionContext,
  type StartAgentRequest,
  isCanonicalModelParseError,
  parseCanonicalModel,
} from '@makaio/contracts';
import { AdapterRegistry } from './adapter-registry.js';
import { MessageStorageSubjects } from './messages/index.js';
import { MessageRoutingSubjects } from './message-routing/index.js';
import {
  recoverDeadAgentExclusively,
  resolveInFlightStarts,
  type InFlightStartResolution,
} from './handlers/in-flight-start-join.js';
import { startLeadAgent } from './handlers/lead-start.js';
import { SessionStartError } from './handlers/session-start-error.js';
import { SessionTurnManager, USER_MESSAGE_PERSISTENCE_FAILED_TURN_ERROR } from './session-turn-manager.js';
import type { TurnCompletionResult } from './turn-completion.js';
import { emitSessionTurnStarted, emitSessionUserMessageSent } from './session-lifecycle-events.js';
import { normalizeSelectionString, resolveAdapterNameById } from './selection-utils.js';

/**
 * Fold one agent-id set into another, in place.
 * @param target - Set that accumulates.
 * @param source - Ids to add.
 */
function addAll(target: Set<string>, source: ReadonlySet<string>): void {
  for (const value of source) target.add(value);
}

/**
 * A resolution that adopted nothing — the ordinary start, which introduces one
 * agent it just created and therefore has nothing to re-resolve.
 */
const EMPTY_START_RESOLUTION: InFlightStartResolution = {
  droppedAgentIds: new Set<string>(),
  recoveringAgentIds: new Set<string>(),
};

/**
 * Minimum public contract for a session orchestrator service.
 *
 * Both the framework orchestrator and host-provided orchestrators can satisfy
 * this interface. The service token is keyed on this
 * interface so the conditional injection pattern (same service name, different
 * implementation per runtime) compiles without structural conflicts.
 */
export interface ISessionOrchestrator {
  /** Stop the orchestrator and clean up all subscriptions. */
  destroy(): void;
}
import {
  buildPlannedRecoveryContext,
  buildTurnInitiator,
  extractTextContent,
  getOrCreateSession,
  normalizeToBlocks,
  resolveTargetAgents,
} from './session-orchestrator-helpers-core.js';
import type { Turn } from './entities/turn.js';
import { registerAttachHandler } from './handlers/attach-handler.js';
import { routeToAgentsCore } from './handlers/route-to-agents-core.js';
import { resolveRuntimeProviderContext } from '../provider-context/index.js';
import { FRESH_WITH_HISTORY_RECOVERY_PLAN, recoveryPlanResumeTarget } from './recovery-plan.js';

/** Identity and context a lead start carries independently of the selection. */
interface LeadStartDispatchContext {
  /** Live adapter instance the start is dispatched to. */
  adapterId: string;
  /** Session the agent is started into. */
  sessionId: string;
  /** Resolved provider credentials, when the selection named a provider config. */
  providerContext: ResolvedProviderContext | undefined;
  /** Session context passed through from the request. */
  sessionContext: SessionContext | undefined;
}

/**
 * Compose the `adapter.startAgent` payload for a fresh lead start.
 *
 * Every field is forwarded only when the selection actually carries it: the
 * adapter distinguishes "not requested" from "requested as undefined", and a
 * blanket spread would turn the first into the second for every option the
 * caller left alone. The agent identity is deliberately absent — the reserving
 * start mints and persists it before dispatching.
 * @param selection - Direct adapter selection resolved for this start.
 * @param context - Identity and context the selection does not carry.
 * @returns The dispatch payload, complete but for the agent identity.
 */
function buildLeadStartRequest(selection: AdapterSelection, context: LeadStartDispatchContext): StartAgentRequest {
  return {
    adapterId: context.adapterId,
    sessionId: context.sessionId,
    role: 'lead',
    ...(context.providerContext !== undefined && { providerContext: context.providerContext }),
    ...(context.sessionContext !== undefined && { sessionContext: context.sessionContext }),
    ...(selection.model !== undefined && { model: selection.model }),
    ...(selection.reasoningEffort !== undefined && { reasoningEffort: selection.reasoningEffort }),
    ...(selection.cwd !== undefined && { cwd: selection.cwd }),
    ...(selection.systemPrompt !== undefined && { systemPrompt: selection.systemPrompt }),
    ...(selection.allowedTools !== undefined && { allowedTools: selection.allowedTools }),
    ...(selection.disallowedTools !== undefined && { disallowedTools: selection.disallowedTools }),
    ...(selection.env !== undefined && { env: selection.env }),
    ...(selection.mcpSessionContext !== undefined && { mcpSessionContext: selection.mcpSessionContext }),
    ...(selection.allowedDirectories !== undefined && { allowedDirectories: selection.allowedDirectories }),
    ...(selection.adapterConfig !== undefined && { adapterConfig: selection.adapterConfig }),
  };
}

/**
 * Slim framework session orchestrator.
 *
 * Composes with `SessionTurnManager` (turn lifecycle, usage accumulation,
 * completion), `AdapterRegistry` (adapterName to adapterId mapping), and the
 * adapter-subsystem reverse lookup for canonical `adapterId` to `adapterName`
 * validation when callers select a direct adapter instance.
 *
 * Registers the core session orchestration handlers:
 * 1. Get or create session (via `getOrCreateSession`)
 * 2. Resolve any start the session has in flight (via `resolveInFlightStarts`),
 *    before anything probes an agent or concludes the session has none
 * 3. Start the lead agent if the session has no agents — resolves the canonical
 *    `adapterName` from direct selections, uses `adapterId` directly when
 *    provided, otherwise resolves it via `AdapterRegistry`, resolves provider
 *    credentials when selected, then runs the reserved start (via
 *    `startLeadAgent`)
 * 4. Resolve target agents (via `resolveTargetAgents`)
 * 5. Verify agent liveness and recover dead agents under one recovery plan
 *    (requestOptional `AdapterSubjects.getAgent` + `buildPlannedRecoveryContext`)
 * 6. Get or create turn (via `SessionTurnManager`), generate the message ID and
 *    store the user message (awaited, persist-before-route) + routing records
 *    (fire-and-forget)
 * 7. Emit `session.turn.started` + `session.user_message.sent`
 * 8. Route to agents (via `routeToAgentsCore`, single shared context)
 * 9. Return result with `messageId`, `turnId`, `sessionId`
 *
 * Explicit `session.agent.attach` handlers share the same turn manager so
 * attach-time initial messages participate in the same completion lifecycle.
 *
 * Host-specific features (personas, MCP, execution targets, container spawn,
 * connector swap, CWD/model enforcement, fork context, TurnContextEnricher) are
 * handled by a host-provided orchestrator.
 * @example
 * ```typescript
 * const orchestrator = new SessionOrchestrator(MakaioBus, 'machine-id');
 *
 * const { messageId, turnId, sessionId } = await MakaioBus.request(
 *   SessionSubjects.sendMessage,
 *   { sessionId: crypto.randomUUID(), adapterName: 'openai-node', message: 'Hello!' },
 * );
 * ```
 */
export class SessionOrchestrator implements ISessionOrchestrator {
  private readonly turnManager: SessionTurnManager;
  private readonly adapterRegistry: AdapterRegistry;
  private readonly machineId: string;

  /** Cleanup functions for bus subscriptions. */
  private readonly cleanups: Array<() => void> = [];

  /**
   * @param bus - Event bus used for handler registration and message routing
   * @param machineId - Stable machine identity forwarded to the attach handler
   *   to drive native-locality decisions (resume locality evaluation, adapter
   *   instance resolution).
   */
  public constructor(
    // Defaulted `bus` before required `machineId` looks inverted, but every
    // call site passes both explicitly; TypeScript still enforces machineId.
    // Reordering would churn all construction sites for no behavioral gain.
    private readonly bus: IMakaioBus = MakaioBus,
    machineId: string,
  ) {
    this.machineId = machineId;
    this.turnManager = new SessionTurnManager(bus);
    this.adapterRegistry = new AdapterRegistry(bus);
    this.cleanups.push(registerAttachHandler(this.bus, this.turnManager, machineId));
    this.registerSendMessageHandler();
    this.turnManager.registerCompletionHandlers(this.completeTurn.bind(this));
  }

  // ---------------------------------------------------------------------------
  // Handler registration
  // ---------------------------------------------------------------------------

  /**
   * Register the `session.sendMessage` RPC handler.
   *
   * Core flow:
   * 1. Get or create session
   * 2. Join or arbitrate every start the session has in flight
   * 3. Start the lead agent if the session has no agents (canonicalize direct
   *    selections, resolve adapterId, resolve provider credentials, reserved start)
   * 4. Resolve target agents
   * 5. Verify agent liveness and recover dead agents under one recovery plan
   * 6. Get or create turn (via SessionTurnManager), generate the message ID and
   *    store the user message (awaited) + routing records (fire-and-forget)
   * 7. Emit turn.started + user_message.sent
   * 8. Route to agents (routeToAgentsCore, single shared context)
   * 9. Return result with messageId, turnId, sessionId
   */
  // eslint-disable-next-line max-lines-per-function -- Core message routing, steps are interdependent
  private registerSendMessageHandler(): void {
    this.cleanups.push(
      // eslint-disable-next-line max-lines-per-function -- Core message routing, steps are interdependent
      this.bus.on(SessionSubjects.sendMessage, async (ctx) => {
        const {
          sessionId,
          message,
          agentIds: targetSpec,
          deliveryMode,
          agent: agentSelection,
          source,
          origin,
        } = ctx.payload;
        // Validate early — buildTurnInitiator throws for invalid extension source,
        // and must run before any session/agent side effects.
        const initiator = buildTurnInitiator(source, ctx.payload.extensionId);
        const sessionContext = ctx.payload.sessionContext
          ? SessionContextSchema.parse(ctx.payload.sessionContext)
          : undefined;

        // 1. Get or create session
        const { sessionId: resolvedSessionId, session } = await getOrCreateSession(
          this.bus,
          sessionId,
          sessionContext,
          ctx.payload.originWindowId,
          this.machineId,
        );

        // 2. Resolve every start this session has in flight, before anything
        //    probes an agent or decides the session has none (§4.5).
        const inFlight = await resolveInFlightStarts(this.bus, session);

        // 3. Start the lead agent if the session has no agents. A start that
        //    loses the designation race adopts the winner's agents instead, and
        //    those have never been through step 2 — so whatever it reports as
        //    needing recovery joins this send's own resolution.
        const recovering = new Set(inFlight.recoveringAgentIds);
        if (session.agents.length === 0) {
          const adopted = await this.startLeadAgent(
            session,
            resolvedSessionId,
            agentSelection,
            message,
            sessionContext,
          );
          addAll(recovering, adopted.recoveringAgentIds);
        }

        // 4. Resolve target agents
        const targetAgents = resolveTargetAgents(session, targetSpec);
        if (targetAgents.length === 0) {
          throw new Error(
            `[SessionOrchestrator.sendMessage] No valid target agents found (sessionId=${resolvedSessionId})`,
          );
        }

        // 5. Verify agent liveness and build recovery context for dead agents.
        // An agent whose in-flight start this send already claimed needs no
        // probe: the row says `dead` because this caller wrote it there.
        const deadAgentIds = new Set<string>();
        for (const agent of targetAgents) {
          if (recovering.has(agent.agentId)) {
            deadAgentIds.add(agent.agentId);
            continue;
          }
          const livenessResult = await this.bus.requestOptional(AdapterSubjects.getAgent, {
            agentId: agent.agentId,
            adapterId: agent.adapterId,
          });
          if (livenessResult.handled && livenessResult.data.agent === null) {
            deadAgentIds.add(agent.agentId);
          }
        }

        // The framework orchestrator evaluates no locality, so it can make only
        // one honest recovery decision: the replacement connector starts fresh
        // and the stored conversation is injected. Holding it as a plan keeps
        // the history assembly and the rehydrate call reading one decision — a
        // host that later resumes natively here changes this value alone, and
        // both sides follow.
        const recoveryPlan = FRESH_WITH_HISTORY_RECOVERY_PLAN;
        let recoveryContext: SessionContext | undefined;
        if (deadAgentIds.size > 0) {
          recoveryContext = await buildPlannedRecoveryContext(this.bus, session, recoveryPlan);
          const resumeAdapterSessionId = recoveryPlanResumeTarget(recoveryPlan);
          // Rehydrate dead agents — reconnects the connector, no-op when
          // unhandled. Routed through the in-flight-start seam, which the
          // entry-point inventory requires of every service-owned path that can
          // reach a lifecycle call for an *existing* agent identity: two
          // concurrent sends onto one dead agent would otherwise dispatch two
          // rehydrates for it, and the second would race the first's connector.
          for (const agent of targetAgents) {
            if (!deadAgentIds.has(agent.agentId)) continue;
            await recoverDeadAgentExclusively(this.bus, agent, resumeAdapterSessionId);
          }
        }

        // 6. Generate one stable message identity before acquiring/preparing.
        // The append is awaited so the user message row is durable before the
        // turn events fire and before routing starts: `session.turn.completed`
        // promises the full turn is queryable via `storage:message.getByTurn`
        // (four-point consumer contract), and the completion barrier only
        // covers assistant messages — ordering here is what guarantees the
        // user side. A missing or failed storage append aborts routing so
        // completion cannot advertise a turn whose user message is not queryable.
        const messageId = crypto.randomUUID();

        const normalizedBlocks = normalizeToBlocks(message);
        const admission = await this.turnManager.acquireMessageAdmission(
          resolvedSessionId,
          targetAgents.map((agent) => agent.agentId),
          messageId,
          initiator,
          ctx.payload.turnId,
        );
        const turn = admission.turn;
        try {
          const appendResult = await this.bus.requestOptional(MessageStorageSubjects.append, {
            message: {
              messageId,
              turnId: turn.turnId,
              sessionId: resolvedSessionId,
              role: 'user',
              contentText: extractTextContent(message),
              blocks: normalizedBlocks,
              timestamp: Date.now(),
              ...(origin !== undefined && { origin }),
            },
          });
          if (!appendResult.handled) throw new Error('Message storage append handler is not registered');
          if (admission.isPreparationOwner) {
            await emitSessionTurnStarted(this.bus, {
              sessionId: resolvedSessionId,
              turnId: turn.turnId,
              turnNumber: turn.turnNumber,
              messageId,
              agentIds: [...turn.agentIds],
              initiator: turn.initiator,
              ingestionMarker: 'live',
            });
          }
          await emitSessionUserMessageSent(this.bus, {
            sessionId: resolvedSessionId,
            turnId: turn.turnId,
            turnNumber: turn.turnNumber,
            messageId,
            content: message,
            agentIds: targetAgents.map((agent) => agent.agentId),
            ...(source !== undefined && { source }),
            ...(origin !== undefined && { origin }),
          });
          admission.commit();
        } catch (error: unknown) {
          try {
            await admission.rollback(USER_MESSAGE_PERSISTENCE_FAILED_TURN_ERROR);
          } catch (cleanupError) {
            console.error('[SessionOrchestrator] Failed to finalize rejected message setup:', cleanupError);
          }
          throw error;
        }

        for (const agent of targetAgents) {
          void this.bus
            .requestOptional(MessageRoutingSubjects.record, {
              messageId,
              agentId: agent.agentId,
              status: 'sent',
              timestamp: Date.now(),
            })
            .catch((error: unknown) => {
              console.warn('[SessionOrchestrator] Failed to record message routing', {
                sessionId: resolvedSessionId,
                messageId,
                agentId: agent.agentId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }

        // 7. Route to agents with shared session context
        // Merge recovery fields (messageHistory, isFirstTurn) over the caller's
        // context so that turnContext and other session context fields are preserved.
        const routingContext = recoveryContext ? { ...sessionContext, ...recoveryContext } : sessionContext;
        await routeToAgentsCore(
          this.bus,
          session,
          targetAgents,
          message,
          messageId,
          turn,
          deliveryMode,
          this.completeTurn.bind(this),
          this.turnManager,
          routingContext,
          ctx.payload.responseSchema,
        );

        // 9. Return result
        ctx.setResult({
          messageId,
          turnId: turn.turnId,
          sessionId: resolvedSessionId,
        });
      }),
    );
  }

  /**
   * Start the session's lead agent, reserved and in the order §7.1 prescribes.
   *
   * Only the adapter selection is resolved here; the reordered start itself —
   * mint the identity, register the attempt, persist the row, reserve, dispatch,
   * settle, transition — lives in `startLeadAgent` so this class keeps only the
   * selection knowledge that is genuinely orchestrator-owned.
   *
   * A lost designation race is not an error: the session now has the winner's
   * agent, and this send continues against it. Only a session that *still* has
   * no agents after the re-read has nothing to send to.
   * @param session - Session being sent to; its agents and lead are updated in place.
   * @param sessionId - Resolved session identity.
   * @param agentSelection - Public agent selection from the request.
   * @param message - User message, used as canonical-model prompt context.
   * @param sessionContext - Session context passed through to the adapter.
   * @returns What the adopted agents need, empty unless a race was lost.
   */
  private async startLeadAgent(
    session: IMakaioSession,
    sessionId: string,
    agentSelection: AgentSelectionBase | undefined,
    message: MessageInput,
    sessionContext: SessionContext | undefined,
  ): Promise<InFlightStartResolution> {
    const selection = await this.resolveInitialAdapterSelection(agentSelection, sessionId, message, sessionContext);
    const adapterName = await this.resolveAdapterName(selection, sessionId);
    // When the caller already knows the exact adapter instance (multi-host
    // topology), bypass the name-based registry lookup entirely.
    const adapterId =
      normalizeSelectionString(selection.adapterId) ?? (await this.adapterRegistry.resolveAvailable(adapterName));
    const providerContext =
      selection.providerConfigId !== undefined
        ? await resolveRuntimeProviderContext(this.bus, { adapterName, providerConfigId: selection.providerConfigId })
        : undefined;
    const providerConfigId = selection.providerConfigId ?? providerContext?.providerConfigId;

    const result = await startLeadAgent(this.bus, {
      sessionId,
      adapterId,
      adapterName,
      // What this send actually read. A session can reach the fresh-start branch
      // with a designation still standing — the in-flight resolution drops an
      // agent from the target set without touching the lead it may have been.
      expectedLeadAgentId: session.leadAgentId ?? null,
      ...(providerConfigId !== undefined && { providerConfigId }),
      startRequest: buildLeadStartRequest(selection, { adapterId, sessionId, providerContext, sessionContext }),
    });

    if (result.outcome === 'started') {
      session.agents.push(result.agent);
      session.leadAgentId = result.agent.agentId;
      return EMPTY_START_RESOLUTION;
    }

    const { session: reread } = await this.bus.request(SessionSubjects.get, { sessionId });
    if (!reread || reread.agents.length === 0) {
      throw new SessionStartError(
        'lead-conflict',
        `[SessionOrchestrator.sendMessage] lead designation for session ${sessionId} was won by ${result.currentLeadAgentId ?? 'another start'}, which left no agent behind`,
      );
    }
    session.agents = reread.agents;
    session.leadAgentId = reread.leadAgentId;

    // The winner designated *before* it dispatched, so the agent this send just
    // adopted is very likely still `starting`. It has to go through the same
    // consumer rule every other agent did: without it the liveness probe finds
    // no connector, reads that as dead, and opens a second lifecycle against a
    // start that is still running — in another process, where this runtime's
    // registry cannot see it and only the status compare-and-swap can arbitrate.
    const adopted = await resolveInFlightStarts(this.bus, session);
    if (session.agents.length === 0) {
      throw new SessionStartError(
        'lead-conflict',
        `[SessionOrchestrator.sendMessage] lead designation for session ${sessionId} was won by ${result.currentLeadAgentId ?? 'another start'}, whose agent did not survive its start`,
      );
    }
    return adopted;
  }

  // ---------------------------------------------------------------------------
  // Turn completion
  // ---------------------------------------------------------------------------

  /**
   * Complete a turn by delegating to `SessionTurnManager`.
   *
   * Called by `routeToAgentsCore` error handling and by the turn manager's
   * own `agent.complete` listener (registered via `registerCompletionHandlers`).
   * @param turn - The turn to complete
   * @param result - Turn result (success status and error messages)
   */
  private async completeTurn(turn: Turn, result: TurnCompletionResult): Promise<void> {
    await this.turnManager.completeTurn(turn, result);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Stop the orchestrator and clean up all subscriptions and composition utilities.
   */
  public destroy(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.length = 0;
    this.turnManager.destroy();
    this.adapterRegistry.destroy();
  }

  /**
   * Resolve the adapter name for a direct adapter selection.
   *
   * Adapter startup and persisted identity require a stable adapter name.
   * When the caller provides `adapterId`, the framework validates any explicit
   * name against the adapter-subsystem reverse lookup and otherwise backfills the
   * canonical adapter name from that subsystem-owned mapping.
   * @param selection - Direct adapter selection
   * @param sessionId - Session ID used in error messages
   * @returns Resolved adapter name
   */
  private async resolveAdapterName(selection: AdapterSelection, sessionId: string): Promise<string> {
    const explicitAdapterName = normalizeSelectionString(selection.adapterName);
    const adapterId = normalizeSelectionString(selection.adapterId);

    if (!explicitAdapterName && !adapterId) {
      throw new Error(
        `[SessionOrchestrator.sendMessage] adapterName or adapterId required when session has no agents (sessionId=${sessionId})`,
      );
    }

    if (adapterId) {
      return resolveAdapterNameById(
        this.bus,
        adapterId,
        explicitAdapterName,
        `[SessionOrchestrator.sendMessage] (sessionId=${sessionId}) `,
      );
    }

    return explicitAdapterName as string;
  }

  /**
   * Resolve the public agent selection into the direct adapter shape required
   * by the framework orchestrator's startup path.
   * @param selection - Public session agent selection from the request.
   * @param sessionId - Session ID used for context and diagnostics.
   * @param message - User message used as canonical-model prompt context.
   * @param sessionContext - Optional session context passed through the request.
   * @returns Direct adapter selection for `adapter.startAgent`.
   */
  private async resolveInitialAdapterSelection(
    selection: AgentSelectionBase | undefined,
    sessionId: string,
    message: MessageInput,
    sessionContext: SessionContext | undefined,
  ): Promise<AdapterSelection> {
    if (!selection) {
      throw new Error(
        `[SessionOrchestrator.sendMessage] agent selection required when session has no agents (sessionId=${sessionId})`,
      );
    }

    if (selection.kind === 'adapter') {
      return selection as AdapterSelection;
    }

    if (selection.kind === 'canonical-model') {
      return await this.resolveCanonicalModelSelection(
        selection as CanonicalModelSelection,
        sessionId,
        message,
        sessionContext,
      );
    }

    throw new Error(
      `[SessionOrchestrator.sendMessage] agent with kind: 'adapter' or 'canonical-model' required when session has no agents (sessionId=${sessionId})`,
    );
  }

  /**
   * Resolve a framework-owned canonical-model selection to a direct adapter selection.
   * @param selection - Canonical model selection from the session request.
   * @param sessionId - Session ID used for context and diagnostics.
   * @param message - User message used as canonical-model prompt context.
   * @param sessionContext - Optional session context passed through the request.
   * @returns Direct adapter selection with resolved adapter, provider config, and model.
   */
  private async resolveCanonicalModelSelection(
    selection: CanonicalModelSelection,
    sessionId: string,
    message: MessageInput,
    sessionContext: SessionContext | undefined,
  ): Promise<AdapterSelection> {
    const parsed = parseCanonicalModel(selection.model);
    if (isCanonicalModelParseError(parsed)) {
      throw new Error(
        `[SessionOrchestrator.sendMessage] Invalid canonical model "${selection.model}" (sessionId=${sessionId}): ${parsed.message}`,
      );
    }

    if (parsed.kind === 'virtual') {
      throw new Error(
        `[SessionOrchestrator.sendMessage] Virtual canonical models require a host resolver (sessionId=${sessionId})`,
      );
    }

    const resolved = await this.bus.request(CanonicalModelSubjects.resolve, {
      parsed,
      context: {
        sessionId,
        promptText: extractTextContent(message),
        ...(sessionContext !== undefined ? { sessionContext } : {}),
      },
    });

    return {
      ...selection,
      ...resolved,
      kind: 'adapter',
      providerConfigId: selection.providerConfigId ?? resolved.providerConfigId,
    };
  }
}
