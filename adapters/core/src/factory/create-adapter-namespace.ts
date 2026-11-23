import type { ScopedBusFor, BusNamespace } from '@makaio/bus-core';
import {
  createBusNamespace,
  type CreateBusNamespaceOptions,
  type FilterablePayloadIntersection,
  type RegistrableBusNamespaceDefinition,
  type SchemaRecord,
  type SubjectRecordFromSchemaRecord,
} from '@makaio/core';

/**
 * Adapter namespace extends BusNamespace with additional metadata for adapters.
 *
 * Provides:
 * - All BusNamespace features (subjects, scoped bus factory)
 * - Raw schema access for adapter factory internals
 * - Domain name for debugging/logging
 * @typeParam N - Namespace domain string
 */
export type AdapterNamespace<Domain extends string = string> = Omit<BusNamespace<Domain>, 'subjects'> & {
  /** Original namespace definition for registration on host-provided bus instances. */
  readonly definition: RegistrableBusNamespaceDefinition;
};

/**
 * Creates an adapter namespace with typed subject definitions.
 *
 * **Pure:** the factory builds the namespace definition and registers nothing, so it is safe to
 * call at module level (a constant evaluated at import time). Registration happens on a bus the
 * caller passes, later:
 * - `AIAdapter` registers `definition` on its host bus during `initializeGeneration`.
 * - `scopedBus(bus)` registers the definition on the passed bus (idempotent, a carrier bus shares
 *   the registry of its host) and returns the scoped view with type-safe `withFilter()`.
 * - Tests that rely on a registered namespace call `bus.registerNamespace(ns.definition)` themselves.
 *
 * **Seam:** thin wrapper around `createBusNamespace` and `IMakaioBus.registerNamespace` that
 * preserves FilterPayload type for type-safe withFilter() and provides an extension point for
 * future adapter-specific features.
 * @param domain - Namespace domain (e.g., 'adapter:claudeCode')
 * @param schemas - Record of subject schemas (events and requests)
 * @param options - Registration and routing options (e.g., busValidationMode for Zod version conflicts)
 * @returns Adapter namespace with typed subjects, the registrable definition and `scopedBus(bus)`
 * @example
 * ```typescript
 * const ClaudeCodeNamespace = createAdapterNamespace('adapter:claudeCode', {
 *   thinking: z.object({ content: z.string() }),
 *   getContext: {
 *     request: z.object({ path: z.string() }),
 *     response: z.object({ content: z.string() }),
 *   },
 * });
 *
 * // Access typed subjects (no registration needed)
 * ClaudeCodeNamespace.subjects.thinking;
 *
 * // Register on the given bus and get a scoped bus with type-safe filtering
 * const scoped = await ClaudeCodeNamespace.scopedBus(bus);
 * scoped.withFilter({ content: 'test' }); // Type-checked
 *
 * // For adapters whose SDK bundles a conflicting Zod version:
 * const LegacyNamespace = createAdapterNamespace('adapter:legacy', schemas, {
 *   busValidationMode: 'skip', // Skip validation due to Zod version conflict
 * });
 *
 * // For adapters with lenient validation (schema drift triggers warnings, not crashes):
 * const ClaudeNamespace = createAdapterNamespace('adapter:claude-code', schemas, {
 *   busValidationMode: 'lenient',
 *   onSchemaViolation: (report) => console.warn(report),
 * });
 * ```
 */
export function createAdapterNamespace<N extends string, Schemas extends SchemaRecord>(
  domain: N,
  schemas: Schemas,
  options?: CreateBusNamespaceOptions,
): BusNamespace<
  N,
  SubjectRecordFromSchemaRecord<Schemas>,
  FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
  Schemas
> & {
  readonly definition: RegistrableBusNamespaceDefinition;
} {
  const definition = createBusNamespace(domain, schemas, options);
  return {
    name: definition.name,
    subjects: definition.subjects,
    definition,
    scopedBus: (bus) => bus.registerNamespace(definition).scopedBus(bus),
  };
}

// Re-export ScopedBusFor for convenience
export type { ScopedBusFor };
