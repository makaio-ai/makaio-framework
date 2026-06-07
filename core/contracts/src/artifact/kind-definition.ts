import { z } from 'zod';
import type { ArtifactKindRegistration, ArtifactRevision, ArtifactScope } from './schemas.js';
import type { ArtifactProjectionPolicy } from '../materialization/schemas.js';
import type { ArtifactLifecycleHookDefinition } from './lifecycle-hooks.js';

type JsonSchemaObject = Record<string, unknown>;

/**
 * Definition of an artifact kind with live Zod schemas for compile-time
 * type narrowing.
 *
 * The `dataSchema` and `scopeSchema` are retained as live Zod objects so
 * that kind owners can use them for runtime validation. The `toRegistration`
 * method serialises the definition to a bus-transportable
 * {@link ArtifactKindRegistration} record.
 * @typeParam TData - Kind-specific `data` payload shape.
 * @typeParam TScope - Kind-specific scope shape (defaults to the open
 *   framework {@link ArtifactScope}).
 */
export interface ArtifactKindDefinition<TData extends Record<string, unknown>, TScope extends ArtifactScope> {
  /** Kind discriminator string registered with the artifact service. */
  readonly kind: string;
  /** Schema version string (semver or opaque) for this kind definition. */
  readonly schemaVersion: string;
  /** Live Zod schema for the kind-specific `data` payload. */
  readonly dataSchema: z.ZodType<TData>;
  /** Optional live Zod schema for the kind-specific scope shape. */
  readonly scopeSchema?: z.ZodType<TScope>;
  /**
   * JSON Pointer path(s) used to discriminate between concurrent
   * revisions of this kind within the same scope.
   */
  readonly discriminator?: string | readonly string[];
  /** Conflict resolution strategy for this kind. */
  readonly conflictPolicy: ArtifactKindRegistration['conflictPolicy'];
  /** Optional status field configuration for lifecycle tracking. */
  readonly status?: ArtifactKindRegistration['status'];
  /** Optional live Zod schema for kind-specific observation extensions. */
  readonly observationSchema?: z.ZodType;
  /** Optional lifecycle hints for retention and decay. */
  readonly lifecycle?: ArtifactKindRegistration['lifecycle'];
  /** JSON Pointer paths to `data` fields that receive a secondary index. */
  readonly indexedFields?: readonly string[];
  /** JSON Pointer paths to `data` fields included in full-text search. */
  readonly searchableFields?: readonly string[];
  /**
   * Optional projection policy controlling how this artifact kind surfaces on
   * external providers. When absent, materialization adapters apply their own
   * defaults.
   */
  readonly projection?: ArtifactProjectionPolicy;
  /**
   * Optional live-only lifecycle hooks owned by this kind definition.
   *
   * Hooks carry function references and are intentionally excluded from
   * `toRegistration()`. They are never serialized or transmitted over the bus.
   */
  readonly hooks?: ArtifactLifecycleHookDefinition;
  /**
   * Phantom field for compile-time `data` type extraction.
   * Never assigned at runtime.
   */
  readonly __data?: TData;
  /**
   * Phantom field for compile-time `scope` type extraction.
   * Never assigned at runtime.
   */
  readonly __scope?: TScope;
  /** Produces a serializable registration record suitable for bus transport. */
  readonly toRegistration: () => ArtifactKindRegistration;
}

/**
 * Any artifact kind definition regardless of its data or scope type
 * parameters.
 *
 * Use this type when storing heterogeneous kind definitions in a registry
 * or when the specific data/scope types are not needed.
 */
export type AnyArtifactKindDefinition = ArtifactKindDefinition<Record<string, unknown>, ArtifactScope>;

/**
 * Extracts the `data` type from a kind definition.
 * @typeParam T - An {@link ArtifactKindDefinition} whose `data` type to extract.
 * @example
 * ```ts
 * const planDef = defineArtifactKind({ kind: 'plan', dataSchema: PlanDataSchema, ... });
 * type PlanData = ArtifactDataOf<typeof planDef>;
 * // PlanData = { status: 'draft' | 'approved'; topic: string }
 * ```
 */
export type ArtifactDataOf<T extends ArtifactKindDefinition<Record<string, unknown>, ArtifactScope>> =
  T extends ArtifactKindDefinition<infer TData, ArtifactScope> ? TData : never;

/**
 * Narrows an {@link ArtifactRevision} to the `data` and `scope` types of a
 * kind definition.
 *
 * The resulting type combines the generic revision shape with the
 * kind-specific `data` payload and the kind-specific `scope` shape.
 * @typeParam T - An {@link ArtifactKindDefinition} to narrow against.
 * @example
 * ```ts
 * const planDef = defineArtifactKind({ kind: 'plan', dataSchema: PlanDataSchema, ... });
 * type PlanArtifact = ArtifactOf<typeof planDef>;
 * // PlanArtifact = ArtifactRevision<PlanData> & { kind: 'plan'; scope: ProjectScope }
 * ```
 */
export type ArtifactOf<T extends ArtifactKindDefinition<Record<string, unknown>, ArtifactScope>> =
  T extends ArtifactKindDefinition<infer TData, infer TScope>
    ? ArtifactRevision<TData> & {
        kind: T['kind'];
        schemaVersion: T['schemaVersion'];
        scope: TScope;
      }
    : never;

