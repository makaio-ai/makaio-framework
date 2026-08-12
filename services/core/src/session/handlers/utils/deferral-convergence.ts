import type { IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  type AgentSelectionBase,
  type IMakaioSession,
  type MakaioSessionAgent,
  type MessageInput,
  type SessionContext,
} from '@makaio/contracts';
import { buildPlannedRecoveryContext } from '../../session-orchestrator-helpers-core.js';
import { resolveTargetAgents } from '../../session-orchestrator-helpers-core.js';
import { FRESH_WITH_HISTORY_RECOVERY_PLAN, recoveryPlanResumeTarget } from '../../recovery-plan.js';
import {
  MAX_JOINED_REFRESH_PASSES,
  recoverDeadAgentExclusively,
  restoreProbedLiveAgent,
  type InFlightStartResolution,
} from '../in-flight-start-join.js';
import { dropDeferredAgents, refuseTotalDeferral, resolveSendTargetForm } from '../deferred-agents.js';
import { inheritAgentSelection } from '../lead-start-request.js';
import { SessionStartError } from '../session-start-error.js';

/** Log prefix every refusal this orchestrator's send path raises carries. */
const SEND_MESSAGE_CALLER = '[session.sendMessage]';

/** Dependencies whose ownership remains with the orchestrator. */
export interface DeferralConvergenceDependencies {
  /** Bus used for liveness probes, recovery and context assembly. */
  readonly bus: IMakaioBus;
  /** Stable identity of the runtime completing this send. */
  readonly machineId: string;
  /** Replaces the deferred lead using the orchestrator's selection policy. */
  readonly startReplacementLeadAgent: (
    agentSelection: AgentSelectionBase | undefined,
  ) => Promise<InFlightStartResolution>;
}

/** Inputs that remain fixed while one send converges around deferrals. */
export interface DeferralConvergenceContext {
  /** Session being sent to; deferred agents are removed in place. */
  readonly session: IMakaioSession;
  /** Resolved session identity. */
  readonly sessionId: string;
  /** Request target specification, which determines total-deferral policy. */
  readonly targetSpec: string[] | 'all' | undefined;
  /** Agent selection from the request, when it named one. */
  readonly agentSelection: AgentSelectionBase | undefined;
  /** User message, used by a replacement start's selection. */
  readonly message: MessageInput;
  /** Context passed through to a replacement start. */
  readonly sessionContext: SessionContext | undefined;
}

/** The settled send targets and provenance left after convergence. */
export interface DeferralConvergenceResult {
  /** The targets this runtime may safely admit and route. */
  readonly targetAgents: MakaioSessionAgent[];
  /** Every original or later target this send deferred. */
  readonly deferredAgentIds: ReadonlySet<string>;
  /** Recovery history to merge into routing context, when recovery required it. */
  readonly recoveryContext: SessionContext | undefined;
}

/** A resolution that adopted nothing. */
const EMPTY_START_RESOLUTION: InFlightStartResolution = {
  droppedAgentIds: new Set<string>(),
  recoveringAgentIds: new Set<string>(),
  deferredAgentIds: new Set<string>(),
  arbitratedAgentIds: new Set<string>(),
};

/**
 * Fold one agent-id set into another, in place.
 * @param target - Set that accumulates.
 * @param source - Ids to add.
 */
function addAll(target: Set<string>, source: ReadonlySet<string>): void {
  for (const value of source) target.add(value);
}

/**
 * Keep only ids this send still targets.
 * @param ids - Ids to filter.
 * @param targetAgents - Current targets.
 * @returns The ids that remain targeted.
 */
function targetAgentIds(ids: ReadonlySet<string>, targetAgents: readonly MakaioSessionAgent[]): Set<string> {
  const targets = new Set(targetAgents.map((agent) => agent.agentId));
  return new Set([...ids].filter((agentId) => targets.has(agentId)));
}

