/** Identifies one provider object participating in a materialization operation. */
export interface MaterializationProviderObject {
  readonly provider: string;
  readonly externalId: string;
}

/** Provider-neutral resources protected by a materialization operation lease. */
export interface MaterializationOperationScope {
  readonly artifactId: string;
  readonly providerObjects?: readonly MaterializationProviderObject[];
}

/** Explicit ownership handle for a materialization operation. */
export interface MaterializationOperationLease {
  readonly id: string;
  readonly scope: MaterializationOperationScope;
}

/** Trusted origin metadata supplied by a bus request handler context. */
export interface MaterializationOperationRequestOrigin {
  readonly local: boolean;
}

interface ActiveLease {
  readonly lease: MaterializationOperationLease;
  readonly heldKeys: Set<string>;
  readonly releases: Array<() => void>;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  released: boolean;
}

interface AuthorizedRequest {
  readonly leaseId: string;
  readonly scopeKey: string;
}

/**
 * Coordinates provider-neutral materialization operations across artifact and
 * provider-object identities. Every operation takes its artifact key first,
 * then deduplicated provider-object keys in lexical order.
 */
export class MaterializationOperationCoordinator {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeLeases = new Map<string, ActiveLease>();
  private readonly pendingAcquisitions = new Set<Promise<MaterializationOperationLease>>();
  private readonly authorizedRequests = new Map<string, AuthorizedRequest>();
  private readonly consumedAuthorizedRequestIds = new Set<string>();
  private acceptingAcquisitions = true;
  private destroyPromise: Promise<void> | undefined;

  /**
   * Extension lifecycle hook.
   *
   * Closes lease admission, then waits for every admitted acquisition and
   * active lease to settle without interrupting operations already in flight.
   * @returns Promise that resolves once all admitted leases are released.
   */
  public destroy(): Promise<void> {
    this.acceptingAcquisitions = false;
    this.destroyPromise ??= this.drain();
    return this.destroyPromise;
  }

  /**
   * Acquire an explicit lease for a materialization scope.
   * @param scope - Artifact and optional provider-object resources to lock.
   * @returns Active lease handle.
   */
  public acquire(scope: MaterializationOperationScope): Promise<MaterializationOperationLease> {
    if (!this.acceptingAcquisitions) {
      return Promise.reject(new Error('Materialization operation coordinator is destroyed'));
    }

    const acquisition = this.acquireAdmitted(scope);
    this.pendingAcquisitions.add(acquisition);
    void acquisition.then(
      () => this.pendingAcquisitions.delete(acquisition),
      () => this.pendingAcquisitions.delete(acquisition),
    );
    return acquisition;
  }

  private async acquireAdmitted(scope: MaterializationOperationScope): Promise<MaterializationOperationLease> {
    const normalizedScope = normalizeScope(scope);
    const heldKeys = new Set<string>();
    const releases: Array<() => void> = [];

    for (const key of scopeKeys(normalizedScope)) {
      releases.push(await this.acquireKey(key));
      heldKeys.add(key);
    }

    const lease: MaterializationOperationLease = { id: crypto.randomUUID(), scope: normalizedScope };
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.activeLeases.set(lease.id, { lease, heldKeys, releases, settled, settle, released: false });
    return lease;
  }

  /**
   * Release a lease and all keys it owns.
   * @param lease - Active lease to release.
   */
  public release(lease: MaterializationOperationLease): void {
    const active = this.requireActiveLease(lease);
    active.released = true;
    this.activeLeases.delete(lease.id);
    for (const release of active.releases.reverse()) release();
    active.settle();
  }

  /**
   * Extends a held artifact lease with provider-object keys.
   *
   * Provider keys must be appended in the global acquisition order; this keeps
   * multi-key operations deadlock-free even when a hard delete discovers refs
   * only after taking the artifact key.
   * @param lease - Active artifact lease to extend.
   * @param scope - Same-artifact provider-object scope to append.
   */
  public async extend(lease: MaterializationOperationLease, scope: MaterializationOperationScope): Promise<void> {
    const active = this.requireActiveLease(lease);
    const normalizedScope = normalizeScope(scope);
    if (normalizedScope.artifactId !== lease.scope.artifactId) {
      throw new Error('A materialization operation lease cannot be extended to another artifact');
    }

    const newKeys = scopeKeys(normalizedScope).filter((key) => !active.heldKeys.has(key));
    const heldProviderKeys = [...active.heldKeys].filter((key) => key.startsWith('provider:'));
    const lastHeldProviderKey = heldProviderKeys.at(-1);
    if (lastHeldProviderKey && newKeys.some((key) => compareLockKeys(key, lastHeldProviderKey) < 0)) {
      throw new Error('Materialization operation lease extension violates lock ordering');
    }

    for (const key of newKeys) {
      active.releases.push(await this.acquireKey(key));
      active.heldKeys.add(key);
    }
  }

