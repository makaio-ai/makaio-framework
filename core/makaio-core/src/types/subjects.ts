import type { MessagePayload, RequestMessagePayload } from './message.js';
import type { SubjectSchema } from './schema.js';
import type { InferSchemaPayload } from './type-helpers.js';
import type { Simplify } from 'type-fest';

export type SubjectRecord<
  SubjectKeys extends string = string,
  Payload extends MessagePayload = MessagePayload,
> = Record<SubjectKeys, Payload>;

export type SubjectRecordFromSchemaRecord<SchemaRecord extends Record<string, SubjectSchema>> = {
  [K in keyof SchemaRecord & string]: Simplify<InferSchemaPayload<SchemaRecord[K]>>;
};

export type SubjectDefinitionMeta<
  Subject extends SubjectRecord = SubjectRecord<'default'>,
  K extends keyof Subject = keyof Subject,
  Namespace extends string = string,
> = {
  isRequest: Subject extends SubjectRecord<'default'>
    ? boolean
    : Subject[K] extends RequestMessagePayload
      ? true
      : false;
  payload: K extends string ? Subject[K] : unknown;
  namespace: Namespace;
  /**
   * If true, this subject is local-only and will never be sent to transports.
   * Use for subjects whose payloads contain non-serializable data (e.g., React components).
   */
  local: boolean;
  /**
   * If true, this subject is channel-only and is only routable through the
   * DirectChannel encrypted point-to-point transport.
   */
  channel: boolean;
};

export type SubjectDefinition<
  Subject extends SubjectRecord = SubjectRecord,
  SubjectKey extends keyof Subject = keyof Subject,
  Namespace extends string = string,
> = {
  $meta: SubjectDefinitionMeta<Subject, SubjectKey, Namespace>;
  subject: SubjectKey;
};

export type SubjectDefinitionRecord<
  Subjects extends SubjectRecord = SubjectRecord,
  Namespace extends string = string,
> = {
  [SubjectKey in keyof Subjects]: {
    $meta: SubjectDefinitionMeta<Subjects, SubjectKey, Namespace>;
    subject: SubjectKey;
  };
};

/**
 * Utility types for accessing nested SubjectDefinition properties.
 * Eliminates repeated bracket notation and improves readability.
 */

/** Extract full $meta object */
export type ExtractSubjectMeta<T extends SubjectDefinition> = T['$meta'];

/** Extract isRequest discriminator */
export type ExtractSubjectIsRequest<T extends SubjectDefinition> = T['$meta']['isRequest'];

/** Extract payload (event payload or request/response pair) */
type ExtractInternalSubjectPayload<T extends SubjectDefinition> = T['$meta']['payload'];

/** Extract subject payload  */
export type ExtractSubjectPayload<T extends SubjectDefinition> =
  ExtractInternalSubjectPayload<T> extends RequestMessagePayload
    ? ExtractInternalSubjectPayload<T>['request']
    : ExtractInternalSubjectPayload<T>;

/** Extract response payload (request subjects only) */
export type ExtractSubjectResponse<T extends SubjectDefinition> =
  ExtractInternalSubjectPayload<T> extends RequestMessagePayload ? ExtractInternalSubjectPayload<T>['response'] : never;

/** Extract namespace string */
export type ExtractSubjectNamespace<T extends SubjectDefinition> = T['$meta']['namespace'];

/** Extract subject key */
export type ExtractSubjectKey<T extends SubjectDefinition> = T['subject'];

/**
 * Type guard to enforce proper SubjectDefinition structure.
 * Similar to StrictNamespace but more explicit.
 */
export type ValidSubjectDefinition<Domain extends string = string> = {
  $meta: {
    namespace: Domain;
    payload: MessagePayload;
    isRequest: boolean;
    local: boolean;
    channel: boolean;
  };
  subject: string;
};

export type ScopedSubjectDefinition<Namespace extends string = string> = SubjectDefinition<
  SubjectRecord,
  keyof SubjectRecord,
  Namespace
>;

/**
 * Extract the filterable payload from a MessagePayload.
 * For requests, returns the request part (what we filter on).
 * For events, returns the payload as-is.
 */
type FilterablePayload<P> = P extends RequestMessagePayload ? P['request'] : P;

/**
 * Union of all filterable payloads from a SubjectRecord.
 */
type FilterablePayloadsUnion<Subjects extends SubjectRecord> = FilterablePayload<Subjects[keyof Subjects]>;

/**
 * Extract keys from ANY member of a union type (distributive).
 *
 * For `{ a: 1, b: 2 } | { a: 1, c: 3 }`, returns `'a' | 'b' | 'c'`.
 */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * Extract value type for a key from union members that have it.
 */
type ValueOfKey<T, K extends PropertyKey> = T extends { [P in K]: infer V } ? V : never;

/**
 * Build an object type with ALL keys from ANY union member.
 *
 * For `{ type: 'a', id: string } | { type: 'b', name: string }`:
 * Result = `{ type: 'a' | 'b', id: string, name: string }`
 *
 * Allows filtering by any key that exists in any payload.
 */
type AllPropertiesOfUnion<T> = {
  [K in KeysOfUnion<T>]: ValueOfKey<T, K>;
};

/**
 * Union of all filterable payload properties from a SubjectRecord.
 *
 * Collects ALL keys from ANY payload, allowing filtering by any field.
 * Events without a filtered key simply won't match.
 * @example
 * ```typescript
 * // Given subjects with payloads:
 * // - 'event': { agentId: string, foo: number }
 * // - 'request': { sessionId: string }
 *
 * // FilterablePayloadUnion = { agentId: string, foo: number, sessionId: string }
 *
 * // Filter can use any key from any payload
 * bus.withFilter({ agentId: 'x' }); // ✅ matches events with agentId
 * bus.withFilter({ sessionId: 'y' }); // ✅ matches requests with sessionId
 * ```
 */
export type FilterablePayloadIntersection<Subjects extends SubjectRecord> = Simplify<
  AllPropertiesOfUnion<FilterablePayloadsUnion<Subjects>>
>;

/**
 * Compute FilterPayload directly from a schema record.
 *
 * This bypasses SubjectRecordFromSchemaRecord and computes directly from schemas,
 * which TypeScript can evaluate because Schemas is concrete at registration time.
 */
export type FilterPayloadFromSchemas<Schemas extends Record<string, SubjectSchema>> = Simplify<
  AllPropertiesOfUnion<
    {
      [K in keyof Schemas]: FilterablePayload<InferSchemaPayload<Schemas[K]>>;
    }[keyof Schemas]
  >
>;
