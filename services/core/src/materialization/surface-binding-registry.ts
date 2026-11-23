import type { IMakaioBus } from '@makaio/bus-core';
import { MaterializationSubjects, type SurfaceBindingRegistration } from '@makaio/contracts/materialization';
import type { CallContext } from '@makaio/core';
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
      this.registerBindingWithCall(ctx.call, ctx.payload);
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
   * Register a contribution received directly from another carrier.
   * @param registration - Registration payload to store.
   */
  public registerBinding(registration: SurfaceBindingRegistration): void {
    // ORIGIN: Direct calls from another carrier start work on this registry's bus.
    this.registerBindingWithCall(this.bus.own('shared-work'), registration);
  }

  /**
   * Remove a contribution received directly from another carrier.
   * @param id - Registration identifier to remove.
   */
  public deregisterBinding(id: string): void {
    // ORIGIN: Direct calls from another carrier start work on this registry's bus.
    this.deregisterBindingWithCall(this.bus.own('shared-work'), id);
  }

  /**
   * Store a surface binding registration, rejecting conflicting duplicates.
   *
   * An identical re-registration (same `id` and all fields) is silently
   * accepted. A registration that differs in any field is rejected with an error.
   *
   * The bus RPC handler delegates here with its received call.
   * This method becomes public as soon as a handler on another carrier must pass a received call into this registry.
   * @param call - Call context for the operation that registers the binding.
   * @param registration - Surface binding registration payload to store.
   * @throws If a conflicting registration for the same binding `id` already exists.
   */
  private registerBindingWithCall(call: CallContext, registration: SurfaceBindingRegistration): void {
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
    this.emitChanged(call, registration);
  }

  /**
   * Remove a surface binding registration by stable identifier.
   * This method becomes public as soon as a handler on another carrier must pass a received call into this registry.
   * @param call - Call context for the operation that removes the binding.
   * @param id - Surface binding identifier to remove.
   */
  private deregisterBindingWithCall(call: CallContext, id: string): void {
    const existing = this.bindings.get(id);
    if (!existing) {
      return;
    }
    this.bindings.delete(id);
    this.emitChanged(call, existing);
  }

  /**
   * Emit a registry change and report asynchronous delivery failures.
   * @param call - Call context for the registration change.
   * @param binding - Binding identifying the changed surface.
   */
  private emitChanged(call: CallContext, binding: SurfaceBindingRegistration): void {
    void this.bus
      .emit(call, MaterializationSubjects.surfaceBinding.changed, { id: binding.id, provider: binding.provider })
      .catch((error) =>
        console.warn(
          `[SurfaceBindingRegistry] Failed to emit ${MaterializationSubjects.surfaceBinding.changed.subject}:`,
          error,
        ),
      );
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