/** The recovery provenance that remains after target filtering. */
interface RecoveryProvenance {
  readonly recovering: Set<string>;
  readonly arbitrated: Set<string>;
}

/**
 * Preserve recovery provenance only for agents that remain in this send.
 * @param recovering - Recovering agent ids.
 * @param arbitrated - Compare-and-swap recovery ids.
 * @param targetAgents - Current targets.
 * @returns Recovery provenance narrowed to current targets.
 */
function retainRecoveryProvenance(
  recovering: ReadonlySet<string>,
  arbitrated: ReadonlySet<string>,
  targetAgents: readonly MakaioSessionAgent[],
): RecoveryProvenance {
  const remainingRecovering = targetAgentIds(recovering, targetAgents);
  return {
    recovering: remainingRecovering,
    arbitrated: new Set(
      [...targetAgentIds(arbitrated, targetAgents)].filter((agentId) => remainingRecovering.has(agentId)),
    ),
  };
}

/** What retargeting around a deferral left for the send to finish. */
interface DeferralRetargetResult {
  readonly targetAgents: MakaioSessionAgent[];
  readonly recovering: ReadonlySet<string>;
  readonly arbitrated: ReadonlySet<string>;
  readonly deferred: ReadonlySet<string>;
  readonly recoveryContext?: SessionContext;
}

/** The direct outcome of the liveness and exclusive-recovery pass. */
interface TargetRecoveryResult {
  readonly recoveryContext: SessionContext | undefined;
  readonly deferredAgentIds: Set<string>;
}

/**
 * Consume one whole-session deferral convergence pass.
 *
 * A replacement start can itself adopt a guarded winner, and a recovered
 * target can defer after its reservation. Both observations are the same
 * contention signal at different points in the send, so one bound covers the
 * two loops rather than allowing them to extend each other indefinitely.
 * @param passes - Convergence passes already consumed by this send.
 * @param sessionId - Session whose target set failed to settle.
 * @returns The consumed-pass count for the next convergence step.
 * @throws A {@link SessionStartError} when the target set remains contested.
 */
function consumeConvergencePass(passes: number, sessionId: string): number {
  if (passes >= MAX_JOINED_REFRESH_PASSES) {
    throw new SessionStartError(
      'start-unresolved',
      `[session.start] session ${sessionId} did not stabilize after ${MAX_JOINED_REFRESH_PASSES} deferral convergence passes`,
    );
  }
  return passes + 1;
}

/**
 * Resolve every deferral and recovery a send encounters before routing it.
 * @param dependencies - Orchestrator-owned operations used by the convergence.
 * @param context - Immutable send inputs and the mutable session target list.
 * @param initialTargets - Targets materialized before any deferral pass.
 * @param initialRecovering - In-flight starts this send already adopted.
 * @param initialArbitrated - Adopted starts claimed by compare-and-swap.
 * @param initialDeferredAgentIds - Deferrals reported before the first probe.
 * @returns The safe routing targets, cumulative deferrals and recovery context.
 */
