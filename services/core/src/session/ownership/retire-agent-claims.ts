import type { IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  teardownWasObserved,
  type AdapterSessionClaimRecord,
} from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';

/** Result of sealing one agent's ownership generations for terminal removal. */
export interface RetireAgentClaimsResult {
  /** Whether every recorded generation was proven safe and released. */
  readonly released: boolean;
  /** Claims present when teardown assessment began. */
  readonly claimCount: number;
}

/** Controls which terminal-removal consequences the helper is allowed to perform. */
export interface RetireTerminalAgentClaimsOptions {
  /** Whether the caller proved the agent row terminal and may release its claims. */
  readonly releaseClaims: boolean;
}

/** One exact runtime target that may still host an agent connector. */
interface ClaimOwnerTarget {
  readonly adapterId: string;
  readonly machineId: string;
  readonly ownerInstanceId: string;
}

/** Runtime owner persisted on the agent independently of provider-session claims. */
interface AgentRuntimeOwner {
  readonly machineId: string;
  readonly instanceId: string;
}

/**
 * Prove that one exact claim owner can no longer drive its connector.
 *
 * A retired runtime needs no request: retirement is stamped only after its
 * adapter teardown was observed. A live runtime is addressed by owner-instance
 * identity; an unhandled, throwing or weak stop response remains unproven.
 * @param bus - Bus carrying runtime-instance reads and targeted adapter stops.
 * @param agentId - Agent whose connector must be absent.
 * @param target - Exact runtime process and adapter instance named by the claim.
 * @param connectorOnly - Whether the durable agent row must remain untouched.
 * @returns Whether teardown is durably or directly observed.
 */
async function ownerTeardownWasObserved(
  bus: IMakaioBus,
  agentId: string,
  target: ClaimOwnerTarget,
  connectorOnly: boolean,
): Promise<boolean> {
  try {
    const runtime = await bus.requestOptional(SessionOwnershipStorageSubjects.getRuntimeInstance, {
      instanceId: target.ownerInstanceId,
      machineId: target.machineId,
    });
    if (runtime.handled && runtime.data.instance !== null && runtime.data.instance.retiredAt !== null) return true;
  } catch {
    // Failure to read durable retirement evidence does not invalidate the
    // independently persisted exact runtime target below.
  }

  // An ordinary keyless start creates no runtime-instance row. A guarded
  // recovery does create one before publishing its owner, but absence of durable
  // proof still falls through to the independent adapter proof.
  try {
    const stopped = await bus.requestOptional(AdapterSubjects.stopAgent, {
      adapterId: target.adapterId,
      agentId,
      ownerInstanceId: target.ownerInstanceId,
      ...(connectorOnly && { teardown: 'connector-only' as const }),
    });
    return stopped.handled && teardownWasObserved(stopped.data.evidence);
  } catch {
    return false;
  }
}

/**
 * Collapse an agent's claims into unique owner-runtime stop targets.
 * @param claims - Claims held by the terminal agent.
 * @param agentOwner - Runtime owner stored independently on the agent.
 * @param adapterId - Current adapter instance stored on the agent.
 * @returns Exact targets, or `null` when a legacy owner makes routing unsafe.
 */
function claimOwnerTargets(
  claims: readonly AdapterSessionClaimRecord[],
  agentOwner: AgentRuntimeOwner | undefined,
  adapterId: string | undefined,
): ClaimOwnerTarget[] | null {
  const targets = new Map<string, ClaimOwnerTarget>();
  for (const claim of claims) {
    if (claim.ownerInstanceId === null) return null;
    const target: ClaimOwnerTarget = {
      adapterId: claim.adapterId,
      machineId: claim.machineId,
      ownerInstanceId: claim.ownerInstanceId,
    };
    targets.set(`${target.ownerInstanceId}\0${target.machineId}\0${target.adapterId}`, target);
  }
  if (agentOwner !== undefined && adapterId !== undefined) {
    const target: ClaimOwnerTarget = {
      adapterId,
      machineId: agentOwner.machineId,
      ownerInstanceId: agentOwner.instanceId,
    };
    targets.set(`${target.ownerInstanceId}\0${target.machineId}\0${target.adapterId}`, target);
  }
  return [...targets.values()];
}

/**
 * Retire every ownership generation of an already-terminal agent.
 *
 * The caller must first make the agent row terminal (`disposed`). That absorbs
 * every allocation door, so the claim snapshot cannot gain a new generation
 * while this function assesses its owners. Every identified active owner is
 * then stopped through exact owner-instance routing. Only an all-observed set is
 * released; every other set is marked `abandoned` and remains blocking.
 *
 * A missing ownership row, a legacy owner, an unreachable owner and weak
 * teardown evidence are all conservative failures. A missing runtime-instance
 * record is not: ordinary keyless starts deliberately create none, so the exact
 * runtime owner recorded on the agent is still addressed directly. None is converted
 * into permission by `success`, elapsed time or agent status.
 * @param bus - Bus carrying ownership storage and adapter teardown requests.
 * @param agentId - Terminal agent whose claims are being retired.
 * @param options - Whether terminal status was proven and claims may be released.
 * @returns Whether all claims were released, plus the assessed claim count.
 */
export async function retireTerminalAgentClaims(
  bus: IMakaioBus,
  agentId: string,
  options: RetireTerminalAgentClaimsOptions = { releaseClaims: true },
): Promise<RetireAgentClaimsResult> {
  const read = await bus.requestOptional(SessionOwnershipStorageSubjects.read, { agentId }).catch(() => undefined);
  if (read === undefined) return { released: false, claimCount: 0 };
  const ownership = read.handled ? read.data.ownership : null;
  if (ownership === null) return { released: false, claimCount: 0 };

  const claims = ownership.claims;
  const agentRead = await bus.requestOptional(AgentStorageSubjects.get, { agentId }).catch(() => undefined);
  const agent = agentRead?.handled ? agentRead.data.agent : null;

  const targets = claimOwnerTargets(claims, agent?.runtimeOwner, agent?.adapterId);
  const observed =
    targets !== null &&
    (await Promise.all(
      targets.map((target) => ownerTeardownWasObserved(bus, agentId, target, !options.releaseClaims)),
    ));
  const allObserved = observed !== false && observed.every(Boolean);

  if (!options.releaseClaims) return { released: false, claimCount: claims.length };
  if (claims.length === 0) return { released: allObserved, claimCount: 0 };

  try {
    const retired = await bus.request(SessionSubjects.ownership.release, {
      agentId,
      disposition: allObserved ? 'released' : 'abandoned',
    });
    return {
      released:
        allObserved && retired.markedClaims.length === 0 && retired.releasedProviderSessionIds.length === claims.length,
      claimCount: claims.length,
    };
  } catch {
    // The release may have committed before its response was lost. A second,
    // conservative fan-out either marks what remains or finds nothing.
    try {
      await bus.request(SessionSubjects.ownership.release, { agentId, disposition: 'abandoned' });
    } catch {
      // The caller retains its terminal row/session and can retry later.
    }
    return { released: false, claimCount: claims.length };
  }
}
