import { z, ZodType } from 'zod';
import type { JsonValue } from './json-value.js';
import type { PartyKind } from './party.js';
import type { TransportRoutingDefault } from './subjects.js';

/**
 * Schema definition for event subjects (fire-and-forget).
 * Events have only a payload schema, no response.
 * The payload is now separate from the context, so no restrictions needed.
 */
export type EventSchema = z.ZodType;

/**
 * Schema definition for request subjects (request-response).
 * Requests have both a request payload schema and a response schema.
 */
export type RequestSchema<Request extends ZodType = ZodType, Response extends ZodType = ZodType> = {
  request: Request;
  response: Response;
};

/**
 * Wrapper to mark a subject as local-only (never sent to transports).
 *
 * Use `localSubject()` from `@makaio/bus-core` to create these.
 * @example
 * ```typescript
 * import { localSubject } from '@makaio/bus-core';
 *
 * const WidgetSchemas = {
 *   register: localSubject(widgetDefinitionSchema),  // local event
 *   unregister: localSubject(z.object({ widgetId: z.string() })),
 * };
 * ```
 */
export type LocalSubjectSchema<T extends EventSchema | RequestSchema = EventSchema | RequestSchema> = {
  readonly __local: true;
  readonly schema: T;
};

/**
 * Wrapper to mark an event subject as collector-only.
 *
 * Collector-only events may be received from a transport and delivered to local
 * handlers, but the receiving bus must not relay them onward to other
 * transports. Local emits are also kept local.
 */
export type CollectorOnlySubjectSchema<T extends EventSchema = EventSchema> = {
  readonly __collectorOnly: true;
  readonly schema: T;
};

/**
 * Wrapper to mark a subject as channel-only (encrypted point-to-point).
 *
 * Channel subjects are rejected by public bus methods and are only
 * routable through the DirectChannel encrypted transport. Use
 * `channelSubject()` from `@makaio/bus-core` to create these.
 * @example
 * ```typescript
 * import { channelSubject } from '@makaio/bus-core';
 *
 * const DirectSchemas = {
 *   message: channelSubject(z.object({ text: z.string() })),
 *   ping: channelSubject({
 *     request: z.object({ ts: z.number() }),
 *     response: z.object({ ts: z.number() }),
 *   }),
 * };
 * ```
 */
export type ChannelSubjectSchema<T extends EventSchema | RequestSchema = EventSchema | RequestSchema> = {
  readonly __channel: true;
  readonly schema: T;
};

/**
 * Wrapper to mark a request subject as host-local.
 *
 * Host-local requests accept direct remote ingress (a transport may deliver
 * the request to this host), but the receiving bus must never relay the
 * request onward to other transports. Only request schemas are accepted;
 * events are rejected at the type level.
 *
 * Use `hostLocalRequest()` from `@makaio/core` to create these.
 */
export type HostLocalRequestSubjectSchema<T extends RequestSchema = RequestSchema> = {
  readonly __hostLocalRequest: true;
  readonly schema: T;
};

/**
 * Wrapper to set a subject-level default transport routing policy.
 *
 * This is weaker than `localSubject()`: the subject remains routable remotely,
 * but local callers that omit an explicit `transports` option use this default.
 */
export type DefaultTransportsSubjectSchema<
  T extends EventSchema | RequestSchema = EventSchema | RequestSchema,
  Default extends TransportRoutingDefault = TransportRoutingDefault,
> = {
  readonly __defaultTransports: Default;
  readonly schema: T;
};

/**
 * Base schema types (unwrapped).
 */
export type BaseSubjectSchema = EventSchema | RequestSchema;

/**
 * Union of all subject schema types, including the routing wrappers and the
 * journal wrapper.
 */
export type SubjectSchema =
  | BaseSubjectSchema
  | LocalSubjectSchema
  | CollectorOnlySubjectSchema
  | ChannelSubjectSchema
  | HostLocalRequestSubjectSchema
  | DefaultTransportsSubjectSchema
  | JournalSubjectSchema;

export type SchemaRecord = Record<string, SubjectSchema>;

/**
 * A bare schema or exactly one of the existing routing wrappers
 * (`localSubject`, `channelSubject`, `collectorOnlySubject`, `hostLocalRequest`,
 * `defaultTransports`).
 *
 * This is the set of schemas a journal wrapper may wrap. It deliberately excludes
 * {@link JournalSubjectSchema}, so the journal layer is always the outer layer and
 * a stack has at most two layers. Wrappers that accept both kinds are listed once
 * per kind, so distributing over this union keeps every wrapper paired with the
 * journal options of its kind.
 */
