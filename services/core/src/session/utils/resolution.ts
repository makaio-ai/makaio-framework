import type { IMakaioBus } from '@makaio/bus-core';
import { type ReasoningLevelMap } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { AdapterSubsystemSubjects } from '../../adapter-subsystem/namespace.js';
import { ProviderStorageSubjects } from '../../settings/storage/providers-namespace.js';
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
 * The adapter instance an ownership act runs against, together with the machine
 * whose namespace it acts in.
 *
 * **One value, because it is one key.** The ownership key is
 * `(machine, adapter instance, provider session)` and an instance ID is derived
 * from `(machineId, adapterName)`, so an act that took its instance from one
 * source and its machine from another files itself under a pair nobody else
 * computes. Carrying both halves in one object is what makes "instance and
 * namespace come from one identity" structural rather than a rule every call
 * site has to remember.
 *
 * `machineId` is absent for exactly one caller shape — one that named no machine
 * and is therefore not acting for any: it gets the unscoped answer, the
 * authority acts under its own composed identity, and there are no two
 * identities to mix.
 */
export interface OwnedAdapterInstance {
  /** Live adapter instance every act of the attempt addresses. */
  readonly adapterId: string;
  /** Machine whose namespace those acts are filed under, or `undefined` when the caller named none. */
  readonly machineId?: string;
  /** Exact runtime owner, absent only before a connector-dispatchable target is proved. */
  readonly ownerInstanceId?: string;
}

/**
 * An owned instance whose machine is named.
 *
 * The shape a path that performs a **keyed** ownership act needs, stated as a
 * type so the requirement is checked rather than remembered: a keyed act files
 * itself under `(machine, instance, provider session)`, so a path that can reach
 * one may not hold an instance whose machine is unnamed. Wave 3 left exactly
 * that hole — a fresh lead start reserves keyless, which hides the machine's
 * absence, and then settles on the provider session the connector confirms,
 * which does not.
 */
export type MachineScopedAdapterInstance = OwnedAdapterInstance & {
  readonly machineId: string;
  readonly ownerInstanceId: string;
};

/**
 * Keep only an adapter instance that can name the machine hosting its connector.
 *
 * A designation-only authority may use its internal sentinel while deciding
 * ownership, but a connector-producing path must never dispatch or persist that
 * sentinel as a runtime owner. Callers translate `undefined` into their own
 * pre-dispatch refusal or deferral.
 * @param instance - Resolved adapter instance, possibly unscoped.
 * @returns The dispatchable instance, or `undefined` when no real machine is known.
 */
export function toMachineScopedAdapterInstance(
  instance: OwnedAdapterInstance | undefined,
): MachineScopedAdapterInstance | undefined {
  if (
    instance === undefined ||
    instance.machineId === undefined ||
    instance.machineId.length === 0 ||
    instance.ownerInstanceId === undefined ||
    instance.ownerInstanceId.length === 0
  )
    return undefined;
  return {
    adapterId: instance.adapterId,
    machineId: instance.machineId,
    ownerInstanceId: instance.ownerInstanceId,
  };
}

/** What a caller knows about the instance it wants, before it is resolved. */
export interface OwnedAdapterInstanceTarget {
  /** Adapter type name the instance belongs to. */
  readonly adapterName: string;
  /**
   * Instance the caller named itself, when it named one.
   *
   * Only usable together with {@link OwnedAdapterInstanceTarget.machineId}: the
   * derivation is one-way, so a named instance whose machine is unnamed is half
   * an identity, and half an identity is worse than none.
   */
  readonly adapterId?: string;
  /**
   * Machine every act of this attempt names, or `undefined` when the caller
   * names none.
   */
  readonly machineId?: string;
  /**
   * Instance this agent was last known to live on, offered as a fallback for the
   * unscoped form only.
   *
   * A persisted instance goes stale across a runtime restart or a failover, so
   * it is never preferred — but for a caller that names no machine it beats
   * failing a whole recovery because a registry lookup was momentarily
   * unavailable, and it cannot mix two identities because there is only one.
   */
  readonly storedAdapterId?: string;
}

/**
 * Prove that an explicitly selected adapter instance is currently live on the
 * exact machine the selection names.
 *
 * The proof is announcement-backed rather than hash-backed: hosts may provide
 * opaque adapter IDs, and a deterministic-looking value is not evidence that a
 * runtime has initialized it.
 * @param bus - Bus the live-identity request is issued on.
 * @param target - Complete identity the caller intends to dispatch to.
 * @returns The dispatchable instance, or `undefined` when it has no matching live announcement.
 */