/**
 * Options for {@link defineArtifactKind}.
 * @typeParam TData - Kind-specific `data` payload shape.
 * @typeParam TScope - Kind-specific scope shape.
 */
interface DefineArtifactKindOptions<TData extends Record<string, unknown>, TScope extends ArtifactScope> {
  /** Kind discriminator string. */
  readonly kind: string;
  /** Schema version string. */
  readonly schemaVersion: string;
  /** Live Zod schema for the kind-specific `data` payload. */
  readonly dataSchema: z.ZodType<TData>;
  /** Optional live Zod schema for the kind-specific scope shape. */
  readonly scopeSchema?: z.ZodType<TScope>;
  /**
   * JSON Pointer path(s) used to discriminate between concurrent
   * revisions within the same scope.
   */
  readonly discriminator?: string | readonly string[];
  /** Conflict resolution strategy for this kind. */
  readonly conflictPolicy: ArtifactKindRegistration['conflictPolicy'];
  /** Optional status field configuration. */
  readonly status?: ArtifactKindRegistration['status'];
  /** Optional live Zod schema for kind-specific observation extensions. */
  readonly observationSchema?: z.ZodType;
  /** Optional lifecycle hints for retention and decay. */
  readonly lifecycle?: ArtifactKindRegistration['lifecycle'];
  /** JSON Pointer paths to indexed fields within `data`. */
  readonly indexedFields?: readonly string[];
  /** JSON Pointer paths to searchable fields within `data`. */
  readonly searchableFields?: readonly string[];
  /**
   * Optional projection policy controlling how this artifact kind surfaces on
   * external providers.
   */
  readonly projection?: ArtifactProjectionPolicy;
  /**
   * Optional live-only lifecycle hooks. Not included in `toRegistration()`.
   *
   * Hooks carry function references and are never serialized or transmitted
   * over the bus.
   */
  readonly hooks?: ArtifactLifecycleHookDefinition;
}

/**
 * Converts a live Zod schema to a plain JSON Schema object.
 *
 * The `$schema` dialect marker is stripped so the resulting object can be
 * embedded directly in a registration payload without triggering
 * schema-dialect validation in consumers.
 * @param schema - The Zod schema to convert.
 * @returns A plain JSON Schema object without a `$schema` key.
 */
function toJsonSchemaObject(schema: z.ZodType): JsonSchemaObject {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema) as JsonSchemaObject & {
    $schema?: unknown;
  };
  return jsonSchema;
}

/**
 * Creates an artifact kind definition with live Zod schemas and a
 * serializable registration.
 *
 * The returned definition retains the live `dataSchema` and `scopeSchema`
 * for compile-time type narrowing and runtime validation. Calling
 * `toRegistration()` serialises the definition into an
 * {@link ArtifactKindRegistration} record that can be transmitted over the
 * bus and stored by the artifact service.
 * @param options - Kind definition options including data schema, scope
 *   schema, and registration metadata.
 * @returns An {@link ArtifactKindDefinition} with live schemas and a
 *   `toRegistration` method.
 * @example
 * ```ts
 * export const implementationPlanKind = defineArtifactKind({
 *   kind: 'implementation-plan',
 *   schemaVersion: '1',
 *   dataSchema: z.object({ status: z.enum(['draft', 'approved']), topic: z.string() }),
 *   conflictPolicy: 'supersedes',
 *   status: { path: '/data/status', values: ['draft', 'approved'] },
 *   indexedFields: ['/data/status'],
 * });
 * ```
 */
export function defineArtifactKind<TData extends Record<string, unknown>, TScope extends ArtifactScope = ArtifactScope>(
  options: DefineArtifactKindOptions<TData, TScope>,
): ArtifactKindDefinition<TData, TScope> {
  return {
    ...options,
    toRegistration: (): ArtifactKindRegistration => ({
      kind: options.kind,
      schemaVersion: options.schemaVersion,
      dataSchema: toJsonSchemaObject(options.dataSchema),
      ...(options.scopeSchema ? { scopeSchema: toJsonSchemaObject(options.scopeSchema) } : {}),
      ...(options.observationSchema ? { observationSchema: toJsonSchemaObject(options.observationSchema) } : {}),
      ...(options.discriminator !== undefined
        ? {
            discriminator:
              typeof options.discriminator === 'string' ? options.discriminator : Array.from(options.discriminator),
          }
        : {}),
      conflictPolicy: options.conflictPolicy,
      ...(options.status
        ? {
            status: {
              ...options.status,
              ...(options.status.values ? { values: [...options.status.values] } : {}),
            },
          }
        : {}),
      ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      ...(options.indexedFields ? { indexedFields: [...options.indexedFields] } : {}),
      ...(options.searchableFields ? { searchableFields: [...options.searchableFields] } : {}),
      ...(options.projection
        ? {
            projection: {
              ...options.projection,
              ...(options.projection.semanticEvents ? { semanticEvents: [...options.projection.semanticEvents] } : {}),
            },
          }
        : {}),
    }),
  };
}
