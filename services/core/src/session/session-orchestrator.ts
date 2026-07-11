import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  CanonicalModelSubjects,
  SessionContextSchema,
  SessionSubjects,
  type AdapterSelection,
  type AgentSelectionBase,
  type CanonicalModelSelection,
  type MessageInput,
  type SessionContext,
  isCanonicalModelParseError,
  parseCanonicalModel,
} from '@makaio/contracts';
import { AdapterRegistry } from './adapter-registry.js';
import { MessageStorageSubjects } from './messages/index.js';
import { MessageRoutingSubjects } from './message-routing/index.js';
import { AgentStorageSubjects } from './storage/agent-namespace.js';
import { SessionTurnManager, USER_MESSAGE_PERSISTENCE_FAILED_TURN_ERROR } from './session-turn-manager.js';
import type { TurnCompletionResult } from './turn-completion.js';
import { emitSessionTurnStarted, emitSessionUserMessageSent } from './session-lifecycle-events.js';
import { normalizeSelectionString, resolveAdapterNameById } from './selection-utils.js';

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
  buildRecoveryContext,
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
 * 2. Start agent if session has no agents — resolves the canonical
 *    `adapterName` from direct selections, uses `adapterId` directly when
 *    provided, otherwise resolves it via `AdapterRegistry`, resolves
 *    provider credentials when selected, then calls `AdapterSubjects.startAgent`
 * 3. Resolve target agents (via `resolveTargetAgents`)
 * 4. Verify agent liveness and build recovery context for dead agents
 *    (requestOptional `AdapterSubjects.getAgent` + `buildRecoveryContext`)
 * 5. Get or create turn (via `SessionTurnManager`)
 * 6. Generate message ID and store user message (awaited, persist-before-route)
 *    + routing records (fire-and-forget)
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
   * 2. Start agent if session has no agents (canonicalize direct selections,
   *    resolve adapterId, resolve provider credentials, startAgent)
   * 3. Resolve target agents
   * 4. Verify agent liveness and build recovery context for dead agents
   * 5. Get or create turn (via SessionTurnManager)
   * 6. Generate message ID and store user message (awaited) + routing records (fire-and-forget)
   * 7. Emit turn.started + user_message.sent
   * 8. Route to agents (routeToAgentsCore, single shared context)
   * 9. Return result with messageId, turnId, sessionId
   */
  // eslint-disable-next-line max-lines-per-function -- Core message routing, steps are interdependent
  private registerSendMessageHandler(): void {
    this.cleanups.push(
      // eslint-disable-next-line max-lines-per-function, complexity -- Core message routing, steps are interdependent
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

        // 2. Start agent if session has no agents
        if (session.agents.length === 0) {
          const adapterKindSelection = await this.resolveInitialAdapterSelection(
            agentSelection,
            resolvedSessionId,
            message,
            sessionContext,
          );
          const adapterName = await this.resolveAdapterName(adapterKindSelection, resolvedSessionId);
          // When the caller already knows the exact adapter instance (multi-host
          // topology), bypass the name-based registry lookup entirely.
          const adapterId =
            normalizeSelectionString(adapterKindSelection.adapterId) ??
            (await this.adapterRegistry.resolveAvailable(adapterName));
          const providerContext =
            adapterKindSelection.providerConfigId !== undefined
              ? await resolveRuntimeProviderContext(this.bus, {
                  adapterName,
                  providerConfigId: adapterKindSelection.providerConfigId,
                })
              : undefined;
          const providerConfigId = adapterKindSelection.providerConfigId ?? providerContext?.providerConfigId;
          const startResult = await this.bus.request(AdapterSubjects.startAgent, {
            adapterId,
            sessionId: resolvedSessionId,
            role: 'lead',
            ...(providerContext !== undefined && { providerContext }),
            ...(adapterKindSelection.model !== undefined && { model: adapterKindSelection.model }),
            ...(adapterKindSelection.reasoningEffort !== undefined && {
              reasoningEffort: adapterKindSelection.reasoningEffort,
            }),
            ...(adapterKindSelection.cwd !== undefined && { cwd: adapterKindSelection.cwd }),
            ...(adapterKindSelection.systemPrompt !== undefined && { systemPrompt: adapterKindSelection.systemPrompt }),
            ...(adapterKindSelection.allowedTools !== undefined && { allowedTools: adapterKindSelection.allowedTools }),
            ...(adapterKindSelection.disallowedTools !== undefined && {
              disallowedTools: adapterKindSelection.disallowedTools,
            }),
            ...(adapterKindSelection.env !== undefined && { env: adapterKindSelection.env }),
            ...(adapterKindSelection.mcpSessionContext !== undefined && {
              mcpSessionContext: adapterKindSelection.mcpSessionContext,
            }),
            ...(adapterKindSelection.allowedDirectories !== undefined && {
              allowedDirectories: adapterKindSelection.allowedDirectories,
            }),
            ...(adapterKindSelection.adapterConfig !== undefined && {
              adapterConfig: adapterKindSelection.adapterConfig,
            }),
            ...(sessionContext !== undefined && { sessionContext }),
          });

          if (!startResult.success) {
            throw new Error(
              `[SessionOrchestrator.sendMessage] Failed to start agent (sessionId=${resolvedSessionId}, adapterName=${adapterName}): ${startResult.message}`,
            );
          }

          const now = Date.now();
          session.agents.push({
            agentId: startResult.agentId,
            adapterId: startResult.adapterId,
            adapterName,
            sessionId: resolvedSessionId,
            role: 'lead',
            status: 'idle',
            ...(providerConfigId !== undefined && {
              providerConfigId,
            }),
            createdAt: now,
            lastActivityAt: now,
          });
          session.leadAgentId = startResult.agentId;
          if (providerConfigId !== undefined) {
            await this.bus.requestOptional(AgentStorageSubjects.updateRuntime, {
              agentId: startResult.agentId,
              providerConfigId,
            });
          }
        }

        // 3. Resolve target agents
        const targetAgents = resolveTargetAgents(session, targetSpec);
        if (targetAgents.length === 0) {
          throw new Error(
            `[SessionOrchestrator.sendMessage] No valid target agents found (sessionId=${resolvedSessionId})`,
          );
        }

        // 4. Verify agent liveness and build recovery context for dead agents
        const deadAgentIds = new Set<string>();
        for (const agent of targetAgents) {
          const livenessResult = await this.bus.requestOptional(AdapterSubjects.getAgent, {
            agentId: agent.agentId,
            adapterId: agent.adapterId,
          });
          if (livenessResult.handled && livenessResult.data.agent === null) {
            deadAgentIds.add(agent.agentId);
          }
        }

        let recoveryContext: SessionContext | undefined;
        if (deadAgentIds.size > 0) {
          recoveryContext = await buildRecoveryContext(this.bus, session);
          // Rehydrate dead agents — reconnects the connector, no-op when unhandled
          for (const agent of targetAgents) {
            if (!deadAgentIds.has(agent.agentId)) continue;
            await this.bus.requestOptional(AdapterSubjects.rehydrateAgent, {
              agentId: agent.agentId,
              adapterId: agent.adapterId,
            });
          }
        }

        // 5. Generate one stable message identity before acquiring/preparing.
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