export async function convergeDeferrals(
  dependencies: DeferralConvergenceDependencies,
  context: DeferralConvergenceContext,
  initialTargets: MakaioSessionAgent[],
  initialRecovering: ReadonlySet<string>,
  initialArbitrated: ReadonlySet<string>,
  initialDeferredAgentIds: ReadonlySet<string>,
): Promise<DeferralConvergenceResult> {
  let targetAgents = initialTargets;
  let recovering = new Set(initialRecovering);
  let arbitrated = new Set(initialArbitrated);
  const deferred = targetAgentIds(initialDeferredAgentIds, targetAgents);
  let recoveryContext: SessionContext | undefined;
  let pendingDeferrals = new Set(deferred);
  let convergencePasses = 0;

  while (pendingDeferrals.size > 0) {
    convergencePasses = consumeConvergencePass(convergencePasses, context.sessionId);
    const retargeted = await retargetAfterDeferral(dependencies, context, targetAgents, pendingDeferrals, deferred);
    targetAgents = retargeted.targetAgents;
    ({ recovering, arbitrated } = retainRecoveryProvenance(recovering, arbitrated, targetAgents));
    addAll(recovering, retargeted.recovering);
    addAll(arbitrated, targetAgentIds(retargeted.arbitrated, targetAgents));
    arbitrated = new Set([...targetAgentIds(arbitrated, targetAgents)].filter((agentId) => recovering.has(agentId)));
    addAll(deferred, targetAgentIds(retargeted.deferred, targetAgents));
    recoveryContext = retargeted.recoveryContext ?? recoveryContext;
    pendingDeferrals = targetAgentIds(retargeted.deferred, targetAgents);
  }

  const recovered = await recoverDeadTargets(dependencies, context.session, targetAgents, recovering, arbitrated);
  addAll(deferred, recovered.deferredAgentIds);
  recoveryContext = recovered.recoveryContext ?? recoveryContext;
  recovering = new Set<string>();
  arbitrated = new Set<string>();
  pendingDeferrals = targetAgentIds(recovered.deferredAgentIds, targetAgents);

  while (pendingDeferrals.size > 0) {
    convergencePasses = consumeConvergencePass(convergencePasses, context.sessionId);
    const retargeted = await retargetAfterDeferral(dependencies, context, targetAgents, pendingDeferrals, deferred);
    targetAgents = retargeted.targetAgents;
    ({ recovering, arbitrated } = retainRecoveryProvenance(recovering, arbitrated, targetAgents));
    addAll(recovering, retargeted.recovering);
    addAll(arbitrated, targetAgentIds(retargeted.arbitrated, targetAgents));
    arbitrated = new Set([...targetAgentIds(arbitrated, targetAgents)].filter((agentId) => recovering.has(agentId)));
    addAll(deferred, targetAgentIds(retargeted.deferred, targetAgents));
    recoveryContext = retargeted.recoveryContext ?? recoveryContext;
    if (recovering.size > 0) {
      const adopted = await recoverDeadTargets(dependencies, context.session, targetAgents, recovering, arbitrated);
      addAll(deferred, adopted.deferredAgentIds);
      recoveryContext = adopted.recoveryContext ?? recoveryContext;
      pendingDeferrals = targetAgentIds(adopted.deferredAgentIds, targetAgents);
      recovering = new Set<string>();
      arbitrated = new Set<string>();
    } else {
      pendingDeferrals = targetAgentIds(retargeted.deferred, targetAgents);
    }
  }

  return { targetAgents, deferredAgentIds: deferred, recoveryContext };
}

/**
 * Probe this send's targets and recover the ones that are gone.
 * @param dependencies - Bus and runtime identity used by recovery.
 * @param session - Session being sent to.
 * @param targetAgents - Targets this send materialized.
 * @param recovering - Agents whose in-flight start this send already claimed.
 * @param arbitrated - Of those, the ones claimed against another process.
 * @returns The injected history and agents this runtime may not drive.
 */
