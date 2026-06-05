import type { SubjectTelemetryAttributeValue } from '@makaio/contracts';

/**
 * Map of sanitized scalar attribute values approved for telemetry emission.
 *
 * Keys are attribute names; values are restricted to primitives and homogeneous
 * primitive arrays so that telemetry sinks can safely serialize without
 * inspecting arbitrary objects. `undefined` values are excluded during merge.
 */
export type SubjectTelemetryAttributes = Record<string, SubjectTelemetryAttributeValue | undefined>;

/**
 * Input provided to a {@link SubjectTelemetryProjector} when projecting
 * attributes from a bus message payload.
 */
export interface SubjectTelemetryProjectorInput {
  /** Raw bus message payload (read-only; must not be mutated). */
  readonly payload: unknown;
  /** Bus namespace that owns the observed subject. */
  readonly namespace: string;
  /** Subject key within the namespace. */
  readonly subject: string;
  /** Bus message type for the observed message. */
  readonly messageType: 'event' | 'request' | 'broadcast';
}

/**
 * Namespace-owned sidecar projector that extracts sanitized telemetry attributes
 * from a bus message payload.
 *
 * The projector is responsible for ensuring that the returned attributes contain
 * no sensitive data. Only scalar values ({@link SubjectTelemetryAttributeValue})
 * should appear in the returned map.
 */
export interface SubjectTelemetryProjector {
  /** Namespace that owns this projector. */
  readonly namespace: string;
  /** Subject within the namespace that this projector handles. */
  readonly subject: string;
  /**
   * Extract sanitized telemetry attributes from the message payload.
   * @param input - Message context including payload, namespace, subject, and message type.
   * @returns Map of attribute key to sanitized scalar value. `undefined` values are omitted.
   */
  project(input: SubjectTelemetryProjectorInput): SubjectTelemetryAttributes;
}

/**
 * Registry of namespace-owned sidecar projectors, keyed by `namespace.subject`.
 *
 * Projectors may be registered by the namespace owner to provide sanitized
 * telemetry attributes that cannot be inferred purely from schema observability
 * metadata (e.g., when the payload contains nested structures that require
 * domain-specific extraction logic).
 */
export interface SubjectTelemetryProjectorRegistry {
  /**
   * Register a projector for a specific namespace and subject.
   *
   * If a projector is already registered for the same key, it is replaced.
   * @param projector - Projector to register.
   * @returns Cleanup function that unregisters this projector instance.
   */
  register(projector: SubjectTelemetryProjector): () => void;
  /**
   * Retrieve the registered projector for a namespace and subject, if any.
   * @param namespace - Namespace that owns the subject.
   * @param subject - Subject key within the namespace.
   * @returns The registered projector, or `undefined` if none is registered.
   */
  get(namespace: string, subject: string): SubjectTelemetryProjector | undefined;
}

/**
 * Build the registry key for a namespace/subject pair.
 * @param namespace - Bus namespace that owns the subject.
 * @param subject - Subject key within the namespace.
 * @returns Registry key in `namespace.subject` format.
 */
function makeKey(namespace: string, subject: string): string {
  return `${namespace}.${subject}`;
}

/**
 * Create a new {@link SubjectTelemetryProjectorRegistry}.
 *
 * Maintains a map of projectors keyed by `namespace.subject`. At most one
 * projector is stored per key; later registrations replace earlier ones.
 * @returns A new projector registry instance.
 */
export function createSubjectTelemetryProjectorRegistry(): SubjectTelemetryProjectorRegistry {
  const projectors = new Map<string, SubjectTelemetryProjector>();

  return {
    register(projector) {
      const key = makeKey(projector.namespace, projector.subject);
      projectors.set(key, projector);
      return () => {
        if (projectors.get(key) === projector) {
          projectors.delete(key);
        }
      };
    },
    get(namespace, subject) {
      return projectors.get(makeKey(namespace, subject));
    },
  };
}
