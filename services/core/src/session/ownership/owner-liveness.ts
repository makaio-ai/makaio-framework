import type { IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  type AdapterSessionClaimRecord,
  type MakaioSessionAgent,
  type OwnershipTopology,
  type SessionOwnershipReclaimReason,
} from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';

/**
 * Judge whether a claim's owner is gone — **for diagnostics only**.
 *
 * Reconcile is this function's sole caller, and the verdict it produces
 * authorizes nothing: a takeover is a predicate evaluated inside the taking
 * transaction, over the incumbent's own agent row, and it never consults a
 * probe or a filed verdict. Keeping the assessment out of the authorization
 * path is what makes the authorization impossible to base on evidence that is
 * stale, replayed, or contradicted by a concurrent writer.
 *
 * Reasons are tested in order of how provable they are, and the first that
 * holds is reported:
 *
 * - `agent-gone` — the agent row is absent. Rare, because both claim foreign
 *   keys cascade and normally remove the claim with its parent; kept because a
 *   diagnostic must report what it observes, and a probe can straddle a delete.
 * - `agent-disposed` — the agent was removed. A disposed agent can never
 *   legitimately hold a key.
 * - `adapter-instance-gone` — no adapter answers for the claim's instance.
 *   Admitted **only** under `machine-exclusive`: where peers may host adapters
 *   on the same machine, an unanswered probe means "not this runtime's", never
 *   "nobody's".
 * @param bus - Bus used for the agent read and the adapter probe.
 * @param topology - How many runtime processes may own claims on this machine;
 *   the one input that decides whether the adapter probe is evidence at all.
 * @param claim - The claim whose owner is being assessed.
 * @returns The first reason that holds, or `null` when the owner looks alive.
 */
export async function assessClaimOwner(
  bus: IMakaioBus,
  topology: OwnershipTopology,
  claim: AdapterSessionClaimRecord,
): Promise<SessionOwnershipReclaimReason | null> {
  const agent = await readClaimOwner(bus, claim.agentId);
  // Inconclusive is not evidence of anything: an unreadable store cannot tell
  // "gone" from "unreadable", and a diagnostic that guessed would file
  // `abandoned` against every claim it failed to read.
  if (agent === INCONCLUSIVE) return null;
  if (agent === null) return 'agent-gone';
  if (agent.status === 'disposed') return 'agent-disposed';

  if (topology !== 'machine-exclusive') return null;
  return (await adapterInstanceAnswers(bus, claim.adapterId)) ? null : 'adapter-instance-gone';
}

/** The agent read could not be made — distinct from "the agent is not there". */
const INCONCLUSIVE = Symbol('inconclusive');

/**
 * Read the agent a claim names, separating absence from unreadability.
 *
 * A store that is unregistered *or* throwing answers the same question equally
 * badly, so both collapse to {@link INCONCLUSIVE} rather than to `null`: a
 * transport failure mid-reconcile must never be reported as a vanished owner and
 * filed as `abandoned` against a claim whose agent is perfectly alive.
 * @param bus - Bus the read is issued on.
 * @param agentId - Agent the claim names.
 * @returns The row, `null` when it is provably absent, or {@link INCONCLUSIVE}.
 */
async function readClaimOwner(
  bus: IMakaioBus,
  agentId: string,
): Promise<MakaioSessionAgent | null | typeof INCONCLUSIVE> {
  try {
    const result = await bus.requestOptional(AgentStorageSubjects.get, { agentId });
    return result.handled ? result.data.agent : INCONCLUSIVE;
  } catch {
    return INCONCLUSIVE;
  }
}

/**
 * Probe whether any adapter still answers for an instance ID.
 *
 * A throw and an unhandled subject are treated alike — as "no answer" — because
 * under `machine-exclusive` both mean the same thing: nothing on this machine
 * is serving that instance.
 * @param bus - Bus for the probe.
 * @param adapterId - Adapter instance the claim names.
 * @returns `true` when an adapter answered.
 */
async function adapterInstanceAnswers(bus: IMakaioBus, adapterId: string): Promise<boolean> {
  try {
    const result = await bus.requestOptional(AdapterSubjects.listAgents, { adapterId });
    return result.handled;
  } catch {
    return false;
  }
}
