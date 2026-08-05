import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionContextSchema,
  SessionSubjects,
  type AgentSelectionBase,
  type IMakaioSession,
  type MakaioSessionAgent,
  type MessageInput,
  type SessionContext,
} from '@makaio/contracts';
import { AdapterRegistry } from './adapter-registry.js';
import { MessageStorageSubjects } from './messages/index.js';
import { MessageRoutingSubjects } from './message-routing/index.js';
import {
  recoverDeadAgentExclusively,
  resolveInFlightStarts,
  restoreProbedLiveAgent,
  type InFlightStartResolution,
} from './handlers/in-flight-start-join.js';
import {
  admitFreshStartTargets,
  dropDeferredAgents,
  refuseTotalDeferral,
  resolveSendTargetForm,
} from './handlers/deferred-agents.js';
import { buildLeadStartRequest, inheritAgentSelection } from './handlers/lead-start-request.js';
import { startLeadAgent } from './handlers/lead-start.js';
import { SessionStartError } from './handlers/session-start-error.js';
import { SessionTurnManager, USER_MESSAGE_PERSISTENCE_FAILED_TURN_ERROR } from './session-turn-manager.js';
import type { TurnCompletionResult } from './turn-completion.js';
import { emitSessionTurnStarted, emitSessionUserMessageSent } from './session-lifecycle-events.js';
import { normalizeSelectionString } from './selection-utils.js';
import { resolveInitialAdapterSelection, resolveSelectionAdapterName } from './session-orchestrator-selection.js';

/** Log prefix every refusal this orchestrator's send path raises carries. */
const SEND_MESSAGE_CALLER = '[session.sendMessage]';

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
  arbitratedAgentIds: new Set<string>(),
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

/** What re-resolving a send's targets after a deferral needs from the send. */
interface DeferralRetargetContext {
  /** Session being sent to; its agents are filtered in place. */
  readonly session: IMakaioSession;
  /** Resolved session identity. */
  readonly sessionId: string;
  /** The request's target spec, which decides how a total deferral degrades. */
  readonly targetSpec: string[] | 'all' | undefined;
  /** Agent selection from the request, when it named one. */
  readonly agentSelection: AgentSelectionBase | undefined;
  /** User message, used as canonical-model prompt context by a fresh start. */
  readonly message: MessageInput;
  /** Session context passed through to a fresh start. */
  readonly sessionContext: SessionContext | undefined;
}

/** What retargeting around a deferral left for the send to finish. */
interface DeferralRetargetResult {
  /** The targets that survive, after any fresh start the degrade required. */
  readonly targetAgents: MakaioSessionAgent[];
  /**
   * Agents a replacement start adopted that have not been through the recovery
   * step.
   *
   * A replacement that loses its own designation race adopts the winner's
   * agents, and those were never probed by this send — the same fact the
   * fresh-start branch consumes, arriving one step later.
   */
  readonly recovering: ReadonlySet<string>;
  /** Of those, the ones claimed by compare-and-swap against another process. */
  readonly arbitrated: ReadonlySet<string>;
  /** History for the replacement agent, when one was started. */
  readonly recoveryContext?: SessionContext;
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
 * 2b. Refuse a send that stated targets (named ids or `'all'`) against a session
 *    that has none — before the start below, so a refused send leaves no agent
 *    and no reservation; only the default send may bootstrap a session
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
   * 2b. Refuse a target-stating send (named ids or `'all'`) against a session
   *    with no agents, before the bootstrap can leave state behind a send that
   *    cannot deliver
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
        if (session.agents.length === 0) {
          const adopted = await this.startLeadAgent(
            session,
            resolvedSessionId,
            agentSelection,
            message,
            sessionContext,
          );
          addAll(recovering, adopted.recoveringAgentIds);
          addAll(arbitrated, adopted.arbitratedAgentIds);
        }

        // 4. Resolve target agents
        let targetAgents = resolveTargetAgents(session, targetSpec);
        if (targetAgents.length === 0) {
          throw new Error(
            `[SessionOrchestrator.sendMessage] No valid target agents found (sessionId=${resolvedSessionId})`,
          );
        }

