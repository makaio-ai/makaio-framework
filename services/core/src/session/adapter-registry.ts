import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../adapter-runtime/namespace.js';

/**
 * Build the canonical missing-adapter error.
 * @param adapterName - Adapter type name requested by the session orchestrator.
 * @param machineId - Machine the lookup named, when it named one; included so the
 *   failure says which scope came up empty.
 * @returns Error describing the missing initialized adapter.
 */
function createMissingAdapterError(adapterName: string, machineId?: string): Error {
  const scope = machineId === undefined ? '' : ` machineId="${machineId}"`;
  return new Error(
    `No adapter found for adapterName="${adapterName}"${scope}. ` +
      `Ensure adapter-runtime identity handlers are registered; adapter startup verifies live availability.`,
  );
}

/**
 * The cache key an instance is remembered under.
 *
 * An adapter instance ID is derived from `(machineId, adapterName)`, so the name
 * alone does not identify one — two machines serving the same adapter have two
 * different instances and the same name. Remembering them under one key is how a
 * fallback hands out the instance of a machine the caller never asked about,
 * which is the mixed key this whole seam exists to avoid: the caller then
 * dispatches to machine R's instance while claiming ownership in machine X's
 * namespace.
 *
 * `undefined` is its own scope rather than an alias for the runtime's own
 * machine, because the registry does not know what that is — see the
 * `adapter.initialized` listener.
 * @param adapterName - Adapter type name.
 * @param machineId - Machine the instance was resolved for, when one was named.
 * @returns The key for this scope.
 */
function cacheKey(adapterName: string, machineId?: string): string {
  return JSON.stringify([machineId ?? null, adapterName]);
}

/**
 * Resolves adapterName → adapterId mappings for the framework session
 * orchestrator.
 *
 * The runtime `resolveId` request is the authoritative seam. The
 * `adapter.initialized` listener maintains a local cache for observers and for
 * tests that intentionally exercise the event path.
 *
 * Lifecycle: construct to start listening, call `destroy()` when done.
 */
export class AdapterRegistry {
  private readonly registry = new Map<string, string>();
  private cleanup?: () => void;

  /**
   * Create an AdapterRegistry and start listening for adapter.initialized events.
   *
   * If the same `adapterName` is seen in a subsequent `adapter.initialized` event,
   * the new `adapterId` silently overwrites the previous mapping. This is intentional:
   * adapters that restart emit a fresh initialized event and the registry should
   * reflect the latest instance.
   *
   * **The event names no machine**, and the bus can span hosts, so an instance
   * learned this way is *unattributed*: it says an adapter of this name exists
   * somewhere reachable, not that it belongs to any particular machine. It is
   * therefore cached in the unscoped scope only, and a lookup that named a
   * machine is never served from it — answering one would be a guess about the
   * very identity the caller was careful enough to name.
   * @param bus - The event bus to listen on
   */
  public constructor(private readonly bus: IMakaioBus) {
    this.cleanup = this.bus.on(AdapterSubjects.initialized, (ctx) => {
      this.registry.set(cacheKey(ctx.payload.adapterName), ctx.payload.adapterId);
    });
  }

  /**
   * Resolve an adapterId from the event cache.
   * @param adapterName - Adapter type name (e.g., `'openai-node'`, `'claude-agent-sdk'`)
   * @returns The cached adapterId registered for this adapterName.
   * @throws Error when no adapter with this name is present in the event cache
   */
  public resolve(adapterName: string): string {
    const adapterId = this.registry.get(cacheKey(adapterName));
    if (!adapterId) {
      throw createMissingAdapterError(adapterName);
    }
    return adapterId;
  }

  /**
   * Resolve an adapterId from an adapterName through the runtime identity
   * resolver.
   *
   * The `adapter.initialized` listener is a non-authoritative cache only. It
   * keeps legacy event-driven tests and observers useful, but session routing
   * must prefer the replayable request seam so a session created after adapter
   * initialization does not miss a one-time event.
   * **Naming the machine is what makes the answer usable as an ownership key.**
   * An instance ID is derived from `(machineId, adapterName)`, so a caller that
   * will reserve or settle under a particular machine has to resolve for that
   * same machine — otherwise the instance it dispatches to and the namespace it
   * claims in come from two different identities and the key protects nothing.
   * Omitted, the resolver derives the runtime's own, which is what a caller with
   * no machine of its own to act for wants.
   * @param adapterName - Adapter type name (e.g., `'openai-node'`)
   * @param machineId - Machine to resolve the instance for; omit for the runtime's own.
   * @returns Adapter runtime identifier for bus routing.
   */
  public async resolveAvailable(adapterName: string, machineId?: string): Promise<string> {
    try {
      const { adapterId } = await this.bus.request(AdapterRuntimeSubjects.resolveId, {
        adapterName,
        ...(machineId !== undefined && { machineId }),
      });
      this.registry.set(cacheKey(adapterName, machineId), adapterId);
      return adapterId;
    } catch {
      // Only an instance remembered for *this* scope. A cached answer from
      // another machine — or an unattributed one from the initialized event —
      // would resolve to an instance the caller's ownership acts do not name,
      // and a fallback that guesses the machine is worse than one that fails:
      // the failure is loud and local, the guess surfaces as a second writer on
      // someone else's provider session.
      const cached = this.registry.get(cacheKey(adapterName, machineId));
      if (cached) {
        return cached;
      }

      throw createMissingAdapterError(adapterName, machineId);
    }
  }

  /** Stop listening to `adapter.initialized` events and clear the registry. */
  public destroy(): void {
    this.cleanup?.();
    this.cleanup = undefined;
    this.registry.clear();
  }
}
