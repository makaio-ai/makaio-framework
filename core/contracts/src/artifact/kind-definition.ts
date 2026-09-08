import { z } from 'zod';
import type { ArtifactRevision } from './schemas.js';
import { ArtifactKindRegistrationSchema, type ArtifactKindRegistration } from './kind-registration.js';
import type { ArtifactLifecycleHookDefinition } from './lifecycle-hooks.js';
import { zodSchemaToJsonRecord } from '../shared/zod-json-schema.js';
import { assertSupportedKindSerialization, readArtifactTitle } from './kind-paths.js';

/**
 * Authoring contract with a live data schema. Scope remains a shared revision envelope.
 * @typeParam TData - Kind-specific data payload.
 */
export interface ArtifactKindDefinition<
  TData extends Record<string, unknown>,
  TKind extends string = string,
  TVersion extends number = number,
> extends Omit<ArtifactKindRegistration, 'dataSchema' | 'kind' | 'schemaVersion'> {
  /** Stable kind identifier, retained as a literal for inferred definitions. */
  readonly kind: TKind;
  /** Current schema generation, retained as a literal for inferred definitions. */
  readonly schemaVersion: TVersion;
  /** Live schema validating the complete data payload and its human-readable title. */
  readonly dataSchema: z.ZodType<TData>;
  /** Function-valued lifecycle hooks, never serialized into kind registrations. */
  readonly hooks?: ArtifactLifecycleHookDefinition;
  /** Phantom data type for typed artifact consumers; not assigned at runtime. */
  readonly __data?: TData;
  /** Produce an independent, validated bus registration. */
  readonly toRegistration: () => ArtifactKindRegistration;
}

/** Kind definition for heterogeneous registries. */
export type AnyArtifactKindDefinition = ArtifactKindDefinition<Record<string, unknown>>;

/** Extract the data payload. @typeParam T - Kind definition. */
export type ArtifactDataOf<T extends AnyArtifactKindDefinition> =
  T extends ArtifactKindDefinition<infer TData> ? TData : never;

/** Narrow a revision's payload while retaining its shared numeric schema version. @typeParam T - Kind definition. */
export type ArtifactOf<T extends AnyArtifactKindDefinition> = ArtifactRevision<ArtifactDataOf<T>> & {
  kind: T['kind'];
  schemaVersion: T['schemaVersion'];
};

/** Authoring options with live schema and optional local hooks. @typeParam TData - Data payload. */
type DefineArtifactKindOptions<
  TData extends Record<string, unknown>,
  TKind extends string,
  TVersion extends number,
> = Omit<ArtifactKindDefinition<TData, TKind, TVersion>, 'toRegistration' | '__data'>;

/**
 * Define a kind and validate its declarative metadata before registration.
 *
 * Raw input first passes the serialized canonical payload schema, preventing live
 * object schemas from silently stripping undeclared fields. The original input
 * then passes through the live Zod schema so dynamic defaults and refinements
 * retain their authoring semantics, followed by title validation. Serialized registrations
 * retain titlePath so hosts can enforce the same invariant via readArtifactTitle.
 * Hooks remain live-only; each registration call returns an independent snapshot.
 * @param options - Current kind contract, live schema and optional lifecycle hooks.
 * @returns A validated kind definition with typed data and serializable metadata.
 */
export function defineArtifactKind<
  TData extends Record<string, unknown>,
  const TKind extends string = string,
  const TVersion extends number = number,
>(options: DefineArtifactKindOptions<TData, TKind, TVersion>): ArtifactKindDefinition<TData, TKind, TVersion> {
  const { dataSchema, hooks, ...metadata } = options;
  const serializedDataSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...zodSchemaToJsonRecord(dataSchema),
  };
  assertSupportedKindSerialization(serializedDataSchema);
  const registration = ArtifactKindRegistrationSchema.parse({ ...metadata, dataSchema: serializedDataSchema });
  if (registration.kind !== options.kind) {
    throw new Error('Artifact kind identifiers must not contain surrounding whitespace');
  }
  const wireSchema = z.fromJSONSchema(registration.dataSchema);
  const rawInputSchema = z.unknown().superRefine((input, ctx) => {
    const result = wireSchema.safeParse(input);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
    }
  });
  const validatedSchema = rawInputSchema.pipe(dataSchema).superRefine((data, ctx) => {
    try {
      readArtifactTitle(data, registration.titlePath);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: registration.titlePath.split('.'),
        message: error instanceof Error ? error.message : 'Artifact title must be a nonblank string',
      });
    }
  });
  return {
    ...structuredClone(registration),
    kind: options.kind,
    schemaVersion: options.schemaVersion,
    dataSchema: validatedSchema,
    ...(hooks ? { hooks } : {}),
    toRegistration: () => structuredClone(registration),
  };
}
