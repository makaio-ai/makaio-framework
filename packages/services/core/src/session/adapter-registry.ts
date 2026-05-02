import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../adapter-runtime/namespace.js';

/**
 * Build the canonical missing-adapter error.
 * @param adapterName - Adapter type name requested by the session orchestrator.
 * @returns Error describing the missing initialized adapter.
 */
function createMissingAdapterError(adapterName: string): Error {
  return new Error(
    `No adapter found for adapterName="${adapterName}". ` +
      `Ensure adapter-runtime identity handlers are registered; adapter startup verifies live availability.`,
  );
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
   * @param bus - The event bus to listen on
   */
  public constructor(private readonly bus: IMakaioBus) {
    this.cleanup = this.bus.on(AdapterSubjects.initialized, (ctx) => {
      this.registry.set(ctx.payload.adapterName, ctx.payload.adapterId);
    });
  }

  /**
   * Resolve an adapterId from the event cache.
   * @param adapterName - Adapter type name (e.g., `'openai-node'`, `'claude-agent-sdk'`)
   * @returns The cached adapterId registered for this adapterName.
   * @throws Error when no adapter with this name is present in the event cache
   */
  public resolve(adapterName: string): string {
    const adapterId = this.registry.get(adapterName);
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
   * @param adapterName - Adapter type name (e.g., `'openai-node'`)
   * @returns Adapter runtime identifier for bus routing.
   */
  public async resolveAvailable(adapterName: string): Promise<string> {
    try {
      const { adapterId } = await this.bus.request(AdapterRuntimeSubjects.resolveId, { adapterName });
      this.registry.set(adapterName, adapterId);
      return adapterId;
    } catch {
      const cached = this.registry.get(adapterName);
      if (cached) {
        return cached;
      }

      throw createMissingAdapterError(adapterName);
    }
  }

  /** Stop listening to `adapter.initialized` events and clear the registry. */
  public destroy(): void {
    this.cleanup?.();
    this.cleanup = undefined;
    this.registry.clear();
  }
}
