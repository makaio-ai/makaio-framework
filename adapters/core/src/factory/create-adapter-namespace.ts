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
 * The contribution supplies its definition for leasing by the extension.
 * Standalone callers register the definition on their host bus explicitly.
 * Scoping works on the supplied carrier without registering the namespace.
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
 * // Register explicitly as a standalone host, then create a typed scoped bus
 * bus.registerNamespaces([ClaudeCodeNamespace.definition]);
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
  const namespace: BusNamespace<
    N,
    SubjectRecordFromSchemaRecord<Schemas>,
    FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
    Schemas
  > & { readonly definition: RegistrableBusNamespaceDefinition } = {
    name: definition.name,
    subjects: definition.subjects,
    definition,
    /**
     * Create a typed view of this namespace on the provided carrier.
     * @param bus - Carrier used to send and receive on the scoped view.
     * @returns Scoped bus with namespace-specific filters.
     */
    scopedBus: (bus) => Promise.resolve(bus.scoped(namespace) as ScopedBusFor<typeof namespace>),
  };
  return namespace;
}

// Re-export ScopedBusFor for convenience
export type { ScopedBusFor };