  /**
   * Run an operation while holding the scope lease, or consume matching local bus authorization.
   * @param scope - Resources required by the operation.
   * @param operation - Work to run with an active lease.
   * @param messageId - Bus message ID that may carry one-shot authorization.
   * @param origin - Trusted origin from the bus handler context.
   * @returns Operation result.
   */
  public async runExclusive<T>(
    scope: MaterializationOperationScope,
    operation: (lease: MaterializationOperationLease) => Promise<T> | T,
    messageId?: string,
    origin?: MaterializationOperationRequestOrigin,
  ): Promise<T> {
    const normalizedScope = normalizeScope(scope);
    if (messageId) {
      if (this.consumedAuthorizedRequestIds.has(messageId)) {
        throw new Error('Materialization operation authorization has already been consumed');
      }
      const authorization = this.authorizedRequests.get(messageId);
      if (authorization) {
        this.authorizedRequests.delete(messageId);
        this.consumedAuthorizedRequestIds.add(messageId);
        const active = this.activeLeases.get(authorization.leaseId);
        if (!origin?.local || !active || authorization.scopeKey !== scopeKey(normalizedScope)) {
          throw new Error('Materialization operation authorization does not match this scope');
        }
        return operation(active.lease);
      }
    }

    const lease = await this.acquire(normalizedScope);
    try {
      return await operation(lease);
    } finally {
      this.release(lease);
    }
  }

  /**
   * Authorize exactly one bus request to re-enter a held lease without placing
   * an internal lease identifier on the wire. The request callback must dispatch
   * locally only (for example with `transports: []`).
   * @param lease - Active lease that authorizes the request.
   * @param scope - Scope the downstream handler must request exactly.
   * @param request - Local-only request callback supplied with the generated message ID.
   * @returns Downstream request result.
   */
  public async runAuthorizedRequest<T>(
    lease: MaterializationOperationLease,
    scope: MaterializationOperationScope,
    request: (messageId: string) => Promise<T>,
  ): Promise<T> {
    const active = this.requireActiveLease(lease);
    const normalizedScope = normalizeScope(scope);
    if (!scopeKeys(normalizedScope).every((key) => active.heldKeys.has(key))) {
      throw new Error('Materialization operation authorization requires a lease for the full scope');
    }

    const messageId = crypto.randomUUID();
    this.authorizedRequests.set(messageId, { leaseId: lease.id, scopeKey: scopeKey(normalizedScope) });
    try {
      return await request(messageId);
    } finally {
      this.authorizedRequests.delete(messageId);
      this.consumedAuthorizedRequestIds.delete(messageId);
    }
  }

  private requireActiveLease(lease: MaterializationOperationLease): ActiveLease {
    const active = this.activeLeases.get(lease.id);
    if (!active || active.released || active.lease !== lease) {
      throw new Error('Materialization operation lease is no longer active');
    }
    return active;
  }

  private async acquireKey(key: string): Promise<() => void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.queues.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    };
  }

  private async drain(): Promise<void> {
    while (this.pendingAcquisitions.size > 0 || this.activeLeases.size > 0) {
      await Promise.allSettled([
        ...this.pendingAcquisitions,
        ...[...this.activeLeases.values()].map((active) => active.settled),
      ]);
    }
  }
}

/**
 * Normalizes provider-object identity order for a materialization scope.
 * @param scope - Scope to normalize.
 * @returns Scope with deduplicated, sorted provider objects.
 */
function normalizeScope(scope: MaterializationOperationScope): MaterializationOperationScope {
  if (!scope.artifactId) throw new Error('Materialization operation scope requires an artifactId');
  const providerObjects = [
    ...new Map((scope.providerObjects ?? []).map((object) => [providerObjectKey(object), object])).values(),
  ].sort((left, right) => compareLockKeys(providerObjectKey(left), providerObjectKey(right)));
  return providerObjects.length > 0
    ? { artifactId: scope.artifactId, providerObjects }
    : { artifactId: scope.artifactId };
}

/**
 * Builds lock keys in the globally required acquisition order.
 * @param scope - Normalized materialization scope.
 * @returns Artifact key followed by provider-object keys.
 */
function scopeKeys(scope: MaterializationOperationScope): string[] {
  return [`artifact:${scope.artifactId}`, ...(scope.providerObjects ?? []).map(providerObjectKey)];
}

/**
 * Serializes a provider object into its globally sortable lock key.
 * @param object - Provider object identity.
 * @returns Stable provider-object lock key.
 */
function providerObjectKey(object: MaterializationProviderObject): string {
  if (!object.provider || !object.externalId)
    throw new Error('Materialization provider objects require provider and externalId');
  return `provider:${JSON.stringify([object.provider, object.externalId])}`;
}

/**
 * Compare lock keys with one locale-independent total order.
 * @param left - First canonical lock key.
 * @param right - Second canonical lock key.
 * @returns Negative, zero, or positive ordering result.
 */
function compareLockKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Builds a canonical scope identity for one-shot request authorization.
 * @param scope - Normalized materialization scope.
 * @returns Canonical scope identity.
 */
function scopeKey(scope: MaterializationOperationScope): string {
  return JSON.stringify(scopeKeys(scope));
}