export type RoutedSubjectSchema =
  | BaseSubjectSchema
  | LocalSubjectSchema<EventSchema>
  | LocalSubjectSchema<RequestSchema>
  | CollectorOnlySubjectSchema
  | ChannelSubjectSchema<EventSchema>
  | ChannelSubjectSchema<RequestSchema>
  | HostLocalRequestSubjectSchema
  | DefaultTransportsSubjectSchema<EventSchema>
  | DefaultTransportsSubjectSchema<RequestSchema>;

/**
 * How a recorded event is read back when its stored schema version differs from
 * the current one.
 */
export type OlderVersionStrategy =
  | {
      /** Entries are handed to readers exactly as they were recorded. */
      readonly kind: 'as-recorded';
    }
  | {
      /** Entries are converted to the current shape by `upgrade` before reading. */
      readonly kind: 'upgrade';
      /**
       * Converts a recorded payload to the current shape.
       * @param payload - The payload as it was recorded
       * @param fromVersion - The schema version the payload was recorded with
       * @returns The payload in the current shape
       */
      upgrade(payload: JsonValue, fromVersion: string): JsonValue;
    };

/**
 * Parties for which a subject is suggested, per direction.
 */
export type SubjectSuggestedFor = {
  /** Party kinds that are suggested to send this subject. */
  readonly send?: readonly PartyKind[];
  /** Party kinds that are suggested to subscribe to this subject. */
  readonly subscribe?: readonly PartyKind[];
};

/**
 * Options of a journal wrapper.
 *
 * - Request schemas (`{ request, response }` as a whole) accept only `suggestedFor`;
 *   a request is always volatile.
 * - Event schemas are volatile by default. `retention: 'recorded'` requires
 *   `schemaVersion` and `readOlder`; `retainPayload` exists only with `recorded`.
 * - A wrapped schema that is not known to be an event (a request, or an unresolved
 *   mix of both kinds) gets the request options, so a request can never be recorded.
 * - Distributes over a union of wrapped schemas: without an argument it is the union
 *   of both option kinds.
 * @typeParam T - The wrapped schema (bare or one existing wrapper)
 */
export type JournalOptions<T extends SubjectSchema = RoutedSubjectSchema> = T extends SubjectSchema
  ? [BaseOf<T>] extends [EventSchema]
    ? EventJournalOptions
    : RequestJournalOptions
  : never;

/**
 * Journal options of a request: only `suggestedFor`, a request is always volatile.
 */
export type RequestJournalOptions = {
  /** Parties for which the subject is suggested. */
  readonly suggestedFor?: SubjectSuggestedFor;
  /** Not allowed on requests: a request is always volatile. */
  readonly retention?: never;
  /** Not allowed on requests: a request is always volatile. */
  readonly retainPayload?: never;
  /** Not allowed on requests: a request is always volatile. */
  readonly schemaVersion?: never;
  /** Not allowed on requests: a request is always volatile. */
  readonly readOlder?: never;
};

/**
 * Journal options of an event: volatile by default; `retention: 'recorded'`
 * requires `schemaVersion` and `readOlder`, and only then allows `retainPayload`.
 */
export type EventJournalOptions = {
  /** Parties for which the subject is suggested. */
  readonly suggestedFor?: SubjectSuggestedFor;
} & (
  | {
      /** The event is not kept in the journal (default). */
      readonly retention?: 'volatile';
      /** Not allowed on volatile events: only recorded events retain payloads. */
      readonly retainPayload?: never;
      /** Optional schema version of a volatile event. */
      readonly schemaVersion?: string;
      /** Optional strategy for older versions of a volatile event. */
      readonly readOlder?: OlderVersionStrategy;
    }
  | {
      /** The event is kept in the journal. */
      readonly retention: 'recorded';
      /** How long the payload is retained: forever (`'keep'`) or for `maxAgeMs` milliseconds (positive integer). */
      readonly retainPayload?: 'keep' | { readonly maxAgeMs: number };
      /** Version of the recorded payload schema. */
      readonly schemaVersion: string;
      /** How entries recorded with another schema version are read. */
      readonly readOlder: OlderVersionStrategy;
    }
);

