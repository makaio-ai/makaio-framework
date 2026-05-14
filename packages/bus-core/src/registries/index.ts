/**
 * Registries for bus schemas and transports.
 *
 * - NamespaceRegistry: Single source of truth for subject schemas and namespace objects
 * - TransportRegistry: Manages transport extensions (WebSocket, NATS, etc.)
 * - AdvertisedState: Centralized subscribe/unsubscribe computation per (target, subject) pair
 */

// Namespace and subject schema registry (single source of truth)
export { createNamespaceRegistry } from './namespace-registry.js';
export type {
  BusValidationMode,
  NamespaceRegistry,
  RegisteredSubjectSchema,
  SchemaViolationCallback,
  SchemaViolationReport,
  ValidationConfig,
} from './namespace-registry.js';

// NamespaceRegistrationOptions is canonical in @makaio/core; re-exported here
// for existing consumers that import from @makaio/bus-core.
export type { NamespaceRegistrationOptions } from '@makaio/core';

// Transport registry (orthogonal responsibility)
export { createTransportRegistry } from './transport-registry.js';
export type { BusTransportKeys, BusTransportRegistry, TransportRegistry } from './transport-registry.js';

// Centralized advertised-state computation
export {
  pushAdvertisedSubject,
  pushAdvertisedSubjectsToPeers,
  syncAllSubjectsToTransport,
} from './advertised-state.js';
