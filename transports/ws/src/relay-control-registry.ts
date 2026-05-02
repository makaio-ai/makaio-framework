/**
 * Registry for relay control subjects.
 *
 * Maps namespace/subject pairs to their plaintext (control-plane) classification.
 * Host code registers control subjects at boot time before freezing the
 * registry. Once frozen, no further registrations are allowed — this enforces
 * the security invariant that the plaintext subject set cannot change after the
 * transport handshake begins.
 */

/**
 * Mutable-then-frozen registry mapping relay control namespaces and subjects.
 *
 * Callers register event subjects and request namespaces before calling
 * {@link RelayControlRegistry.freeze}. After freezing, all `register*` methods
 * throw so the set cannot be widened post-handshake.
 */
export interface RelayControlRegistry {
  /**
   * Register a set of plaintext event subjects for a namespace.
   *
   * May be called multiple times for the same namespace — subjects accumulate.
   * @param namespace - Bus namespace (e.g. `'relay'`)
   * @param subjects - Subject names to classify as control events
   * @throws When called after {@link freeze}
   */
  registerEventSubjects(namespace: string, subjects: readonly string[]): void;

  /**
   * Register an explicit allowlist of plaintext request subjects for a namespace.
   *
   * Only the listed subjects will be classified as control-plane (plaintext)
   * traffic for the given namespace. An explicit allowlist is required — there
   * is no allow-all mode — to enforce least-privilege classification.
   * @param namespace - Bus namespace (e.g. `'tunnel'`)
   * @param subjects - Explicit subject allowlist; must be non-empty
   * @throws When called after {@link freeze}
   */
  registerRequestNamespace(namespace: string, subjects: readonly string[]): void;

  /**
   * Freeze the registry.
   *
   * After freezing, `registerEventSubjects` and `registerRequestNamespace`
   * throw on any call. Must be called before passing the registry to the
   * transport so the security invariant (no post-handshake plaintext injection)
   * is enforced.
   */
  freeze(): void;

  /**
   * Check whether the registry has been frozen.
   *
   * The transport asserts this is `true` inside `connect()` to guarantee
   * the plaintext subject set cannot be widened after the handshake begins.
   * @returns `true` after {@link freeze} has been called
   */
  isFrozen(): boolean;

  /**
   * Check whether an event message on the given namespace/subject is a control event.
   * @param namespace - Bus namespace of the event
   * @param subject - Subject of the event
   * @returns `true` when this namespace/subject pair is registered as a control event
   */
  isControlEvent(namespace: string, subject: string): boolean;

  /**
   * Check whether a request on the given namespace/subject is a control request.
   * @param namespace - Bus namespace of the request
   * @param subject - Subject of the request
   * @returns `true` when this namespace/subject pair is registered as a control request
   */
  isControlRequest(namespace: string, subject: string): boolean;
}

/**
 * Create a new mutable relay control registry.
 *
 * The registry starts unfrozen. Call `registerEventSubjects` and
 * `registerRequestNamespace` to populate it, then call `freeze()` before
 * passing it to the transport.
 * @returns A fresh, unfrozen {@link RelayControlRegistry}
 */
export function createRelayControlRegistry(): RelayControlRegistry {
  let frozen = false;
  const eventSubjects = new Map<string, Set<string>>();
  const requestNamespaces = new Map<string, Set<string>>();

  const assertNotFrozen = (): void => {
    if (frozen) {
      throw new Error('RelayControlRegistry is frozen and cannot be modified');
    }
  };

  return {
    registerEventSubjects(namespace: string, subjects: readonly string[]): void {
      assertNotFrozen();
      const existing = eventSubjects.get(namespace) ?? new Set<string>();
      for (const subject of subjects) {
        existing.add(subject);
      }
      eventSubjects.set(namespace, existing);
    },

    registerRequestNamespace(namespace: string, subjects: readonly string[]): void {
      assertNotFrozen();
      if (subjects.length === 0) {
        throw new Error(`RelayControlRegistry request namespace "${namespace}" requires at least one subject`);
      }
      const existing = requestNamespaces.get(namespace) ?? new Set<string>();
      for (const subject of subjects) {
        existing.add(subject);
      }
      requestNamespaces.set(namespace, existing);
    },

    freeze(): void {
      frozen = true;
    },

    isFrozen(): boolean {
      return frozen;
    },

    isControlEvent(namespace: string, subject: string): boolean {
      return eventSubjects.get(namespace)?.has(subject) ?? false;
    },

    isControlRequest(namespace: string, subject: string): boolean {
      return requestNamespaces.get(namespace)?.has(subject) ?? false;
    },
  };
}
