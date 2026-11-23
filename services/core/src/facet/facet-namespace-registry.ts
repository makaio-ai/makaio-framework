import type { IMakaioBus } from '@makaio/bus-core';
import { FacetSubjects, type FacetNamespaceRegistration } from '@makaio/contracts/facet';
import type { CallContext } from '@makaio/core';
import { BaseService } from '@makaio/service-base';

/**
 * Clone a registration record at API boundaries so external mutation cannot
 * rewrite in-memory entries.
 * @param value - Registration value to clone.
 * @returns A detached copy of the registration value.
 */
function cloneRegistration(value: FacetNamespaceRegistration): FacetNamespaceRegistration {
  return structuredClone(value);
}

/**
 * In-process registry for facet namespace definitions.
 *
 * Exposes bus RPCs for namespace registration and listing, and emits
 * `namespace.changed` events when a namespace is stored or removed. Rejects
 * conflicting duplicate registrations (same namespace identifier, different
 * definition). Identical re-registrations are silently accepted.
 *
 * Extensions register facet namespaces through this service directly or via
 * {@link FacetSubjects}; the registry rejects conflicting duplicate
 * namespace definitions.
 */
export class FacetNamespaceRegistry extends BaseService {
  private readonly namespaces = new Map<string, FacetNamespaceRegistration>();

  /**
   * @param bus - Bus instance used for handler registration and event emission.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /**
   * Service initialisation hook.
   *
   * Registers bus handlers for the facet namespace registration and listing
   * RPCs.
   */
  protected async onInit(): Promise<void> {
    this.registerHandler(FacetSubjects.namespace.register, (ctx) => {
      this.registerNamespaceWithCall(ctx.call, ctx.payload);
      ctx.setResult({ registered: true });
    });

    this.registerHandler(FacetSubjects.namespace.list, (ctx) => {
      const { namespace } = ctx.payload;
      const namespaces = [...this.namespaces.values()]
        .filter((entry) => !namespace || entry.namespace === namespace)
        .map(cloneRegistration);
      ctx.setResult({ namespaces });
    });
  }

  /**
   * Register a contribution received directly from another carrier.
   * @param registration - Registration payload to store.
   */
  public registerNamespace(registration: FacetNamespaceRegistration): void {
    // ORIGIN: Direct calls from another carrier start work on this registry's bus.
    this.registerNamespaceWithCall(this.bus.own('shared-work'), registration);
  }

  /**
   * Remove a contribution received directly from another carrier.
   * @param namespace - Registration identifier to remove.
   */
  public deregisterNamespace(namespace: string): void {
    // ORIGIN: Direct calls from another carrier start work on this registry's bus.
    this.deregisterNamespaceWithCall(this.bus.own('shared-work'), namespace);
  }

  /**
   * Store a namespace registration, rejecting conflicting duplicates.
   *
   * An identical re-registration (same namespace and all fields) is silently
   * accepted. A registration that differs in any field is rejected with an error.
   *
   * The bus RPC handler delegates here with its received call.
   * This method becomes public as soon as a handler on another carrier must pass a received call into this registry.
   * @param call - Call context for the namespace registration.
   * @param registration - Namespace registration payload to store.
   * @throws If a conflicting registration for the same namespace already exists.
   */
  private registerNamespaceWithCall(call: CallContext, registration: FacetNamespaceRegistration): void {
    const existing = this.namespaces.get(registration.namespace);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(registration)) {
        throw new Error(
          `Facet namespace '${registration.namespace}' is already registered with a different definition`,
        );
      }
      // Identical re-registration is a no-op — do not emit changed.
      return;
    }
    this.namespaces.set(registration.namespace, cloneRegistration(registration));
    // Fire-and-forget; the bus does not guarantee ordering with the RPC
    // response, so callers that need the event should subscribe before calling.
    this.emitChanged(call, registration.namespace);
  }

  /**
   * Remove a namespace registration by namespace identifier.
   * This method becomes public as soon as a handler on another carrier must pass a received call into this registry.
   * @param call - Call context for the namespace removal.
   * @param namespace - Namespace identifier to remove.
   */
  private deregisterNamespaceWithCall(call: CallContext, namespace: string): void {
    if (!this.namespaces.delete(namespace)) {
      return;
    }
    this.emitChanged(call, namespace);
  }

  /**
   * Emit a registry change and report asynchronous delivery failures.
   * @param call - Call context for the registration change.
   * @param namespace - Namespace identifier that changed.
   */
  private emitChanged(call: CallContext, namespace: string): void {
    void this.bus
      .emit(call, FacetSubjects.namespace.changed, { namespace })
      .catch((error) =>
        console.warn(`[FacetNamespaceRegistry] Failed to emit ${FacetSubjects.namespace.changed.subject}:`, error),
      );
  }

  /**
   * Look up a namespace registration by namespace identifier.
   * @param namespace - Namespace identifier to look up.
   * @returns The registration record, or `undefined` if not found.
   */
  public getNamespace(namespace: string): FacetNamespaceRegistration | undefined {
    const registration = this.namespaces.get(namespace);
    return registration ? cloneRegistration(registration) : undefined;
  }

  /**
   * Service teardown hook.
   *
   * Clears all in-memory registrations so the instance can be garbage-collected
   * without retaining large registration maps.
   */
  protected override onDestroy(): void {
    this.namespaces.clear();
  }
}