export async function resolveAnnouncedAdapterInstance(
  bus: IMakaioBus,
  target: Required<Pick<OwnedAdapterInstanceTarget, 'adapterId' | 'adapterName' | 'machineId'>>,
): Promise<MachineScopedAdapterInstance | undefined> {
  try {
    const identity = await bus.request(AdapterRuntimeSubjects.resolveLiveIdentity, target);
    return {
      adapterId: identity.adapterId,
      machineId: identity.machineId,
      ownerInstanceId: identity.ownerInstanceId,
    };
  } catch (error: unknown) {
    console.debug(
      `[resolveAnnouncedAdapterInstance] adapter ${target.adapterId} is not live as ${target.adapterName} on ${target.machineId}:`,
      error,
    );
    return undefined;
  }
}

/**
 * Resolve the instance an attempt addresses **and** the machine it acts for, or
 * answer that this runtime may not act at all.
 *
 * One seam for a rule that was split in three: a fresh resolution for every act
 * (a persisted instance goes stale across a restart or a failover), the machine
 * carried alongside it, and the refusal when the two cannot be produced
 * together. Reserving against one instance and dispatching to another reserves
 * in a namespace the dispatch never uses, and reserving under machine X while
 * dispatching to machine R's instance builds a key no other actor computes — it
 * collides with nothing, so it protects nothing, and the runtime that really
 * owns that instance claims the same provider session beside it.
 *
 * **The three answers, and why each is the honest one:**
 *
 * - **A named instance with its machine** is returned only after the live
 *   identity registry confirms the exact triple it announced. The selection
 *   schema proves the request is complete; the announcement proves the target
 *   currently exists, including when its host supplied an opaque ID.
 * - **A named instance without a machine** is `undefined`. This is the handler-side
 *   half of the schema's refinement, and it is needed as well as the schema:
 *   the test bus does not validate, and defaulting to this runtime's own identity
 *   here is precisely the silent mis-key the refinement exists to prevent.
 * - **No named instance** derives one. With a machine named, a derivation that
 *   cannot answer is `undefined` — the stored instance may not stand in, because
 *   the machine it belongs to cannot be recovered from it. With no machine named,
 *   the attempt is unscoped in every act, so the stored instance is an honest
 *   fallback.
 *
 * `undefined` means *this runtime may not act for that machine*, never *this
 * failed*. Translating it is the caller's job, because only the caller knows
 * what its own refusal looks like: a send defers the agent, a restart reports a
 * non-native recovery, a start refuses to dispatch.
 * @param bus - Bus the lookup is issued on.
 * @param target - What the caller knows about the instance and the machine it acts for.
 * @returns Both halves of the key, or `undefined` when this runtime may not act for that machine.
 */
export async function resolveOwnedAdapterInstance(
  bus: IMakaioBus,
  target: OwnedAdapterInstanceTarget,
): Promise<OwnedAdapterInstance | undefined> {
  const { adapterName, adapterId, machineId, storedAdapterId } = target;
  if (adapterId !== undefined) {
    return machineId === undefined
      ? undefined
      : await resolveAnnouncedAdapterInstance(bus, { adapterId, adapterName, machineId });
  }
  const resolved = await resolveAdapterId(bus, adapterName, machineId).catch((error: unknown) => {
    // The refusal is modeled by the caller (deferral / non-native degrade), so
    // the only trace of WHY no instance was resolvable would otherwise vanish
    // with this catch.
    console.debug(
      `[resolveOwnedAdapterInstance] no instance of ${adapterName} resolvable for machine ${machineId ?? '<unscoped>'}:`,
      error,
    );
    return undefined;
  });
  // The fallback belongs to the unscoped form alone: with a machine named it
  // would produce the mixed key above, silently, and exactly in the moment the
  // lookup that could have proven the pair was unavailable.
  const effective = resolved ?? (machineId === undefined ? storedAdapterId : undefined);
  if (effective === undefined) return undefined;
  if (machineId === undefined) return { adapterId: effective };
  return await resolveAnnouncedAdapterInstance(bus, { adapterId: effective, adapterName, machineId });
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
