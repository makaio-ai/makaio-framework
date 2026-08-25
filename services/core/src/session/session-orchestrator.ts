import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import {
  SessionContextSchema,
  SessionSubjects,
  type AgentSelectionBase,
  type IMakaioSession,
  type MessageInput,
  type SessionContext,
} from '@makaio/contracts';
import { AdapterRegistry } from './adapter-registry.js';
import { MessageStorageSubjects } from './messages/index.js';
import { MessageRoutingSubjects } from './message-routing/index.js';
import { resolveInFlightStarts, type InFlightStartResolution } from './handlers/in-flight-start-join.js';
import { admitFreshStartTargets } from './handlers/deferred-agents.js';
import { convergeDeferrals } from './handlers/utils/deferral-convergence.js';
import { buildLeadStartRequest, type LeadTransition } from './handlers/lead-start-request.js';
import { startLeadAgent } from './handlers/lead-start.js';
import { SessionStartError } from './handlers/session-start-error.js';
import { SessionTurnManager, USER_MESSAGE_PERSISTENCE_FAILED_TURN_ERROR } from './session-turn-manager.js';
import type { TurnCompletionResult } from './turn-completion.js';
import { emitSessionTurnStarted, emitSessionUserMessageSent } from './session-lifecycle-events.js';
import { resolveFreshStartTarget, resolveInitialAdapterSelection } from './session-orchestrator-selection.js';

/** Log prefix every refusal this orchestrator's send path raises carries. */
const SEND_MESSAGE_CALLER = '[session.sendMessage]';

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
  buildTurnInitiator,
  extractTextContent,
  getOrCreateSession,
  normalizeToBlocks,
  resolveTargetAgents,
} from './session-orchestrator-helpers-core.js';
import type { Turn } from './entities/turn.js';
import { registerAttachHandler } from './handlers/attach-handler.js';
import { routeToAgentsCore } from './handlers/route-to-agents-core.js';

/** Coordinates session sends, recovery and turn completion. */
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

  /** Register the `session.sendMessage` RPC handler. */
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

        // 2b. A send that stated its targets — named ids or `'all'` — against a
        //     session that has none is already decided, so it is answered before
        //     the start below can leave an agent row and a provider reservation
        //     behind a send that never delivered. Only the default send may bring
        //     a session its first agent. Read *after* step 2, because an
        //     in-flight resolution can be what emptied the session — the send is
        //     then refused for that same reason, not started over on the caller's
        //     behalf. Targets that survive here are still validated after the
        //     recovery pass (§8.2a): existing is not the same as drivable.
        admitFreshStartTargets(SEND_MESSAGE_CALLER, resolvedSessionId, session, targetSpec);

        // 3. Start the lead agent if the session has no agents. A start that
        //    loses the designation race adopts the winner's agents instead, and
        //    those have never been through step 2 — so whatever it reports as
        //    needing recovery joins this send's own resolution.
        const recovering = new Set(inFlight.recoveringAgentIds);
        const arbitrated = new Set(inFlight.arbitratedAgentIds);
        const initialDeferred = new Set(inFlight.deferredAgentIds);
        if (session.agents.length === 0) {
          const adopted = await this.startLeadAgent(
            session,
            resolvedSessionId,
            agentSelection,
            message,
            sessionContext,
            { kind: 'fresh' },
          );
          for (const agentId of adopted.recoveringAgentIds) recovering.add(agentId);
          for (const agentId of adopted.arbitratedAgentIds) arbitrated.add(agentId);
          for (const agentId of adopted.deferredAgentIds) initialDeferred.add(agentId);
        }

        // 4. Resolve target agents
        const initialTargets = resolveTargetAgents(session, targetSpec);
        if (initialTargets.length === 0) {
          throw new Error(
            `[SessionOrchestrator.sendMessage] No valid target agents found (sessionId=${resolvedSessionId})`,
          );
        }

        const {
          targetAgents,
          deferredAgentIds: deferred,
          recoveryContext,
        } = await convergeDeferrals(
          {
            bus: this.bus,
            machineId: this.machineId,
            startReplacementLeadAgent: (selection) =>
              this.startLeadAgent(session, resolvedSessionId, selection, message, sessionContext, { kind: 'replace' }),
          },
          { session, sessionId: resolvedSessionId, targetSpec, agentSelection, message, sessionContext },
          initialTargets,
          recovering,
          arbitrated,
          initialDeferred,
        );

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

        // 9. Return result. The deferred set is reported when it is non-empty:
        //    a partial delivery a caller cannot detect is indistinguishable
        //    from the narrower send it never asked for.
        ctx.setResult({
          messageId,
          turnId: turn.turnId,
          sessionId: resolvedSessionId,
          ...(deferred.size > 0 && { deferredAgentIds: [...deferred] }),
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
   * @param leadTransition - Whether this start creates or replaces the durable lead.
   * @returns What the adopted agents need, empty unless a race was lost.
   */
  private async startLeadAgent(
    session: IMakaioSession,
    sessionId: string,
    agentSelection: AgentSelectionBase | undefined,
    message: MessageInput,
    sessionContext: SessionContext | undefined,
    leadTransition: LeadTransition,
  ): Promise<InFlightStartResolution> {
    const selection = await resolveInitialAdapterSelection(
      this.bus,
      agentSelection,
      sessionId,
      message,
      sessionContext,
    );
    const { adapterName, instance, providerContext, providerConfigId } = await resolveFreshStartTarget(
      this.bus,
      selection,
      { sessionId, machineId: this.machineId, registry: this.adapterRegistry },
    );

    const result = await startLeadAgent(this.bus, {
      sessionId,
      instance,
      adapterName,
      leadTransition,
      // The designation this send read may remain after in-flight resolution
      // drops its agent from the target set.
      expectedLeadAgentId: session.leadAgentId ?? null,
      ...(providerConfigId !== undefined && { providerConfigId }),
      startRequest: buildLeadStartRequest(selection, {
        adapterId: instance.adapterId,
        sessionId,
        providerContext,
        sessionContext,
      }),
    });

    if (result.outcome === 'started') {
      session.agents.push(result.agent);
      session.leadAgentId = result.agent.agentId;
      return {
        droppedAgentIds: new Set<string>(),
        recoveringAgentIds: new Set<string>(),
        deferredAgentIds: new Set<string>(),
        arbitratedAgentIds: new Set<string>(),
      };
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
}
