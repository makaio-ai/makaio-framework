import { MakaioBus, type ScopedBusFor, type BusNamespace, type NamespaceRegistrationOptions } from '@makaio/bus-core';
import {
  createBusNamespace,
  type FilterablePayloadIntersection,
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
 * @typeParam Schemas - Schema record type
 */
export type AdapterNamespace<Domain extends string = string> = Omit<BusNamespace<Domain>, 'subjects'>;

/**
 * Creates an adapter namespace with typed subject definitions.
 *
 * **Seam:** Thin wrapper around MakaioBus.registerNamespace that:
 * - Delegates to bus-core for namespace registration
 * - Preserves FilterPayload type for type-safe withFilter()
 * - Provides extension point for future adapter-specific features
 * @param domain - Namespace domain (e.g., 'adapter:claudeCode')
 * @param schemas - Record of subject schemas (events and requests)
 * @param options - Registration options (e.g., busValidationMode for Zod version conflicts)
 * @returns Adapter namespace with typed subjects and pre-computed FilterPayload
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
 * // Access typed subjects
 * ClaudeCodeNamespace.subjects.thinking;
 *
 * // Get scoped bus with type-safe filtering
 * const bus = await ClaudeCodeNamespace.scopedBus();
 * bus.withFilter({ content: 'test' }); // ✅ Type-checked
 *
 * // For adapters with bundled Zod v3 (e.g., @github/copilot-sdk):
 * const CopilotNamespace = createAdapterNamespace('adapter:copilot', schemas, {
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
  options?: NamespaceRegistrationOptions,
): BusNamespace<
  N,
  SubjectRecordFromSchemaRecord<Schemas>,
  FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
  Schemas
> {
  return MakaioBus.registerNamespace(createBusNamespace(domain, schemas, options));
}

// Re-export ScopedBusFor for convenience
export type { ScopedBusFor };
