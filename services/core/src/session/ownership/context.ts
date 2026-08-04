import type { IMakaioBus } from '@makaio/bus-core';
import type { OwnershipTopology } from '@makaio/contracts';

/**
 * What the ownership authority was composed with.
 *
 * The machine identity is **injected, not resolved through the bus**. Resolving
 * it per call would make every ownership decision depend on whether the adapter
 * runtime happened to have registered its identity handler yet — a boot-order
 * dependency the authority cannot observe and callers cannot reason about.
 * Composed with `undefined`, the authority declines every identity-dependent
 * operation instead of deciding under a guess.
 */
export interface OwnershipAuthorityContext {
  /** Bus the authority reads and writes storage through. */
  readonly bus: IMakaioBus;
  /** Machine identity the authority owns claims under, or `undefined` when it has none. */
  readonly machineId: string | undefined;
  /** {@inheritDoc OwnershipTopologySchema} */
  readonly topology: OwnershipTopology;
}

/**
 * Resolve the machine identity one operation acts under.
 *
 * A payload override wins so tests and operational tooling can act for a named
 * machine; production callers omit it and get the composed identity. Same
 * precedence as `session.restartAgents`, deliberately: two identity fallbacks
 * with different orders in one service would be a bug waiting to be found by a
 * user.
 * @param context - Composed authority context.
 * @param override - Caller-supplied machine identity, if any.
 * @returns The identity to act under, or `undefined` when there is none.
 */
export function resolveOwnershipMachineId(
  context: OwnershipAuthorityContext,
  override: string | undefined,
): string | undefined {
  return override ?? context.machineId;
}
