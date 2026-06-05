import { z } from 'zod';

/**
 * Zod metadata key under which observability policies are stored.
 *
 * Using a namespaced string key avoids collisions with any other metadata
 * that callers attach to a schema via `.meta()`.
 */
export const OBSERVABILITY_META_KEY = 'makaio.observability';

/**
 * Schema-level observability policy attached to a Zod object schema via
 * {@link observability.schema}.
 */
export interface ObservabilitySchemaPolicy {
  /**
   * When `true`, all scalar fields of the schema are projected to telemetry
   * unless a field opts out with `visibility: 'hidden'`.
   */
  readonly traceAll?: boolean;
}

/** Controls how a single field participates in subject telemetry projection. */
export type ObservabilityFieldVisibility = 'attribute' | 'hidden' | 'count';

/**
 * Field-level observability policy attached to a Zod field schema via
 * {@link observability.field}, {@link observability.hidden},
 * {@link observability.count}, or {@link observability.attribute}.
 */
export interface ObservabilityFieldPolicy {
  /** How this field participates in subject telemetry projection. */
  readonly visibility: ObservabilityFieldVisibility;
  /**
   * Telemetry attribute name for this field.
   * Defaults to the object property key when absent.
   */
  readonly attributeName?: string;
}

// ---------------------------------------------------------------------------
// Internal stored shapes — not part of the public API.
// ---------------------------------------------------------------------------

interface StoredSchemaPolicy {
  readonly kind: 'schema';
  readonly traceAll?: boolean;
}

interface StoredFieldPolicy {
  readonly kind: 'field';
  readonly visibility: ObservabilityFieldVisibility;
  readonly attributeName?: string;
}

type StoredPolicy = StoredSchemaPolicy | StoredFieldPolicy;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Reads the stored {@link StoredPolicy} from a schema's Zod metadata, if present.
 * Returns `undefined` when no policy is found or the stored value has an
 * unrecognised shape.
 * @param schema - The Zod schema to inspect.
 * @returns The stored policy, or `undefined`.
 */
function readStoredPolicy(schema: z.ZodType): StoredPolicy | undefined {
  const metadata = schema.meta();
  const value = metadata?.[OBSERVABILITY_META_KEY];
  if (value === undefined || value === null || typeof value !== 'object') {
    return undefined;
  }
  const policy = value as Partial<StoredPolicy>;
  return policy.kind === 'schema' || policy.kind === 'field' ? (policy as StoredPolicy) : undefined;
}

/**
 * Writes a {@link StoredPolicy} into a schema's Zod metadata, preserving any
 * other metadata keys already present on the schema.
 * @param schema - The Zod schema to annotate.
 * @param policy - The policy to store.
 * @returns A new schema instance with the policy merged into its metadata.
 */
function writeStoredPolicy<TSchema extends z.ZodType>(schema: TSchema, policy: StoredPolicy): TSchema {
  return schema.meta({
    ...schema.meta(),
    [OBSERVABILITY_META_KEY]: policy,
  }) as TSchema;
}

/**
 * Unwraps one transparent wrapper schema layer (Optional, Nullable, Default,
 * Catch, Readonly), if the schema is such a wrapper.
 *
 * Field-level metadata may be attached before or after wrapping, so callers
 * inspect every transparent layer instead of jumping directly to the innermost
 * schema.
 * @param schema - The Zod schema to unwrap.
 * @returns The wrapped schema, or `undefined` when the input is not a supported transparent wrapper.
 */
function unwrapMetadataLayer(schema: z.ZodType): z.ZodType | undefined {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly
  ) {
    // `unwrap()` is typed as returning `T extends core.SomeType` (the default
    // generic parameter), but at runtime the inner value is always a full
    // ZodType. The single cast is safe: `core.$ZodType ⊂ z.ZodType` structurally.
    return schema.unwrap() as z.ZodType;
  }
  return undefined;
}

/**
 * Reads the first field policy found while walking transparent wrapper layers
 * from outermost to innermost.
 *
 * This preserves wrapper-level override semantics while still allowing policy
 * attached to an intermediate wrapper to survive additional wrapping.
 * @param schema - The Zod field schema to inspect.
 * @returns The stored field policy, or `undefined`.
 */
