import { isRequestSchema } from './is-request-schema.js';
import { isChannelSchema } from './channel-schema.js';
import { isLocalSchema } from './local-schema.js';
import { unwrapSchema } from './unwrap-schema.js';
import { PartialDeep } from 'type-fest';
import {
  type InferSubjectMeta,
  type SubjectDefinition,
  type SubjectSchema,
  type WildcardSubjectDefinition,
  WildcardSubjectKey,
} from '@makaio/core';

/**
 * Recursively nests a flat record of dotted keys into a hierarchical object type.
 *
 * ```
 * { 'assistant.text': SubjectDef, 'agent.tool.started': SubjectDef }
 * → { assistant: { text: SubjectDef }, agent: { tool: { started: SubjectDef } } }
 * ```
 *
 * Used to expose registered subjects as a nested accessor tree (e.g.
 * `BootSubjects.service.ready`) without requiring callers to deal with
 * flat dotted-key strings at the type level.
 */
// Recursively nests dotted keys for an arbitrary map type T
export type NestedSubjectDefinitions<T extends Record<string, unknown> = Record<string, SubjectDefinition>> = {
  [K in ExtractPrefixes<keyof T & string>]: NestByPrefix<T, K>;
};

type ExtractPrefixes<Keys extends string> = Keys extends `${infer Prefix}.${string}` ? Prefix : Keys;

// Helper to strip a given prefix segment from keys
type StripPrefixMap<T, Prefix extends string> = {
  [K in keyof T as K extends `${Prefix}.${infer Rest}` ? Rest : never]: T[K];
};

type NestByPrefix<T extends Record<string, unknown>, Prefix extends string> = Prefix extends keyof T
  ? T[Prefix]
  : NestedSubjectDefinitions<StripPrefixMap<T, Prefix>>;

/**
 * Maps a flat schema record to a flat subject-definition record, attaching the
 * correct `$meta` (namespace, isRequest, local, channel) and `subject` key for
 * each entry.
 *
 * Intermediate type used by {@link nestSubjectDefinitions} before nesting.
 * @typeParam Domain - Namespace domain string (e.g. `'boot'`)
 * @typeParam Schemas - Flat record of raw Zod schemas keyed by dotted subject names
 */
export type FlatSubjectDefinitions<Domain extends string, Schemas extends Record<string, SubjectSchema>> = {
  [K in keyof Schemas & string]: {
    $meta: InferSubjectMeta<Schemas[K], Domain>;
    subject: K;
  };
};

/**
 * Fully-nested subject accessor tree returned by `registerNamespace`.
 *
 * Combines the {@link NestedSubjectDefinitions} hierarchy with a `$all`
 * wildcard that matches every subject in the namespace. Consumers use this
 * type to write `SomeNamespace.subjects.foo.bar` instead of raw strings.
 * @typeParam RecordOfSubjectDefinitions - Flat record of subject definitions
 * @typeParam Domain - Namespace domain string used for `$all` wildcard typing
 */
export type BusSubjects<
  RecordOfSubjectDefinitions extends Record<string, unknown> = Record<string, SubjectDefinition>,
  Domain extends string = string,
> = NestedSubjectDefinitions<RecordOfSubjectDefinitions> & {
  $all: WildcardSubjectDefinition<Domain>;
};

/**
 * Nests flat dotted subject keys into a hierarchical structure
 * @param namespace - The domain/namespace for the subject definitions
 * @param flat - Flat record of subject schemas with dotted keys
 * @returns Nested subject definitions with hierarchical structure and a $all wildcard
 */
export function nestSubjectDefinitions<Domain extends string, T extends Record<string, SubjectSchema>>(
  namespace: Domain,
  flat: T,
): NestedSubjectDefinitions<FlatSubjectDefinitions<Domain, T>> & {
  $all: WildcardSubjectDefinition<Domain>;
} {
  const nested: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(flat)) {
    const parts = key.split('.');
    let current = nested;
    for (let i = 0; i < parts.length - 1; i++) {
      current[parts[i]] ??= {};
      current = current[parts[i]] as Record<string, unknown>;
    }

    // Check if schema is wrapped as local or channel and unwrap for type detection
    const local = isLocalSchema(schema);
    const channel = isChannelSchema(schema);
    const innerSchema = unwrapSchema(schema);

    const definition: PartialDeep<SubjectDefinition> = {
      subject: key,
      $meta: {
        namespace,
        isRequest: isRequestSchema(innerSchema),
        local,
        channel,
      },
    };

    current[parts[parts.length - 1]] = definition as SubjectDefinition;
  }

  // register wildcard
  nested['$all'] = {
    subject: WildcardSubjectKey,
    $meta: {
      namespace,
      isRequest: false,
      local: false,
      channel: false,
    },
  };

  return nested as NestedSubjectDefinitions<FlatSubjectDefinitions<Domain, T>> & {
    $all: WildcardSubjectDefinition<Domain>;
  };
}

/**
 * Gets the fully qualified subject name in namespace.subject format
 * @param subject - The subject definition to format
 * @returns The full subject string in the format "namespace.subject"
 */
export function getFullSubjectForSubjectDefinition(subject: SubjectDefinition): string {
  return `${subject.$meta.namespace}.${subject.subject}`;
}
