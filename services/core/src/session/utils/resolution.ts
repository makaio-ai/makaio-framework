import type { IMakaioBus } from '@makaio/bus-core';
import { type ReasoningLevelMap } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { AdapterSubsystemSubjects } from '../../adapter-subsystem/namespace.js';
import { ProviderStorageSubjects } from '../../settings/storage/providers-namespace.js';
import type { MakaioSessionAgent } from '@makaio/contracts';
import { ExecutionTargetSubjects } from '../../execution-target/namespace.js';
import type { ExecutionTarget } from '../../execution-target/schemas.js';

/**
 * Resolve adapterName → adapterId for bus routing.
 * Queries the adapters table for a local enabled instance.
 * @param bus - Bus instance
 * @param adapterName - Adapter type name
 * @param machineId - Optional machine ID for deterministic local resolution
 * @returns Canonical adapter ID for bus routing
 * @throws if no enabled instance found for this adapterName
 */
export async function resolveAdapterId(bus: IMakaioBus, adapterName: string, machineId?: string): Promise<string> {
  const { adapterId } = await bus.request(AdapterRuntimeSubjects.resolveId, {
    adapterName,
    ...(machineId !== undefined && { machineId }),
  });
  return adapterId;
}

/**
 * Resolve the adapter instance an agent should currently be addressed at, under
 * the runtime's own machine identity.
 *
 * A persisted `adapterId` goes stale across a runtime restart or a failover, so
 * every act that names an instance — the capability probe, the ownership
 * reservation, the dispatch, the settlement, the runtime write — resolves it
 * fresh and uses **one** value. The stored ID is the fallback and nothing more:
 * it is the last instance this agent was known to live on, which beats failing
 * the whole recovery because a registry lookup was unavailable.
 *
 * Stated once, here, because reserving against one instance and dispatching to
 * another reserves in a namespace the dispatch never uses — a bug the call sites
 * would otherwise have to remember separately.
 *
 * **The fallback is what makes this the unscoped form**, and the signature is
 * the enforcement: there is no machine to pass. A caller acting for a machine it
 * named takes {@link resolveLiveAdapterIdForMachine} instead, which cannot fall
 * back and says so.
 *
 * Reachable only through that function, deliberately: every caller states
 * whether it is acting for a named machine, and the unscoped answer is what it
 * gets when it names none. An export here would be a second door into the
 * fallback, opened without the question being asked.
 * @param bus - Bus the lookup is issued on.
 * @param agent - Agent whose adapter instance is being resolved.
 * @returns The resolved instance, or the agent's persisted one when the lookup
 *   cannot answer.
 */
async function resolveLiveAdapterId(
  bus: IMakaioBus,
  agent: Pick<MakaioSessionAgent, 'adapterName' | 'adapterId'>,
): Promise<string> {
  return resolveAdapterId(bus, agent.adapterName).catch(() => agent.adapterId);
}

/**
 * Resolve that instance for a **named** machine, or answer that this runtime
 * cannot.
 *
 * **The machine is part of the answer.** An adapter instance ID is derived from
 * `(machineId, adapterName)`, so resolving without naming a machine derives it
 * for the runtime's own — which is right in production and wrong the moment a
 * caller is acting for a machine it named. Reserving under machine X while
 * dispatching to the instance ID of machine R builds an ownership key no other
 * actor would ever compute: it collides with nothing, so it protects nothing.
 * Passing the same identity the reservation uses keeps the whole act in one
 * namespace.
 *
 * **And that is why this form has no persisted fallback.** The derivation is
 * one-way — given a stored instance ID, the machine it was derived for cannot be
 * recovered from it — so falling back to the stored value would produce exactly
 * the mixed key above, silently, and precisely in the moment the lookup that
 * could have proven the pair was unavailable. A runtime that cannot derive the
 * named machine's instance may not act for that machine at all; this answers
 * `undefined` and leaves the consequence to the caller, which is the only layer
 * that knows what its own refusal looks like — a modeled deferral, a non-native
 * degrade, a reported non-start.
 *
 * A caller whose machine identity is simply absent is not scoped at all and gets
 * the unscoped answer, fallback included.
 * @param bus - Bus the lookup is issued on.
 * @param agent - Agent whose adapter instance is being resolved.
 * @param machineId - Machine every act of this attempt names, or `undefined`
 *   when the caller names none.
 * @returns The resolved instance, or `undefined` when a named machine has none
 *   resolvable here.
 */
export async function resolveLiveAdapterIdForMachine(
  bus: IMakaioBus,
  agent: Pick<MakaioSessionAgent, 'adapterName' | 'adapterId'>,
  machineId: string | undefined,
): Promise<string | undefined> {
  if (machineId === undefined) return resolveLiveAdapterId(bus, agent);
  return resolveAdapterId(bus, agent.adapterName, machineId).catch((error: unknown) => {
    // The refusal is modeled by the caller (deferral / non-native degrade), so
    // the only trace of WHY the named machine had no instance would otherwise
    // vanish with this catch.
    console.debug(
      `[resolveLiveAdapterIdForMachine] no instance of ${agent.adapterName} resolvable for machine ${machineId}:`,
      error,
    );
    return undefined;
  });
}

/**
 * Resolve supported reasoning levels for a model from provider definitions.
 *
 * Looks up the provider config by ID, finds the provider definition it belongs to,
 * then finds the model's `supportedReasoningLevels` in the provider's `availableModels`
 * catalog.
 * @param bus - Bus instance for RPC calls
 * @param providerConfigId - Canonical provider config ID (ProviderConfigRecord.id)
 * @param model - Model identifier to look up in the provider's catalog
 * @returns Object with `supportedReasoningLevels` when found, or `undefined` when not resolvable
 */
export async function resolveModelCapabilities(
  bus: IMakaioBus,
  providerConfigId: string | undefined,
  model: string | undefined,
): Promise<{ supportedReasoningLevels?: ReasoningLevelMap } | undefined> {
  if (!providerConfigId || !model) return undefined;

  try {
    const { config } = await bus.request(AdapterSubsystemSubjects.getProviderConfig, { id: providerConfigId });
    if (!config) return undefined;

    const { provider } = await bus.request(ProviderStorageSubjects.get, { id: config.definitionId });
    const modelDef = provider?.availableModels?.find((m) => m.name === model);
    return modelDef ? { supportedReasoningLevels: modelDef.supportedReasoningLevels } : undefined;
  } catch {
    // Bus errors (e.g., no handler registered, timeout) are treated as soft failures.
    // Capability resolution is best-effort; callers proceed without reasoning metadata.
    return undefined;
  }
}

/**
 * Resolves the effective execution target for a session.
 * Priority: explicit executionTargetId → system default (local).
 * @param bus - Makaio bus instance
 * @param params - Resolution parameters from session context
 * @returns Resolved execution target
 */
export async function resolveExecutionTarget(
  bus: IMakaioBus,
  params: {
    executionTargetId?: string;
  },
): Promise<ExecutionTarget> {
  const { executionTarget } = await bus.request(ExecutionTargetSubjects.resolve, params);
  return executionTarget;
}
