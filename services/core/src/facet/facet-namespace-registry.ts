import type { IMakaioBus } from '@makaio/bus-core';
import { FacetSubjects, type FacetNamespaceRegistration } from '@makaio/contracts/facet';
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
      this.registerNamespace(ctx.payload);
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
   * Store a namespace registration, rejecting conflicting duplicates.
   *
   * An identical re-registration (same namespace and all fields) is silently
   * accepted. A registration that differs in any field is rejected with an error.
   *
   * The bus RPC handler delegates here; the contribution processor also calls
   * this directly via {@link registerNamespace}.
   * @param registration - Namespace registration payload to store.
   * @throws If a conflicting registration for the same namespace already exists.
   */
  public registerNamespace(registration: FacetNamespaceRegistration): void {
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
    void this.bus.emit(FacetSubjects.namespace.changed, { namespace: registration.namespace });
  }

  /**
   * Remove a namespace registration by namespace identifier.
   * @param namespace - Namespace identifier to remove.
   */
  public deregisterNamespace(namespace: string): void {
    if (!this.namespaces.delete(namespace)) {
      return;
    }
    void this.bus.emit(FacetSubjects.namespace.changed, { namespace });
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
