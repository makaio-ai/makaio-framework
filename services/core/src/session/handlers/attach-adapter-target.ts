/**
 * Where an attach runs: the adapter type, the instance, and the machine whose
 * namespace the attach's ownership acts are filed under.
 *
 * Its own module rather than three helpers inside the attach handler, because it
 * is the one part of an attach that is purely about *identity resolution* — it
 * issues no lifecycle act, mints nothing and can refuse before anything has
 * happened. The handler beside it owns the attach transaction.
 * @packageDocumentation
 */
import type { IMakaioBus } from '@makaio/bus-core';
import type { AgentSelectionBase, ResolvedAgentConfig } from '@makaio/contracts';
import { resolveAdapterId } from '../session-orchestrator-helpers.js';
import { resolveOwnedAdapterInstance, type OwnedAdapterInstance } from '../utils/resolution.js';
import {
  describeHalfNamedInstanceRefusal,
  normalizeSelectionString,
  resolveAdapterNameById,
  type NamedSelectionInstance,
} from '../selection-utils.js';

/** Prefix every refusal from this module carries, matching the handler beside it. */
const ERROR_PREFIX = '[attach-handler] ';

/** What the selection and the host resolution together say about the adapter. */
interface AdapterCandidate {
  readonly adapterName: string | undefined;
  readonly adapterId: string | undefined;
  /**
   * Machine the named instance belongs to, when the selection named one.
   *
   * Meaningful only alongside `adapterId`: an instance ID is a one-way hash of
   * `(machineId, adapterName)`, so this is the half the ID cannot supply.
   */
  readonly machineId: string | undefined;
}

/** Where an attach dispatches. */
export interface AttachAdapterTarget {
  /** Canonical adapter type name the attach starts under. */
  readonly adapterName: string;
  /** Instance the attach addresses, with the machine its acts name. */
  readonly instance: OwnedAdapterInstance;
}

/**
 * Resolve the adapter target of one attach from its selection.
 *
 * At least one of the adapter name or the instance ID must be present — from the
 * selection for a direct adapter selection, or from persona/profile/virtual-model
 * resolution for every other kind — and the function refuses otherwise.
 *
 * When an instance is named, adapter storage supplies the canonical `adapterName`;
 * a selection that also names one and disagrees is refused rather than silently
 * reconciled. When only a name is present, resolution falls back to the name-based
 * registry lookup for this runtime's own machine.
 *
 * **The answer always carries the machine its instance belongs to.** The instance
 * and the machine its ownership acts are filed under are one key, so they are
 * produced together here: a named instance takes the machine the selection named
 * alongside it, a resolved one takes the machine it was resolved for.
 *
 * **A selection that named one half of that pair without the other is refused
 * before either branch runs**, by the one rule
 * {@link describeHalfNamedInstanceRefusal} states for every path that reads it —
 * the same refusal the fresh-start and send paths raise. An attach used to answer
 * the *instance-without-machine* half with a locality degrade instead, on the
 * grounds that a fresh-with-history conversation is still worth offering. It is
 * not worth offering on a guessed machine: the degraded attach starts fresh, and
 * the settlement that follows files the confirmed provider session under this
 * runtime's own machine while the dispatch addressed the named instance — a claim
 * keyed under a pair no owner computes, which the runtime that really owns that
 * instance never sees. So both halves are refused here, and neither branch below
 * has to decide what to do with half an identity.
 * @param bus - Bus every resolution round trip is issued on
 * @param input - The attach's selection, its host resolution, this runtime's machine
 *   and the session identity the refusals name
 * @returns The adapter name and the instance with the machine its acts are filed under
 * @throws Error When neither a name nor an instance is available, when a named
 *   instance disagrees with a named adapter name, or when either half of the
 *   instance/machine pair is named without the other
 */
export async function resolveAttachAdapterTarget(
  bus: IMakaioBus,
  input: {
    readonly selection: AgentSelectionBase;
    readonly resolved: ResolvedAgentConfig | null;
    readonly sessionId: string;
    readonly localMachineId: string | undefined;
  },
): Promise<AttachAdapterTarget> {
  const candidate = resolveAdapterCandidate(input.selection, input.resolved);
  const normalizedAdapterName = normalizeSelectionString(candidate.adapterName);
  const named: NamedSelectionInstance = {
    adapterId: normalizeSelectionString(candidate.adapterId),
    machineId: normalizeSelectionString(candidate.machineId),
  };

  if (!normalizedAdapterName && named.adapterId === undefined) {
    throw new Error(
      `${ERROR_PREFIX}adapterName or adapterId is required — provide one explicitly or via persona/profile/virtualModel resolution`,
    );
  }

  const refusal = describeHalfNamedInstanceRefusal(named, {
    sessionId: input.sessionId,
    errorPrefix: ERROR_PREFIX,
  });
  if (refusal !== undefined) throw new Error(refusal);

  if (named.adapterId !== undefined) {
    const adapterName = await resolveAdapterNameById(bus, named.adapterId, normalizedAdapterName, ERROR_PREFIX);
    const owned = await resolveOwnedAdapterInstance(bus, {
      adapterName,
      adapterId: named.adapterId,
      ...(named.machineId !== undefined && { machineId: named.machineId }),
    });
    if (owned === undefined) {
      // Unreachable, and kept as the narrowing rather than as a guard: the
      // resolver answers a named instance with its machine unresolved, and the
      // refusal above already excluded the one input that makes it answer
      // otherwise. What it narrows is the resolver's optional answer, which is
      // optional because its *deriving* callers can fail to derive.
      throw new Error(
        `${ERROR_PREFIX}adapter instance resolution for ${named.adapterId} produced no machine (sessionId=${input.sessionId})`,
      );
    }
    return { adapterName, instance: owned };
  }

  // The early guard proved the name is present; TypeScript cannot narrow through a
  // thrown guard, so the assertion restates what the guard established.
  const resolvedName = normalizedAdapterName as string;
  const adapterId = await resolveAdapterId(bus, resolvedName, input.localMachineId);
  return {
    adapterName: resolvedName,
    // The same identity the resolution was scoped for, carried out with it: a
    // machine passed to one and not the other is how the two halves drift apart.
    instance: { adapterId, ...(input.localMachineId !== undefined && { machineId: input.localMachineId }) },
  };
}

/**
 * Select explicit adapter fields before falling back to resolved agent metadata.
 * @param selection - Agent selection from the attach request
 * @param resolved - Host-resolved agent metadata, or null for direct adapter selections
 * @returns Candidate adapter name, instance ID and the instance's machine
 */
function resolveAdapterCandidate(
  selection: AgentSelectionBase,
  resolved: ResolvedAgentConfig | null,
): AdapterCandidate {
  const direct = selection.kind === 'adapter';
  return {
    adapterName:
      direct && 'adapterName' in selection ? (selection.adapterName as string | undefined) : resolved?.adapterName,
    adapterId: direct && 'adapterId' in selection ? (selection.adapterId as string | undefined) : undefined,
    machineId: direct && 'machineId' in selection ? (selection.machineId as string | undefined) : undefined,
  };
}
