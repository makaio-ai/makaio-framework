import { describe, expect, it, expectTypeOf } from 'vitest';
import { z } from 'zod';
// Everything comes through the package root, so the test also proves the public exports.
import { channelSubject, createBusNamespace, defaultTransports, journalSubject, localSubject } from '../index.js';
import type {
  BaseOf,
  HostLocalRequestSubjectSchema,
  InferSchemaPayload,
  InferSubjectMeta,
  JournalOptions,
  JournalSubjectSchema,
  LocalSubjectSchema,
  RequestJournalOptions,
  RoutedSubjectSchema,
  SubjectSchema,
} from '../index.js';

/**
 * Type-level tests: the assertions are the `@ts-expect-error` lines and the
 * `expectTypeOf` calls. The type check reports an unused directive, so a line
 * that stops being an error fails the check. Most cases are object literals
 * typed directly against the exported types; the runtime body only proves the file loads. Cases that exercise
 * `journalSubject()` itself call the factory directly.
 */

const eventSchema = z.object({ name: z.string() });
const requestSchema = { request: z.string(), response: z.string() };
const asRecorded = { kind: 'as-recorded' as const };
const recordedBase = { retention: 'recorded' as const, schemaVersion: '1', readOlder: asRecorded };

/**
 * Accepts (or, via `@ts-expect-error`, rejects) a fresh literal as a journal subject.
 * @param _value - The literal under test
 */
function asJournal(_value: JournalSubjectSchema): void {}
/**
 * Accepts (or, via `@ts-expect-error`, rejects) a fresh literal as any subject schema.
 * @param _value - The literal under test
 */
function asAny(_value: SubjectSchema): void {}