/**
 * Wrapper that declares journal behaviour for a subject.
 *
 * Wraps a bare schema or exactly one existing routing wrapper and is always the
 * outer layer: the reverse nesting and two existing wrappers inside each other do
 * not satisfy {@link RoutedSubjectSchema} and therefore do not compile.
 * @typeParam T - The wrapped schema (bare or one existing wrapper)
 */
export type JournalSubjectSchema<T extends RoutedSubjectSchema = RoutedSubjectSchema> = T extends RoutedSubjectSchema
  ? {
      readonly __journal: true;
      readonly schema: T;
      readonly options: JournalOptions<T>;
    }
  : never;

/**
 * A routing wrapper on its own or as the inner layer of a journal wrapper.
 *
 * Wrapper guards narrow to this whole outer schema: a journal wrapper that
 * contains a local wrapper is "local", but it is never itself a
 * {@link LocalSubjectSchema}. The journal alternative keeps the wrapper's concrete
 * inner schema and its own routing parameters (for example the `Default` of
 * {@link DefaultTransportsSubjectSchema}); a wrapper over the mix of events and
 * requests distributes by kind, so one journal alternative exists per kind.
 * @typeParam W - The routing wrapper type
 */
export type JournalOrSelf<W extends SubjectSchema> =
  | W
  | (W extends LocalSubjectSchema<infer T>
      ? JournalSubjectSchema<T extends EventSchema | RequestSchema ? LocalSubjectSchema<T> : never>
      : W extends ChannelSubjectSchema<infer T>
        ? JournalSubjectSchema<T extends EventSchema | RequestSchema ? ChannelSubjectSchema<T> : never>
        : W extends CollectorOnlySubjectSchema<infer T extends EventSchema>
          ? JournalSubjectSchema<CollectorOnlySubjectSchema<T>>
          : W extends HostLocalRequestSubjectSchema<infer T extends RequestSchema>
            ? JournalSubjectSchema<HostLocalRequestSubjectSchema<T>>
            : W extends DefaultTransportsSubjectSchema<infer T, infer D extends TransportRoutingDefault>
              ? JournalSubjectSchema<
                  T extends EventSchema | RequestSchema ? DefaultTransportsSubjectSchema<T, D> : never
                >
              : W extends RoutedSubjectSchema
                ? JournalSubjectSchema<W>
                : never);

/**
 * The schema directly inside exactly one of the five routing wrappers, or `S`
 * itself when it is not one of them.
 *
 * Recognizes the five routing brands by the same conditions as the runtime
 * traversal and unwraps at most one: a routing layer is never itself
 * wrapped by another routing layer, so one `extends` check per brand is the
 * whole traversal.
 * @typeParam S - The schema layer beneath an optional journal wrapper
 */
export type RoutingInnerOf<S> = S extends { readonly __local: true; readonly schema: infer Inner }
  ? Inner
  : S extends { readonly __collectorOnly: true; readonly schema: infer Inner }
    ? Inner
    : S extends { readonly __channel: true; readonly schema: infer Inner }
      ? Inner
      : S extends { readonly __hostLocalRequest: true; readonly schema: infer Inner }
        ? Inner
        : S extends { readonly __defaultTransports: TransportRoutingDefault; readonly schema: infer Inner }
          ? Inner
          : S;

/**
 * Innermost bare schema of a (possibly wrapped) subject schema.
 *
 * Follows the same rule as the runtime traversal (`inspectSubjectSchema`):
 * if `S` is a journal layer, unwrap it, then unwrap at most one routing layer
 * beneath it; otherwise unwrap at most one routing layer of `S` itself. Neither
 * branch recurses, so a routing layer's own `schema` (for example arbitrary
 * nested data that happens to carry a routing brand) is never mistaken for a
 * further layer.
 * @typeParam S - The subject schema
 */
export type BaseOf<S> = S extends { readonly __journal: true; readonly schema: infer Inner }
  ? RoutingInnerOf<Inner>
  : RoutingInnerOf<S>;

/**
 * The schema layer that carries the routing marks of a subject schema.
 *
 * For a journal-wrapped schema this is the layer inside the journal wrapper; for
 * every other schema it is the schema itself.
 * @typeParam S - The subject schema
 */
export type MarksOf<S> = S extends { readonly __journal: true; readonly schema: infer Inner } ? Inner : S;