async function recoverDeadTargets(
  dependencies: DeferralConvergenceDependencies,
  session: IMakaioSession,
  targetAgents: readonly MakaioSessionAgent[],
  recovering: ReadonlySet<string>,
  arbitrated: ReadonlySet<string>,
): Promise<TargetRecoveryResult> {
  const probes = await Promise.all(
    targetAgents.map(async (agent) => {
      if (agent.runtimeOwner === undefined) return undefined;
      if (recovering.has(agent.agentId) && !arbitrated.has(agent.agentId)) return undefined;
      return dependencies.bus.requestOptional(AdapterSubjects.getAgent, {
        agentId: agent.agentId,
        adapterId: agent.adapterId,
        ownerInstanceId: agent.runtimeOwner.instanceId,
      });
    }),
  );
  const deadAgents: MakaioSessionAgent[] = [];
  const deferredAgentIds = new Set<string>();
  for (const [index, agent] of targetAgents.entries()) {
    if (agent.runtimeOwner === undefined) {
      deferredAgentIds.add(agent.agentId);
      continue;
    }
    const liveness = probes[index];
    if (liveness === undefined) {
      deadAgents.push(agent);
      continue;
    }
    const answered = liveness.handled ? liveness.data.agent : undefined;
    if (arbitrated.has(agent.agentId)) {
      if (answered == null) {
        deadAgents.push(agent);
        continue;
      }
      await restoreProbedLiveAgent(dependencies.bus, agent.agentId);
      continue;
    }
    if (!liveness.handled || answered === null) deadAgents.push(agent);
  }
  if (deadAgents.length === 0) return { recoveryContext: undefined, deferredAgentIds };
  const recoveryPlan = FRESH_WITH_HISTORY_RECOVERY_PLAN;
  const recoveryContext = await buildPlannedRecoveryContext(dependencies.bus, session, recoveryPlan);
  const resumeProviderSessionId = recoveryPlanResumeTarget(recoveryPlan) ?? null;
  let recoveredAgentCount = 0;
  for (const agent of deadAgents) {
    const recovered = await recoverDeadAgentExclusively(dependencies.bus, agent, {
      resumeProviderSessionId,
      machineId: dependencies.machineId,
    });
    if (recovered.deferred) deferredAgentIds.add(agent.agentId);
    else recoveredAgentCount += 1;
  }
  if (recoveredAgentCount === 0) return { recoveryContext: undefined, deferredAgentIds };
  return { recoveryContext, deferredAgentIds };
}

/**
 * Re-resolve a send's targets around agents this runtime may not drive.
 * @param dependencies - Orchestrator operations used to start a replacement.
 * @param context - The send's identity, target spec and start inputs.
 * @param targetAgents - Targets as this send materialized them.
 * @param deferredAgentIds - Agents this pass removes from the current targets.
 * @param allDeferredAgentIds - Every target this send has deferred so far.
 * @returns The surviving targets and any replacement adoption.
 * @throws A {@link SessionStartError} when every target deferred and no fresh start applies.
 */
async function retargetAfterDeferral(
  dependencies: DeferralConvergenceDependencies,
  context: DeferralConvergenceContext,
  targetAgents: readonly MakaioSessionAgent[],
  deferredAgentIds: ReadonlySet<string>,
  allDeferredAgentIds: ReadonlySet<string>,
): Promise<DeferralRetargetResult> {
  const deferredAgents = targetAgents.filter((agent) => deferredAgentIds.has(agent.agentId));
  const remaining = dropDeferredAgents(context.session, targetAgents, deferredAgentIds);
  if (remaining.length > 0) {
    return {
      targetAgents: remaining,
      recovering: EMPTY_START_RESOLUTION.recoveringAgentIds,
      arbitrated: EMPTY_START_RESOLUTION.arbitratedAgentIds,
      deferred: EMPTY_START_RESOLUTION.deferredAgentIds,
    };
  }
  if (resolveSendTargetForm(context.targetSpec) !== 'lead-default')
    refuseTotalDeferral(SEND_MESSAGE_CALLER, context.sessionId, allDeferredAgentIds);
  const adopted = await dependencies.startReplacementLeadAgent(
    context.agentSelection ?? inheritAgentSelection(deferredAgents[0], dependencies.machineId),
  );
  const restarted = resolveTargetAgents(context.session, context.targetSpec);
  if (restarted.length === 0) refuseTotalDeferral(SEND_MESSAGE_CALLER, context.sessionId, allDeferredAgentIds);
  return {
    targetAgents: restarted,
    recovering: adopted.recoveringAgentIds,
    arbitrated: adopted.arbitratedAgentIds,
    deferred: adopted.deferredAgentIds,
    recoveryContext: await buildPlannedRecoveryContext(
      dependencies.bus,
      context.session,
      FRESH_WITH_HISTORY_RECOVERY_PLAN,
    ),
  };
}
