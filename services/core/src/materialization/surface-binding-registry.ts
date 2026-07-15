import type { IMakaioBus } from '@makaio/bus-core';
import { MaterializationSubjects, type SurfaceBindingRegistration } from '@makaio/contracts/materialization';
import { BaseService } from '@makaio/service-base';
import { canonicalStringify } from '@makaio/utils';

/**
 * Clone a registration record at API boundaries so external mutation cannot
 * rewrite in-memory entries.
 * @param value - Registration value to clone.
 * @returns A detached copy of the registration value.
 */
function cloneRegistration(value: SurfaceBindingRegistration): SurfaceBindingRegistration {
  return structuredClone(value);
}

/**
 * In-process registry for surface binding definitions.
 *
 * Exposes bus RPCs for surface binding registration and listing, and emits
 * `surfaceBinding.changed` events when a binding is stored or removed. Rejects
 * conflicting duplicate registrations (same binding `id`, different
 * definition). Identical re-registrations are silently accepted.
 *
 * Extensions register surface bindings through this service directly or via
 * {@link MaterializationSubjects}; the registry rejects conflicting duplicate
 * binding definitions.
 */
export class SurfaceBindingRegistry extends BaseService {
  private readonly bindings = new Map<string, SurfaceBindingRegistration>();

  /**
   * @param bus - Bus instance used for handler registration and event emission.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /**
   * Service initialisation hook.
   *
   * Registers bus handlers for the surface binding registration and listing
   * RPCs.
   */
  protected async onInit(): Promise<void> {
    this.registerHandler(MaterializationSubjects.surfaceBinding.register, (ctx) => {
      this.registerBinding(ctx.payload);
      ctx.setResult({ registered: true });
    });

    this.registerHandler(MaterializationSubjects.surfaceBinding.list, (ctx) => {
      const { id, provider, namespace } = ctx.payload;
      const bindings = [...this.bindings.values()]
        .filter(
          (entry) =>
            (!id || entry.id === id) &&
            (!provider || entry.provider === provider) &&
            (!namespace || entry.namespace === namespace),
        )
        .map(cloneRegistration);
      ctx.setResult({ bindings });
    });
  }

  /**
   * Store a surface binding registration, rejecting conflicting duplicates.
   *
   * An identical re-registration (same `id` and all fields) is silently
   * accepted. A registration that differs in any field is rejected with an error.
   *
   * The bus RPC handler delegates here; the contribution processor also calls
   * this directly.
   * @param registration - Surface binding registration payload to store.
   * @throws If a conflicting registration for the same binding `id` already exists.
   */
  public registerBinding(registration: SurfaceBindingRegistration): void {
    const existing = this.bindings.get(registration.id);
    if (existing) {
      if (canonicalStringify(existing) !== canonicalStringify(registration)) {
        throw new Error(`Surface binding '${registration.id}' is already registered with a different definition`);
      }
      // Identical re-registration is a no-op — do not emit changed.
      return;
    }
    this.bindings.set(registration.id, cloneRegistration(registration));
    // Fire-and-forget; the bus does not guarantee ordering with the RPC
    // response, so callers that need the event should subscribe before calling.
    void this.bus.emit(MaterializationSubjects.surfaceBinding.changed, {
      id: registration.id,
      provider: registration.provider,
    });
  }

  /**
   * Remove a surface binding registration by stable identifier.
   * @param id - Surface binding identifier to remove.
   */
  public deregisterBinding(id: string): void {
    const existing = this.bindings.get(id);
    if (!existing) {
      return;
    }
    this.bindings.delete(id);
    void this.bus.emit(MaterializationSubjects.surfaceBinding.changed, {
      id,
      provider: existing.provider,
    });
  }

  /**
   * Look up a surface binding registration by its stable identifier.
   * @param id - Surface binding identifier to look up.
   * @returns The registration record, or `undefined` if not found.
   */
  public getBinding(id: string): SurfaceBindingRegistration | undefined {
    const registration = this.bindings.get(id);
    return registration ? cloneRegistration(registration) : undefined;
  }

  /**
   * Service teardown hook.
   *
   * Clears all in-memory registrations so the instance can be garbage-collected
   * without retaining large registration maps.
   */
  protected override onDestroy(): void {
    this.bindings.clear();
  }
}
