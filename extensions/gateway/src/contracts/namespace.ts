/**
 * Bus namespace definition for the gateway extension.
 *
 * The single subject `requestRouted` is emitted after every routed request,
 * carrying observability data for the routing decision and upstream outcome.
 * Consumers that only need the subject references should import
 * {@link GatewaySubjects} directly.
 * @packageDocumentation
 */

import { createExtensionNamespace } from '@makaio/bus-core';
import type { SchemaRecord } from '@makaio/core';
import { RequestRoutedEventSchema } from './schemas.js';

/**
 * Inline schema record powering the gateway bus namespace.
 *
 * Exported so downstream packages can reference the raw schema shapes without
 * importing the full namespace object.
 */
export const GatewaySchemas = {
  /**
   * Emitted once per routed request. Subscribe to this subject to collect
   * routing telemetry and per-request observability data.
   */
  requestRouted: RequestRoutedEventSchema,
} satisfies SchemaRecord;

/**
 * Bus namespace definition for the `gateway` extension.
 *
 * Registered by `ExtensionCoordinator` during activation via the manifest's
 * `namespaces` contribution. The namespace name resolves to
 * `extension:gateway` on the bus.
 */
export const GatewayNamespace = createExtensionNamespace('gateway', {
  schemas: GatewaySchemas,
});

/**
 * Type-safe subject accessors for the `gateway` extension namespace.
 * @example
 * ```ts
 * await bus.emit(GatewaySubjects.requestRouted, event);
 * ```
 */
export const GatewaySubjects = GatewayNamespace.subjects;
