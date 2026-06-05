import { z } from 'zod';
import { getObservabilityFieldPolicy, getObservabilitySchemaPolicy, isRequestSchema } from '@makaio/core';
import type { SubjectTelemetryFact, SubjectTelemetryAttributeValue } from '@makaio/contracts';
import type { BusBroadcastMessage, BusEventMessage, BusRequestMessage } from '../types/transports.js';
import type { MakaioBusContext, ObservedBusMessage } from '../types/bus.js';
import type { NamespaceRegistry } from '../registries/index.js';
import { getSubjectFromBusMessage } from '../utils/index.js';
import type { SubjectTelemetryAttributes, SubjectTelemetryProjectorRegistry } from './projector-registry.js';

/**
 * Union of the three projectable local bus message types.
 *
 * Only messages that enter the bus via the local API (`emit`, `request`,
 * `broadcast`) are candidates for telemetry projection. Transport-relayed
 * messages are excluded because their projection is the responsibility of
 * the originating runtime.
 */
export type ProjectableBusMessage = BusEventMessage | BusRequestMessage | BusBroadcastMessage;

/**
 * Input for {@link projectSubjectTelemetryFacts}.
 *
 * Carries all data needed to project a sanitized {@link SubjectTelemetryFact}
 * from a single observed bus message.
 */
