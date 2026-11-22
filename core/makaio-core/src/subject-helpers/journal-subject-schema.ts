import type {
  BaseOf,
  EventJournalOptions,
  EventSchema,
  JournalSubjectSchema,
  RequestJournalOptions,
  RoutedSubjectSchema,
} from '../types/index.js';

/**
 * Create a journal subject schema wrapper.
 *
 * Declares journal behaviour for a subject: a bare event schema, a bare
 * `{ request, response }` pair, or exactly one existing routing wrapper
 * (`localSubject`, `channelSubject`, `collectorOnlySubject`, `hostLocalRequest`,
 * `defaultTransports`). The journal wrapper is always the outer layer; wrapping
 * an existing journal wrapper, or a schema already wrapped by two routing
 * wrappers, is rejected at the type level because neither satisfies
 * {@link RoutedSubjectSchema}.
 *
 * `options` is typed per the wrapped schema's kind: event options for an event
 * core, request options otherwise. A request is always volatile, so recording
 * options are only accepted for events. The selection is non-distributive over
 * `T`'s base schema: a `T` that is a union of a bare event and a bare request
 * schema resolves to request options, never to a union that would also admit
 * recording options. A routing wrapper around such a union is not a routed
 * subject of one kind and is rejected at the `schema` argument.
 * @typeParam T - The wrapped schema (bare or one existing wrapper)
 * @param schema - The schema to wrap
 * @param options - Journal options matching the wrapped schema's kind
 * @returns A JournalSubjectSchema wrapper
 * @example
 * ```typescript
 * import { journalSubject } from '@makaio/core';
 *
 * const EventSchemas = {
 *   // Recorded event, kept in the journal under schema version '1'
 *   created: journalSubject(z.object({ id: z.string() }), {
 *     retention: 'recorded',
 *     schemaVersion: '1',
 *     readOlder: { kind: 'as-recorded' },
 *   }),
 * };
 *
 * const RequestSchemas = {
 *   // Request journal entry: always volatile, only suggestedFor is accepted
 *   resolve: journalSubject(
 *     { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },
 *     { suggestedFor: { send: ['makaio.host'] } },
 *   ),
 * };
 * ```
 */
export function journalSubject<T extends RoutedSubjectSchema>(
  schema: T,
  options: [BaseOf<NoInfer<T>>] extends [EventSchema] ? EventJournalOptions : RequestJournalOptions,
): JournalSubjectSchema<T> {
  return Object.freeze({
    __journal: true,
    schema,
    options: snapshotJournalOptions(options),
  }) as JournalSubjectSchema<T>;
}

/**
 * Builds a deep-frozen snapshot of journal options, so a later mutation of the
 * caller's `options` object, or of its `suggestedFor` (`send`/`subscribe`),
 * `retainPayload` or `readOlder` sub-object, cannot change the declaration
 * `journalSubject()` already returned and the namespace registry may already
 * hold. `inspectSubjectSchema` applies it to every journal layer it reads, so
 * a wrapper built without this factory is isolated the same way. Every object the snapshot owns — `options` itself, `suggestedFor` and
 * its arrays, `retainPayload` when it is the `{ maxAgeMs }` form, and
 * `readOlder` — is a fresh, frozen copy. The `upgrade` function inside
 * `readOlder` is kept by reference: it is caller-supplied behaviour, not
 * state a snapshot needs to copy.
 * @param options - The caller's journal options
 * @returns A frozen snapshot of `options`
 */
export function snapshotJournalOptions<T extends EventJournalOptions | RequestJournalOptions>(options: T): T {
  const { suggestedFor, retainPayload, readOlder } = options;

  // Only keys the caller set are copied, so an absent option stays absent
  // instead of becoming an own `undefined` property.
  return Object.freeze({
    ...options,
    ...(suggestedFor && {
      suggestedFor: Object.freeze({
        ...(suggestedFor.send && { send: Object.freeze([...suggestedFor.send]) }),
        ...(suggestedFor.subscribe && { subscribe: Object.freeze([...suggestedFor.subscribe]) }),
      }),
    }),
    ...(typeof retainPayload === 'object' &&
      retainPayload !== null && { retainPayload: Object.freeze({ ...retainPayload }) }),
    ...(readOlder && { readOlder: Object.freeze({ ...readOlder }) }),
  }) as T;
}