function readFieldPolicyAcrossWrappers(schema: z.ZodType): StoredFieldPolicy | undefined {
  let currentSchema: z.ZodType | undefined = schema;
  while (currentSchema) {
    const policy = readStoredPolicy(currentSchema);
    if (policy?.kind === 'field') {
      return policy;
    }
    currentSchema = unwrapMetadataLayer(currentSchema);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public readers
// ---------------------------------------------------------------------------

/**
 * Returns the {@link ObservabilitySchemaPolicy} stored on a schema, or
 * `undefined` if the schema has no schema-level observability metadata.
 * @param schema - The Zod schema to inspect.
 * @returns The schema-level observability policy, or `undefined`.
 */
export function getObservabilitySchemaPolicy(schema: z.ZodType): ObservabilitySchemaPolicy | undefined {
  const policy = readStoredPolicy(schema);
  if (policy?.kind !== 'schema') {
    return undefined;
  }
  return { traceAll: policy.traceAll };
}

/**
 * Returns the {@link ObservabilityFieldPolicy} stored on a field schema, or
 * `undefined` if no field-level observability metadata is found.
 *
 * The lookup walks transparent wrapper layers from outermost to innermost so
 * wrapper-level metadata can override inner metadata, and metadata attached to
 * any intermediate wrapper remains readable after additional wrapping.
 * @param schema - The Zod field schema to inspect.
 * @returns The field-level observability policy, or `undefined`.
 */
export function getObservabilityFieldPolicy(schema: z.ZodType): ObservabilityFieldPolicy | undefined {
  const fieldPolicy = readFieldPolicyAcrossWrappers(schema);
  if (!fieldPolicy) {
    return undefined;
  }
  return {
    visibility: fieldPolicy.visibility,
    attributeName: fieldPolicy.attributeName,
  };
}

// ---------------------------------------------------------------------------
// Public builder namespace
// ---------------------------------------------------------------------------

/**
 * Fluent helpers for attaching observability metadata to Zod schemas.
 *
 * All methods return a new schema instance — Zod schemas are immutable. The
 * original schema is never mutated.
 * @example
 * ```typescript
 * const RequestSchema = observability.schema(
 *   z.object({ query: z.string(), limit: z.number() }),
 *   { traceAll: true },
 * );
 *
 * const HiddenField = observability.hidden(z.string()).optional();
 * ```
 */
export const observability = {
  /**
   * Attaches a schema-level {@link ObservabilitySchemaPolicy} to a Zod schema.
   * Preserves any metadata already present on the schema.
   * @param schema - The Zod schema to annotate.
   * @param policy - The schema-level observability policy to store.
   * @returns A new schema instance with the policy merged into its metadata.
   */
  schema<TSchema extends z.ZodType>(schema: TSchema, policy: ObservabilitySchemaPolicy): TSchema {
    return writeStoredPolicy(schema, {
      kind: 'schema',
      traceAll: policy.traceAll,
    });
  },

  /**
   * Attaches a field-level {@link ObservabilityFieldPolicy} to a Zod schema.
   * Preserves any metadata already present on the schema.
   * @param schema - The Zod field schema to annotate.
   * @param policy - The field-level observability policy to store.
   * @returns A new schema instance with the policy merged into its metadata.
   */
  field<TSchema extends z.ZodType>(schema: TSchema, policy: ObservabilityFieldPolicy): TSchema {
    return writeStoredPolicy(schema, {
      kind: 'field',
      visibility: policy.visibility,
      attributeName: policy.attributeName,
    });
  },

  /**
   * Marks a field as hidden from subject telemetry projection.
   * @param schema - The Zod field schema to hide.
   * @returns A new schema instance with `visibility: 'hidden'` stored in its metadata.
   */
  hidden<TSchema extends z.ZodType>(schema: TSchema): TSchema {
    return writeStoredPolicy(schema, { kind: 'field', visibility: 'hidden' });
  },

  /**
   * Marks a field to be projected as a count metric in subject telemetry.
   * @param schema - The Zod field schema to count.
   * @param attributeName - Optional telemetry attribute name override.
   * @returns A new schema instance with `visibility: 'count'` stored in its metadata.
   */
  count<TSchema extends z.ZodType>(schema: TSchema, attributeName?: string): TSchema {
    return writeStoredPolicy(schema, {
      kind: 'field',
      visibility: 'count',
      attributeName,
    });
  },

  /**
   * Marks a field to be projected as a named attribute in subject telemetry.
   * @param schema - The Zod field schema to expose as an attribute.
   * @param attributeName - Optional telemetry attribute name override.
   * @returns A new schema instance with `visibility: 'attribute'` stored in its metadata.
   */
  attribute<TSchema extends z.ZodType>(schema: TSchema, attributeName?: string): TSchema {
    return writeStoredPolicy(schema, {
      kind: 'field',
      visibility: 'attribute',
      attributeName,
    });
  },
};