export interface SubjectTelemetryProjectionInput {
  /** The observed bus message to project. */
  readonly message: ProjectableBusMessage;
  /**
   * Flow direction of the observed message at the source runtime.
   * Typically `'local'` for messages that originate and are consumed within
   * the same process.
   */
  readonly direction: 'local' | 'outbound' | 'inbound';
  /** Wall-clock timestamp in Unix milliseconds at the time of observation. */
  readonly observedAt: number;
  /** Optional source machine identifier for multi-node telemetry correlation. */
  readonly machineId?: string;
  /**
   * Namespace registry used to look up the schema for the observed subject.
   * Obtain via `bus.getContext().namespaceRegistry`.
   */
  readonly namespaceRegistry: NamespaceRegistry;
  /**
   * Optional sidecar projector registry for namespace-owned attribute extraction.
   *
   * When a projector is registered for the message's namespace and subject it
   * takes precedence over schema-driven projection.
   */
  readonly projectorRegistry?: SubjectTelemetryProjectorRegistry;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a runtime value qualifies as a scalar telemetry attribute.
 *
 * Scalar attributes are primitives that telemetry sinks can safely serialize
 * without inspecting nested structures. Numeric attributes must be finite
 * because JSON telemetry sinks cannot faithfully represent `NaN` or infinities.
 * @param value - The value to test.
 * @returns `true` if `value` is a `string`, finite `number`, `boolean`, or `null`.
 */
function isScalarAttribute(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Determine whether a value is valid for persisted telemetry attributes.
 * @param value - The value to test.
 * @returns `true` if the value matches `SubjectTelemetryAttributeValue`.
 */
function isTelemetryAttributeValue(value: unknown): value is SubjectTelemetryAttributeValue {
  if (isScalarAttribute(value)) {
    return true;
  }
  if (!Array.isArray(value) || !value.every(isScalarAttribute)) {
    return false;
  }
  if (value.length <= 1) {
    return true;
  }
  const firstType = value[0] === null ? 'null' : typeof value[0];
  return value.every((item) => (item === null ? 'null' : typeof item) === firstType);
}

/**
 * Project a collection/string size without exposing its contents.
 * @param value - Runtime payload field value.
 * @returns Count value, or `undefined` when the value cannot be counted.
 */
function projectCountAttribute(value: unknown): number | undefined {
  if (Array.isArray(value) || typeof value === 'string') {
    return value.length;
  }
  return value === undefined ? undefined : 1;
}

/**
 * Extract the `ZodObject` shape from a schema, if it is a `ZodObject`.
 *
 * Returns `undefined` for any non-object schema type (primitives, unions, etc.)
 * so that callers can skip projection gracefully when there is no shape to walk.
 * @param schema - The Zod schema to inspect.
 * @returns The shape of the `ZodObject`, or `undefined` when the schema is not a `ZodObject`.
 */
function getObjectShape(schema: z.ZodType): z.ZodRawShape | undefined {
  if (schema instanceof z.ZodObject) {
    return schema.shape as z.ZodRawShape;
  }
  return undefined;
}

/**
 * Project scalar attributes from a Zod object schema and a raw payload,
 * applying `traceAll` logic and honoring per-field `hidden` policies.
 *
 * When `traceAll` is enabled on the schema, every top-level scalar field is
 * projected unless its individual field policy carries `visibility: 'hidden'`.
 * When `traceAll` is absent, only fields explicitly annotated with
 * `visibility: 'attribute'` are projected.
 * @param schema - The Zod schema for the relevant payload (or sub-schema for requests).
 * @param payload - The raw message payload to extract scalar values from.
 * @returns A map of attribute name to scalar value.
 */
function projectAttributes(schema: z.ZodType, payload: unknown): SubjectTelemetryAttributes {
  const schemaPolicy = getObservabilitySchemaPolicy(schema);
  const shape = getObjectShape(schema);
  const attributes: SubjectTelemetryAttributes = {};

  if (!shape || typeof payload !== 'object' || payload === null) {
    return attributes;
  }

  const payloadRecord = payload as Record<string, unknown>;

  for (const [fieldKey, fieldSchema] of Object.entries(shape)) {
    const fieldPolicy = getObservabilityFieldPolicy(fieldSchema as z.ZodType);

    if (fieldPolicy?.visibility === 'hidden') {
      // Explicitly hidden — always exclude regardless of traceAll
      continue;
    }

    const value = payloadRecord[fieldKey];
    if (fieldPolicy?.visibility === 'count') {
      const count = projectCountAttribute(value);
      if (count !== undefined) {
        const attributeName = fieldPolicy.attributeName ?? fieldKey;
        attributes[attributeName] = count;
      }
      continue;
    }

    if (schemaPolicy?.traceAll) {
      // traceAll: project all scalar fields unless explicitly hidden
      if (isScalarAttribute(value)) {
        const attributeName = fieldPolicy?.attributeName ?? fieldKey;
        attributes[attributeName] = value;
      }
    } else if (fieldPolicy?.visibility === 'attribute') {
      // Explicit attribute annotation — project this field
      if (isScalarAttribute(value)) {
        const attributeName = fieldPolicy.attributeName ?? fieldKey;
        attributes[attributeName] = value;
      }
    }
    // Unannotated fields under non-traceAll schemas are skipped.
  }

  return attributes;
}

/**
 * Project attributes using a registered sidecar projector, if available.
 *
 * Sidecar projectors take precedence over schema-driven projection when both
 * are available for the same namespace/subject combination.
 * @param input - The full projection input including registry and message.
 * @returns Attributes from the sidecar projector, or `undefined` when no
 *   projector is registered for the message's namespace and subject.
 */
function projectSidecarAttributes(input: SubjectTelemetryProjectionInput): SubjectTelemetryAttributes | undefined {
  const { projectorRegistry, message } = input;
  if (!projectorRegistry) {
    return undefined;
  }

  const projector = projectorRegistry.get(message.namespace, message.subject);
  if (!projector) {
    return undefined;
  }

  return projector.project({
    payload: message.payload,
    namespace: message.namespace,
    subject: message.subject,
    messageType: message.type,
  });
}

/**
 * Resolve the payload schema to use for attribute projection.
 *
 * For request messages, the schema stored in the namespace registry is a
 * `RequestSchema` (`{ request, response }`). Projection operates on the
 * **request** sub-schema only, since that is what the observed payload contains.
 * @param input - The projection input.
 * @returns The Zod schema to project from, or `undefined` when the schema is
 *   not registered or cannot be resolved to a `ZodType`.
 */
function resolvePayloadSchema(input: SubjectTelemetryProjectionInput): z.ZodType | undefined {
  const { message, namespaceRegistry } = input;
  const fullSubjectKey = getSubjectFromBusMessage(message);
  if (!fullSubjectKey) {
    return undefined;
  }
  const schema = namespaceRegistry.getSchema(fullSubjectKey);

  if (!schema) {
    return undefined;
  }

  if (isRequestSchema(schema)) {
    // request and broadcast messages both carry the request payload
    return schema.request;
  }

  return schema instanceof z.ZodType ? schema : undefined;
}

/**
 * Strip `undefined` values from an attribute map and narrow the type to the
 * strict `Record<string, SubjectTelemetryAttributeValue>` required by the
 * telemetry fact schema.
 *
 * The {@link SubjectTelemetryAttributes} type allows `undefined` values so that
 * projectors can return sparse maps (e.g., `{ key: condition ? value : undefined }`).
 * This helper removes those sparse entries before the map is embedded in a fact.
 * @param attrs - Attribute map that may contain `undefined` values.
 * @returns A new map with all `undefined` entries removed.
 */
function compactAttributes(attrs: SubjectTelemetryAttributes): Record<string, SubjectTelemetryAttributeValue> {
  const result: Record<string, SubjectTelemetryAttributeValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (isTelemetryAttributeValue(value)) {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Notify all registered production-capable message observers of a bus message.
 *
 * Calls are fire-and-forget: each observer is invoked asynchronously and
 * errors are caught and logged without blocking the caller or each other.
 * @param context - Bus context whose `messageObservers` set is iterated.
 * @param message - The observed bus message to pass to each observer.
 */
export function notifyMessageObservers(context: MakaioBusContext, message: ObservedBusMessage): void {
  if (context.messageObservers.size === 0) return;
  for (const observer of context.messageObservers) {
    Promise.resolve()
      .then(() => observer(message))
      .catch((error) => {
        console.error(`[${message.messageId}] Error in bus message observer:`, error);
      });
  }
}

/**
 * Project a single bus message into an array of sanitized
 * {@link SubjectTelemetryFact} objects.
 *
 * Attributes are resolved in the following priority order:
 * 1. **Sidecar projector**: a namespace-owned projector registered in
 *    `projectorRegistry` for the message's namespace and subject.
 * 2. **Schema-driven**: scalar fields projected via `traceAll` or explicit
 *    `observability.attribute()` / `observability.hidden()` metadata on the
 *    Zod schema stored in the namespace registry.
 * 3. **Trace-only**: when neither approach yields attributes, an empty
 *    `attributes` map is produced (the fact still carries correlation handles).
 *
 * The function always returns exactly one fact per call. The array shape
 * is intentional — downstream aggregation layers may extend this to fan-out
 * multiple facts from a single message (e.g., per-field count metrics).
 * @param input - Projection input including the message, direction, timestamp,
 *   namespace registry, and optional sidecar projector registry.
 * @returns Array containing exactly one {@link SubjectTelemetryFact}.
 */
export function projectSubjectTelemetryFacts(input: SubjectTelemetryProjectionInput): SubjectTelemetryFact[] {
  const { message, direction, observedAt, machineId } = input;

  // Attempt sidecar projection first
  const sidecarAttributes = projectSidecarAttributes(input);

  let rawAttributes: SubjectTelemetryAttributes;
  if (sidecarAttributes !== undefined) {
    rawAttributes = sidecarAttributes;
  } else {
    const payloadSchema = resolvePayloadSchema(input);
    rawAttributes = payloadSchema ? projectAttributes(payloadSchema, message.payload) : {};
  }

  const fact: SubjectTelemetryFact = {
    factId: `${message.messageId}:${direction}`,
    observedAt,
    ...(machineId !== undefined ? { machineId } : {}),
    namespace: message.namespace,
    subject: message.subject,
    messageType: message.type,
    direction,
    messageId: message.messageId,
    ...(message.correlationId !== undefined ? { correlationId: message.correlationId } : {}),
    attributes: compactAttributes(rawAttributes),
  };

  return [fact];
}