/** Never called; compiled only. */
function typeAssertions(): void {
  // Accepted: volatile event; recorded event (both readOlder strategies, both
  // retainPayload forms); request with only suggestedFor; journal over
  // localSubject(event) recorded and over localSubject(request).
  const volatileEvent: JournalSubjectSchema = { __journal: true, schema: eventSchema, options: {} };
  const recordedAsRecorded: JournalSubjectSchema = { __journal: true, schema: eventSchema, options: recordedBase };
  const recordedUpgrade: JournalSubjectSchema = {
    __journal: true,
    schema: eventSchema,
    options: { ...recordedBase, readOlder: { kind: 'upgrade', upgrade: (p) => p } },
  };
  const recordedKeep: JournalSubjectSchema = {
    __journal: true,
    schema: eventSchema,
    options: { ...recordedBase, retainPayload: 'keep' },
  };
  const recordedMaxAge: JournalSubjectSchema = {
    __journal: true,
    schema: eventSchema,
    options: { ...recordedBase, retainPayload: { maxAgeMs: 60000 } },
  };
  const requestOnly: JournalSubjectSchema = {
    __journal: true,
    schema: requestSchema,
    options: { suggestedFor: { send: ['makaio.host'] } },
  };
  const journalOverLocalEvent: JournalSubjectSchema = {
    __journal: true,
    schema: localSubject(eventSchema),
    options: recordedBase,
  };
  const journalOverLocalRequest: JournalSubjectSchema = {
    __journal: true,
    schema: localSubject(requestSchema),
    options: { suggestedFor: { subscribe: ['makaio.host'] } },
  };
  [
    volatileEvent,
    recordedAsRecorded,
    recordedUpgrade,
    recordedKeep,
    recordedMaxAge,
    requestOnly,
    journalOverLocalEvent,
    journalOverLocalRequest,
  ].forEach(asAny);

  // Rejected. Every rejected call stays on ONE line, so the directive above it covers
  // the error wherever the compiler reports it (argument or property).
  // @ts-expect-error recorded events require readOlder
  asJournal({ __journal: true, schema: eventSchema, options: { retention: 'recorded', schemaVersion: '1' } });
  // @ts-expect-error recorded events require schemaVersion
  asJournal({ __journal: true, schema: eventSchema, options: { retention: 'recorded', readOlder: asRecorded } });
  // @ts-expect-error retainPayload is not allowed on a volatile event
  asJournal({ __journal: true, schema: eventSchema, options: { retainPayload: 'keep' } });
  // @ts-expect-error a request is always volatile, retention is not allowed
  asJournal({ __journal: true, schema: requestSchema, options: { retention: 'volatile' } });

  // Rejected: retention: 'recorded' on a request wrapped by localSubject,
  // channelSubject and defaultTransports, against both the default
  // JournalSubjectSchema and SubjectSchema.
  const localRequest = localSubject(requestSchema);
  const channelRequest = channelSubject(requestSchema);
  const defaultTransportsRequest = defaultTransports(requestSchema, 'all');
  // @ts-expect-error a wrapped request is still always volatile
  asJournal({ __journal: true, schema: localRequest, options: recordedBase });
  // @ts-expect-error a wrapped request is still always volatile
  asAny({ __journal: true, schema: localRequest, options: recordedBase });
  // @ts-expect-error a wrapped request is still always volatile
  asJournal({ __journal: true, schema: channelRequest, options: recordedBase });
  // @ts-expect-error a wrapped request is still always volatile
  asAny({ __journal: true, schema: channelRequest, options: recordedBase });
  // @ts-expect-error a wrapped request is still always volatile
  asJournal({ __journal: true, schema: defaultTransportsRequest, options: recordedBase });
  // @ts-expect-error a wrapped request is still always volatile
  asAny({ __journal: true, schema: defaultTransportsRequest, options: recordedBase });

  // Rejected: journal over journal; journal over two existing wrappers (the factories
  // already refuse to nest, so the inner layers are built by hand).
  const journalOverEvent = { __journal: true as const, schema: eventSchema, options: {} };
  const localOverChannel = { __local: true as const, schema: { __channel: true as const, schema: eventSchema } };
  // @ts-expect-error a journal cannot wrap another journal
  asJournal({ __journal: true, schema: journalOverEvent, options: {} });
  // @ts-expect-error two existing wrappers inside each other is not a RoutedSubjectSchema
  asJournal({ __journal: true, schema: localOverChannel, options: {} });

  // JournalOptions of an unresolved mix of event and request (a bare LocalSubjectSchema,
  // whose wrapped kind is not known) is the request options.
  expectTypeOf<JournalOptions<LocalSubjectSchema>>().toEqualTypeOf<RequestJournalOptions>();

  // Inference: BaseOf / payload / meta for a journal over localSubject(z.object(...)).
  type JournalOverLocal = JournalSubjectSchema<LocalSubjectSchema<typeof eventSchema>>;
  expectTypeOf<BaseOf<JournalOverLocal>>().toEqualTypeOf<typeof eventSchema>();
  expectTypeOf<InferSchemaPayload<JournalOverLocal>>().toEqualTypeOf<{ name: string }>();
  expectTypeOf<InferSubjectMeta<JournalOverLocal, 'test'>['local']>().toEqualTypeOf<true>();

  type JournalOverBare = JournalSubjectSchema<typeof eventSchema>;
  expectTypeOf<InferSubjectMeta<JournalOverBare, 'test'>['local']>().toEqualTypeOf<false>();

  // BaseOf of one non-journal wrapper per kind stays unchanged (equals the inner schema).
  expectTypeOf<BaseOf<LocalSubjectSchema<typeof eventSchema>>>().toEqualTypeOf<typeof eventSchema>();
  expectTypeOf<BaseOf<HostLocalRequestSubjectSchema<typeof requestSchema>>>().toEqualTypeOf<typeof requestSchema>();

  // BaseOf of a non-journal wrapper never recurses into its inner schema's own
  // `schema` property: data that happens to carry a `__channel` brand and a
  // `schema` property of its own, nested beneath a `localSubject()` wrapper, is
  // still the channel-carrying object itself, not the schema nested inside it.
  const channelCarryingInner = { ...requestSchema, __channel: true as const, schema: eventSchema };
  const localOverChannelCarryingInner = localSubject(channelCarryingInner);
  expectTypeOf<BaseOf<typeof localOverChannelCarryingInner>>().toEqualTypeOf<typeof channelCarryingInner>();
  expectTypeOf(localOverChannelCarryingInner).toEqualTypeOf<LocalSubjectSchema<typeof channelCarryingInner>>();

  // journalSubject(): request options are accepted for a bare request core and for a
  // request wrapped by an existing routing wrapper; event options are rejected for
  // either, because a request is always volatile.
  journalSubject(requestSchema, { suggestedFor: { send: ['makaio.host'] } });
  journalSubject(localSubject(requestSchema), { suggestedFor: { subscribe: ['makaio.host'] } });
  // @ts-expect-error event options are rejected for a bare request core
  journalSubject(requestSchema, recordedBase);
  // @ts-expect-error event options are rejected for a request wrapped by an existing wrapper
  journalSubject(localSubject(requestSchema), recordedBase);

  // journalSubject(): recorded event options are accepted for a bare event core and for
  // an event wrapped by an existing routing wrapper.
  journalSubject(eventSchema, recordedBase);
  journalSubject(localSubject(eventSchema), recordedBase);

  // journalSubject(): nesting a journal wrapper, directly or via a prior journalSubject()
  // call, is rejected — the journal layer is always the outer layer.
  const journalOverEventViaFactory = journalSubject(eventSchema, {});
  // @ts-expect-error journalSubject() over an existing journal wrapper does not satisfy RoutedSubjectSchema
  journalSubject(journalOverEventViaFactory, {});

  // journalSubject(): two existing routing wrappers stacked inside each other is rejected,
  // the canonical order allows at most one routing layer beneath the journal layer.
  // @ts-expect-error a local wrapper over a channel wrapper is not a RoutedSubjectSchema
  journalSubject(localOverChannel, {});

  // journalSubject(): a schema typed as a bare union of an event and a request (or that
  // union wrapped by an existing routing wrapper) gets the non-distributive, request-only
  // options: recording options are rejected even though the union also admits an event.
  const eventOrRequest = eventSchema as typeof eventSchema | typeof requestSchema;
  journalSubject(eventOrRequest, { suggestedFor: { send: ['makaio.host'] } });
  // @ts-expect-error recording options are rejected for a bare event|request union: the request member rules it out
  journalSubject(eventOrRequest, recordedBase);
  // A routing wrapper over an event|request union is not a routed subject of one kind,
  // so the factory rejects it at the schema argument, whatever the options.
  const localEventOrRequest = localSubject(eventOrRequest);
  expectTypeOf(localEventOrRequest).toEqualTypeOf<LocalSubjectSchema<typeof eventSchema | typeof requestSchema>>();
  // @ts-expect-error a localSubject of an event|request union is not a RoutedSubjectSchema
  journalSubject(localEventOrRequest, { suggestedFor: { send: ['makaio.host'] } });
  expectTypeOf(localEventOrRequest).not.toMatchTypeOf<RoutedSubjectSchema>();
  expectTypeOf(localSubject(eventSchema)).toMatchTypeOf<RoutedSubjectSchema>();

  // journalSubject() results are assignable to SubjectSchema and usable directly in
  // createBusNamespace(), without a cast.
  expectTypeOf(journalOverEventViaFactory).toMatchTypeOf<SubjectSchema>();
  createBusNamespace('journalSubjectTypesTest', {
    event: journalOverEventViaFactory,
    call: journalSubject(requestSchema, { suggestedFor: { send: ['makaio.host'] } }),
  });
}

describe('journal subject contracts', () => {
  it('compiles the assertions', () => {
    expect(typeof typeAssertions).toBe('function');
  });
});