        // 5. Verify agent liveness and recover the dead ones, reserved.
        const recovered = await this.recoverDeadTargets(session, targetAgents, recovering, arbitrated);
        const deferredAgentIds = recovered.deferredAgentIds;
        let recoveryContext = recovered.recoveryContext;

        // 5b. A deferral is a statement about ownership, so it has to reach the
        //     target set *before* admission and routing: adding the id to a
        //     bookkeeping set afterwards would still route the message to an
        //     agent storage has just said belongs to another generation.
        if (deferredAgentIds.size > 0) {
          const retargeted = await this.retargetAfterDeferral(
            { session, sessionId: resolvedSessionId, targetSpec, agentSelection, message, sessionContext },
            targetAgents,
            deferredAgentIds,
          );
          targetAgents = retargeted.targetAgents;
          recoveryContext = retargeted.recoveryContext ?? recoveryContext;
          // 5c. A replacement start that lost its designation race adopted
          //     agents this send has never probed. They go through the very
          //     step the fresh-start branch runs them through — reached from
          //     here because that branch is already behind us.
          if (retargeted.recovering.size > 0) {
            const adopted = await this.recoverDeadTargets(
              session,
              targetAgents,
              retargeted.recovering,
              retargeted.arbitrated,
            );
            if (adopted.deferredAgentIds.size > 0)
              refuseTotalDeferral(SEND_MESSAGE_CALLER, resolvedSessionId, adopted.deferredAgentIds);
            recoveryContext = adopted.recoveryContext ?? recoveryContext;
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

        // 9. Return result. The deferred set is reported when it is non-empty:
        //    a partial delivery a caller cannot detect is indistinguishable
        //    from the narrower send it never asked for.
        ctx.setResult({
          messageId,
          turnId: turn.turnId,
          sessionId: resolvedSessionId,
          ...(deferredAgentIds.size > 0 && { deferredAgentIds: [...deferredAgentIds] }),
        });
      }),
    );
  }

  /**
   * Probe this send's targets and recover the ones that are gone.
   *
   * **An agent whose in-flight start this send consumed *locally* needs no
   * probe; one it merely out-raced does.** The distinction is the evidence
   * behind the verdict. A locally joined attempt reported what it built, and
   * this process ran it. A won compare-and-swap reports only that this caller
   * wrote a status first: the attempt it outran belongs to a process this
   * runtime cannot see, and writing `dead` does not make the agent dead. Wave 3
   * cannot ask whether that process is alive (OQ-B, Wave 4) — but it can ask
   * whether a *connector* answers, which is what the probe already does for
   * every other target and the only instrument here that carries evidence
   * across processes. Skipping it there was the send believing its own status
   * write, and it is what let a second lifecycle open beside a live one.
   *
   * The framework orchestrator evaluates no locality, so it can make only one
   * honest recovery decision: the replacement connector starts fresh and the
   * stored conversation is injected. Holding it as a plan keeps the history
   * assembly and the rehydrate reading one decision — a host that later resumes
   * natively here changes that value alone and both sides follow.
   *
   * Each recovery is reserved and runs inside the in-flight-start seam, which
   * the entry-point inventory requires of every service-owned path that can
   * reach a lifecycle call for an *existing* agent identity: two concurrent
   * sends onto one dead agent would otherwise dispatch two rehydrates, and the
   * second would race the first's connector.
   * @param session - Session being sent to.
   * @param targetAgents - Targets this send materialised.
   * @param recovering - Agents whose in-flight start this send already claimed.
   * @param arbitrated - Of those, the ones claimed by compare-and-swap against another process.
   * @returns The injected history, when any agent needed it, and the agents this runtime may not drive.
   */
  private async recoverDeadTargets(
    session: IMakaioSession,
    targetAgents: readonly MakaioSessionAgent[],
    recovering: ReadonlySet<string>,
    arbitrated: ReadonlySet<string>,
  ): Promise<{ recoveryContext: SessionContext | undefined; deferredAgentIds: Set<string> }> {
    // **The probes first, together; the classification after.** Each asks one
    // adapter whether one agent's connector answers, and no answer depends on
    // another — so a session with N targets paid N round trips in series for a
    // question with no ordering in it. What follows *does* have an order: the
    // recoveries below are dispatched one at a time, deliberately.
    const probes = await Promise.all(
      targetAgents.map(async (agent) => {
        // An agent whose in-flight start this send consumed locally is not
        // probed at all: the attempt reported what it built, and this process
        // ran it.
        if (recovering.has(agent.agentId) && !arbitrated.has(agent.agentId)) return undefined;
        return this.bus.requestOptional(AdapterSubjects.getAgent, {
          agentId: agent.agentId,
          adapterId: agent.adapterId,
        });
      }),
    );

    const deadAgents: MakaioSessionAgent[] = [];
    for (const [index, agent] of targetAgents.entries()) {
      const liveness = probes[index];
      if (liveness === undefined) {
        deadAgents.push(agent);
        continue;
      }
      const answered = liveness.handled ? liveness.data.agent : undefined;
      if (arbitrated.has(agent.agentId)) {
        // The probe may only **veto** this recovery, never authorise skipping it.
        // A positive "a connector answers" is evidence the out-raced start
        // landed, and opening a second lifecycle beside it is the harm. Anything
        // else — no answer, an adapter that is gone, a null — leaves the
        // compare-and-swap's verdict standing, which is what recovers an agent
        // whose owning process really did die. Reading an unanswerable probe as
        // "alive" would trade the duplicate for a stranded agent nobody rebuilds.
        if (answered == null) {
          deadAgents.push(agent);
          continue;
        }
        // The veto also takes back the `dead` the arbitration wrote to claim
        // this recovery: nothing else can, and a live agent whose row says
        // otherwise is read as recoverable by every later consumer that does not
        // probe for itself.
        await restoreProbedLiveAgent(this.bus, agent.agentId);
        continue;
      }
      if (liveness.handled && answered === null) deadAgents.push(agent);
    }

    const deferredAgentIds = new Set<string>();
    if (deadAgents.length === 0) return { recoveryContext: undefined, deferredAgentIds };

    const recoveryPlan = FRESH_WITH_HISTORY_RECOVERY_PLAN;
    // Read before the recoveries, where it has always been: the ordering of this
    // read against the rehydrate dispatches is observable to a concurrent send
    // racing for the same turn, and nothing here needs it moved.
    const recoveryContext = await buildPlannedRecoveryContext(this.bus, session, recoveryPlan);
    const resumeProviderSessionId = recoveryPlanResumeTarget(recoveryPlan) ?? null;
    for (const agent of deadAgents) {
      const recovered = await recoverDeadAgentExclusively(this.bus, agent, {
        resumeProviderSessionId,
        machineId: this.machineId,
      });
      if (recovered.deferred) deferredAgentIds.add(agent.agentId);
    }

    // Returned only for agents that came back. The history is injected into
    // every target this send routes to, so handing it over when nothing was
    // recovered gives a live agent — one that never lost its connector — the
    // whole conversation again plus `isFirstTurn`. An all-deferred batch
    // recovered nobody, and the replacement the deferral path may start asks for
    // its own history there.
    if (deferredAgentIds.size === deadAgents.length) return { recoveryContext: undefined, deferredAgentIds };
    return { recoveryContext, deferredAgentIds };
  }

  /**
   * Re-resolve a send's targets around agents this runtime may not drive.
   *
   * The three send forms degrade differently, and the difference is deliberate:
   *
   * - **lead-default** — a deferred lead is always *total*, because target
   *   resolution raises for a session whose named lead it cannot resolve, so
   *   there is no state in which the default send proceeds with "the other
   *   usable agents". The session re-enters the fresh-start branch and gains a
   *   **new** lead agent, which the stored conversation is injected into. That
   *   is what fresh-with-history means once the old agent is owned elsewhere: a
   *   fresh *agent*, not a second connector bolted onto one this runtime does
   *   not own.
   * - **`'all'`** — deliver to the usable ones; a broadcast with no recipient
   *   is not a delivery and fails.
   * - **an explicit array** — deliver to the usable ones; a caller that named
   *   its agents gets a failure rather than a substitute, because substituting
   *   would answer a question nobody asked.
   * @param context - The send's identity, target spec and start inputs.
   * @param targetAgents - Targets as this send materialised them.
   * @param deferredAgentIds - Agents held by a generation this runtime does not own.
   * @returns The surviving targets, and what a replacement start left for the caller to finish.
   * @throws A {@link SessionStartError} when every target deferred and no fresh start applies.
   */
  private async retargetAfterDeferral(
    context: DeferralRetargetContext,
    targetAgents: readonly MakaioSessionAgent[],
    deferredAgentIds: ReadonlySet<string>,
  ): Promise<DeferralRetargetResult> {
    const { session, sessionId, targetSpec } = context;
    const deferredAgents = targetAgents.filter((agent) => deferredAgentIds.has(agent.agentId));
    const remaining = dropDeferredAgents(session, targetAgents, deferredAgentIds);
    // The survivors kept their connectors: they were never dead, so they need
    // neither recovery nor injected history.
    if (remaining.length > 0) {
      return {
        targetAgents: remaining,
        recovering: EMPTY_START_RESOLUTION.recoveringAgentIds,
        arbitrated: EMPTY_START_RESOLUTION.arbitratedAgentIds,
      };
    }
    if (resolveSendTargetForm(targetSpec) !== 'lead-default')
      refuseTotalDeferral(SEND_MESSAGE_CALLER, sessionId, deferredAgentIds);

    // The replacement inherits the deferred lead's own adapter identity unless
    // the caller named a selection: the send asked to continue this
    // conversation, and answering it with a differently-configured agent would
    // be a second unasked-for substitution on top of the first.
    const adopted = await this.startLeadAgent(
      session,
      sessionId,
      context.agentSelection ?? inheritAgentSelection(deferredAgents[0]),
      context.message,
      context.sessionContext,
    );
    const restarted = resolveTargetAgents(session, targetSpec);
    if (restarted.length === 0) refuseTotalDeferral(SEND_MESSAGE_CALLER, sessionId, deferredAgentIds);
    // A fresh *agent* continuing the old conversation is what fresh-with-history
    // means here, so this replacement is exactly the case that wants the stored
    // history injected — the only one left once every dead target deferred.
    return {
      targetAgents: restarted,
      recovering: adopted.recoveringAgentIds,
      arbitrated: adopted.arbitratedAgentIds,
      recoveryContext: await buildPlannedRecoveryContext(this.bus, session, FRESH_WITH_HISTORY_RECOVERY_PLAN),
    };
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
    const selection = await resolveInitialAdapterSelection(
      this.bus,
      agentSelection,
      sessionId,
      message,
      sessionContext,
    );
    const adapterName = await resolveSelectionAdapterName(this.bus, selection, sessionId);
    // When the caller already knows the exact adapter instance (multi-host
    // topology), bypass the name-based registry lookup entirely.
    const namedAdapterId = normalizeSelectionString(selection.adapterId);
    const adapterId = namedAdapterId ?? (await this.adapterRegistry.resolveAvailable(adapterName, this.machineId));
    // **Named alongside the instance, or not at all.** An instance ID is a
    // one-way hash of `(machineId, adapterName)`, so the machine an ownership
    // act names has to be the one its instance was derived from. Resolved here,
    // that is this runtime's — passed to the resolution *and* to the start, so
    // the two provably agree. Supplied by the caller, the owning machine is not
    // recoverable from the ID and this runtime must not invent one: it leaves
    // the authority to act under its own identity, exactly as before, and a
    // caller targeting another machine's instance carries the pre-existing
    // exposure rather than a newly minted mis-keyed claim.
    const startMachineId = namedAdapterId === undefined ? this.machineId : undefined;
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
      ...(startMachineId !== undefined && { machineId: startMachineId }),
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
}
