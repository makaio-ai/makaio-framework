/**
 * Tests for journal-aware routing metadata in the bus-core registries.
 *
 * Each journal-wrapped schema below is built through `journalSubject()`, the
 * public factory from `@makaio/core`. This exercises exactly the shape
 * `routingMetadataFromMarks` and `journalDeclarationsEqual` understand via
 * `inspectSubjectSchema`, and is enough to drive the journal wrapper contract
 * end to end.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type {
  EventSchema,
  JournalOptions,
  JournalSubjectSchema,
  LocalSubjectSchema,
  OlderVersionStrategy,
  SubjectSchema,
} from '@makaio/core';
import { createBusNamespace, defaultTransports, inspectSubjectSchema, journalSubject } from '@makaio/core';
import { createBusInstance, channelSubject, localSubject } from '../index.js';
import { ValidationError } from '../errors/validation-error.js';
import {
  journalDeclarationsEqual,
  routingMetadataFromMarks,
  type SubjectRoutingMetadata,
} from '../registries/routing-metadata.js';

/**
 * Extract routing metadata for a raw subject schema through the public
 * inspection path: a single {@link inspectSubjectSchema} traversal projected
 * to routing metadata by {@link routingMetadataFromMarks}.
 * @param schema - Raw subject schema, possibly wrapped with localSubject, journalSubject, etc.
 * @returns Routing metadata flags for the schema
 */
function routingMetadataFor(schema: SubjectSchema): SubjectRoutingMetadata {
  return routingMetadataFromMarks(inspectSubjectSchema(schema).marks);
}

const sampleEventSchema: EventSchema = z.object({ id: z.string() });

/**
 * Build a journal wrapper over an already-wrapped local event schema, with
 * the given journal options.
 * @param options - Journal options to attach to the wrapper
 * @returns A journal wrapper over `localSubject(sampleEventSchema)`
 */
function journalOverLocal(options: JournalOptions<LocalSubjectSchema<EventSchema>>) {
  return journalSubject(localSubject(sampleEventSchema), options);
}

/**
 * Build a journal wrapper over a bare event schema, with the given journal
 * options.
 * @param options - Journal options to attach to the wrapper
 * @returns A journal wrapper over a bare event schema
 */
function journalOverBare(options: JournalOptions<EventSchema>) {
  return journalSubject(sampleEventSchema, options);
}

// ---------------------------------------------------------------------------
// Case 1: routing metadata extraction over journal-wrapped and plain schemas
// ---------------------------------------------------------------------------

describe('routing metadata extraction: journal wrapper', () => {
  it('reports local: true and carries journal options for a journal over localSubject(...)', () => {
    const options: JournalOptions<LocalSubjectSchema<EventSchema>> = { suggestedFor: { send: ['makaio.agent'] } };
    const metadata = routingMetadataFor(journalOverLocal(options));

    expect(metadata.local).toBe(true);
    expect(metadata.collectorOnly).toBe(false);
    expect(metadata.channel).toBe(false);
    expect(metadata.hostLocalRequest).toBe(false);
    expect(metadata.journal).toEqual(options);
  });

  it('reports all routing flags false and carries journal options for a journal over a bare schema', () => {
    const options: JournalOptions<EventSchema> = { suggestedFor: { subscribe: ['makaio.collector'] } };
    const metadata = routingMetadataFor(journalOverBare(options));

    expect(metadata.local).toBe(false);
    expect(metadata.collectorOnly).toBe(false);
    expect(metadata.channel).toBe(false);
    expect(metadata.hostLocalRequest).toBe(false);
    expect(metadata.defaultTransports).toBeUndefined();
    expect(metadata.journal).toEqual(options);
  });

  it('reports no journal for a plain localSubject(...) with no journal wrapper', () => {
    const metadata = routingMetadataFor(localSubject(sampleEventSchema));

    expect(metadata.local).toBe(true);
    expect(metadata.journal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Case 2: journalDeclarationsEqual
// ---------------------------------------------------------------------------

describe('journalDeclarationsEqual', () => {
  const recorded = (
    overrides: Partial<Extract<JournalOptions<EventSchema>, { retention: 'recorded' }>> = {},
  ): JournalOptions<EventSchema> => ({
    retention: 'recorded',
    schemaVersion: '1',
    readOlder: { kind: 'as-recorded' },
    ...overrides,
  });

  it('is true when both declarations are absent', () => {
    expect(journalDeclarationsEqual(undefined, undefined)).toBe(true);
  });

  it('is false when exactly one declaration is absent', () => {
    expect(journalDeclarationsEqual(recorded(), undefined)).toBe(false);
    expect(journalDeclarationsEqual(undefined, recorded())).toBe(false);
  });

  it('is true for equal recorded declarations', () => {
    expect(journalDeclarationsEqual(recorded(), recorded())).toBe(true);
  });

  it('is false when schemaVersion differs', () => {
    expect(journalDeclarationsEqual(recorded({ schemaVersion: '1' }), recorded({ schemaVersion: '2' }))).toBe(false);
  });

  it('is true when retention is absent on one side and explicit volatile on the other, because volatile is the documented default', () => {
    const absentRetention: JournalOptions<EventSchema> = {};
    const explicitVolatile: JournalOptions<EventSchema> = { retention: 'volatile' };
    expect(journalDeclarationsEqual(absentRetention, explicitVolatile)).toBe(true);
  });

  it("is true when retainPayload is 'keep' on both sides", () => {
    expect(journalDeclarationsEqual(recorded({ retainPayload: 'keep' }), recorded({ retainPayload: 'keep' }))).toBe(
      true,
    );
  });

  it("is false when retainPayload differs: 'keep' vs { maxAgeMs }", () => {
    expect(
      journalDeclarationsEqual(recorded({ retainPayload: 'keep' }), recorded({ retainPayload: { maxAgeMs: 1000 } })),
    ).toBe(false);
  });

  it('is true for two independently allocated retainPayload objects with the same maxAgeMs', () => {
    expect(
      journalDeclarationsEqual(
        recorded({ retainPayload: { maxAgeMs: 1000 } }),
        recorded({ retainPayload: { maxAgeMs: 1000 } }),
      ),
    ).toBe(true);
  });

  it('is false when retainPayload differs: { maxAgeMs: 1000 } vs { maxAgeMs: 2000 }', () => {
    expect(
      journalDeclarationsEqual(
        recorded({ retainPayload: { maxAgeMs: 1000 } }),
        recorded({ retainPayload: { maxAgeMs: 2000 } }),
      ),
    ).toBe(false);
  });

  it('is false when suggestedFor.send order differs', () => {
    expect(
      journalDeclarationsEqual(
        recorded({ suggestedFor: { send: ['makaio.agent', 'makaio.collector'] } }),
        recorded({ suggestedFor: { send: ['makaio.collector', 'makaio.agent'] } }),
      ),
    ).toBe(false);
  });

  it('is false when suggestedFor.send content differs', () => {
    expect(
      journalDeclarationsEqual(
        recorded({ suggestedFor: { send: ['makaio.agent'] } }),
        recorded({ suggestedFor: { send: ['makaio.collector'] } }),
      ),
    ).toBe(false);
  });

  it('is false when suggestedFor.subscribe content differs', () => {
    expect(
      journalDeclarationsEqual(
        recorded({ suggestedFor: { subscribe: ['makaio.agent'] } }),
        recorded({ suggestedFor: { subscribe: ['makaio.collector'] } }),
      ),
    ).toBe(false);
  });

  it(
    'is false for suggestedFor.send: an empty list and an absent list are intentionally not equivalent ' +
      '(no contract establishes that an empty suggestion list means "same as no declaration")',
    () => {
      expect(journalDeclarationsEqual(recorded({ suggestedFor: { send: [] } }), recorded())).toBe(false);
    },
  );

  it('is false when readOlder.kind differs', () => {
    const upgrade: OlderVersionStrategy = { kind: 'upgrade', upgrade: (payload) => payload };
    expect(
      journalDeclarationsEqual(recorded({ readOlder: { kind: 'as-recorded' } }), recorded({ readOlder: upgrade })),
    ).toBe(false);
  });

  it('compares readOlder by kind only, so two different upgrade functions with the same kind compare equal', () => {
    const upgradeA: OlderVersionStrategy = { kind: 'upgrade', upgrade: (payload) => payload };
    const upgradeB: OlderVersionStrategy = {
      kind: 'upgrade',
      upgrade: (payload, fromVersion) => ({ ...(payload as Record<string, unknown>), fromVersion }),
    };

    expect(journalDeclarationsEqual(recorded({ readOlder: upgradeA }), recorded({ readOlder: upgradeB }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 3: journal declarations through real registerNamespace() calls
// ---------------------------------------------------------------------------

describe('registerNamespace(): journal declaration collision through the live registry', () => {
  it('throws when the same namespace is registered twice with differing journal declarations', () => {
    const bus = createBusInstance();
    const domain = 'journalRegistryDeclarationMismatchTest';
    bus.registerNamespace(
      createBusNamespace(domain, {
        event: journalOverBare({ retention: 'recorded', schemaVersion: '1', readOlder: { kind: 'as-recorded' } }),
      }),
    );

    expect(() =>
      bus.registerNamespace(
        createBusNamespace(domain, {
          event: journalOverBare({ retention: 'recorded', schemaVersion: '2', readOlder: { kind: 'as-recorded' } }),
        }),
      ),
    ).toThrow(/routing metadata/i);
  });

  it('does not throw when the same namespace is registered twice with equivalent journal declarations (absent retention vs explicit volatile)', () => {
    const bus = createBusInstance();
    const domain = 'journalRegistryDeclarationEquivalentTest';
    bus.registerNamespace(createBusNamespace(domain, { event: journalOverBare({}) }));

    expect(() =>
      bus.registerNamespace(createBusNamespace(domain, { event: journalOverBare({ retention: 'volatile' }) })),
    ).not.toThrow();
  });

  it('reports a journal-over-local subject as local through the registry public local check', () => {
    const bus = createBusInstance();
    const domain = 'journalRegistryOverLocalTest';
    bus.registerNamespace(createBusNamespace(domain, { event: journalOverLocal({}) }));

    expect(bus.getContext().namespaceRegistry.isLocalSubject(`${domain}.event`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 4: registerNamespace() — real registry integration
//
// `SubjectSchema` — the type `createBusNamespace()` and `registerNamespace()`
// accept — includes `JournalSubjectSchema`, so a journal-wrapped subject
// reaches `registerNamespace()` through the public `journalSubject()` factory
// without a cast. The cases below prove, through real `registerNamespace()`
// calls, that non-journal registration behaviour is unaffected by the
// `journal` record field, including the live duplicate-registration
// collision path, and that a namespace registration spanning journal-wrapped
// and plain subjects reads every routing mark through the journal layer and
// still validates request payloads. Journal-specific routing and collision
// behaviour is covered above directly through the public inspection path
// (`routingMetadataFor`) and `registerNamespace()` itself, which calls the
// same internal routing-metadata functions.
// ---------------------------------------------------------------------------

describe('registerNamespace(): real registry integration for the journal record field', () => {
  it('records an absent journal declaration, retrievable through getRegisteredSubject() and listRegisteredSubjects(), for a local event subject', () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('journalRegistryTest', {
      event: localSubject(z.object({ id: z.string() })),
    });
    bus.registerNamespace(namespace);

    const registered = bus.getContext().namespaceRegistry.getRegisteredSubject('journalRegistryTest.event');
    expect(registered?.journal).toBeUndefined();
    expect(registered?.local).toBe(true);

    const listed = bus
      .getContext()
      .namespaceRegistry.listRegisteredSubjects()
      .find((subject) => subject.fullSubject === 'journalRegistryTest.event');
    expect(listed?.journal).toBeUndefined();
  });

  it('returns a copy from getRegisteredSubject(), so replacing a field of it does not change the registry', () => {
    const bus = createBusInstance();
    const declaration = { retention: 'recorded', schemaVersion: '1', readOlder: { kind: 'as-recorded' } } as const;
    bus.registerNamespace(
      createBusNamespace('journalRegistryCopyTest', {
        event: journalSubject(z.object({ id: z.string() }), declaration),
      }),
    );
    const registry = bus.getContext().namespaceRegistry;

    const first = registry.getRegisteredSubject('journalRegistryCopyTest.event');
    expect(first?.journal).toEqual(declaration);
    if (first !== undefined) first.journal = { retention: 'volatile' };

    expect(registry.getRegisteredSubject('journalRegistryCopyTest.event')?.journal).toEqual(declaration);
  });

  it('keeps the declaration of a hand-built journal wrapper as registered when the caller mutates it afterwards', () => {
    const bus = createBusInstance();
    const send: 'makaio.host'[] = ['makaio.host'];
    const options = {
      retention: 'recorded' as const,
      schemaVersion: '1',
      readOlder: { kind: 'as-recorded' as const },
      suggestedFor: { send },
    };
    const eventSchema = z.object({ id: z.string() });
    const wrapped: JournalSubjectSchema<typeof eventSchema> = { __journal: true, schema: eventSchema, options };
    bus.registerNamespace(createBusNamespace('journalRegistryLiteralTest', { event: wrapped }));

    send.push('makaio.host');
    options.schemaVersion = '2';

    const registered = bus.getContext().namespaceRegistry.getRegisteredSubject('journalRegistryLiteralTest.event');
    expect(registered?.journal).toEqual({
      retention: 'recorded',
      schemaVersion: '1',
      readOlder: { kind: 'as-recorded' },
      suggestedFor: { send: ['makaio.host'] },
    });
  });

  it('classifies a registered request subject as a request and stores its inner request/response schemas', () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('journalRegistryRequestTest', {
      call: { request: z.object({ q: z.string() }), response: z.object({ output: z.string() }) },
    });
    bus.registerNamespace(namespace);

    const fullKey = 'journalRegistryRequestTest.call';
    expect(bus.getContext().namespaceRegistry.isRequestSubject(fullKey)).toBe(true);
    const registered = bus.getContext().namespaceRegistry.getRegisteredSubject(fullKey);
    expect(registered?.journal).toBeUndefined();
    expect(registered !== undefined && 'request' in registered.schema && 'response' in registered.schema).toBe(true);
  });

  it('rejects a real duplicate registerNamespace() call whose routing metadata differs', () => {
    const bus = createBusInstance();
    const domain = 'journalRegistryDuplicateLiveTest';
    bus.registerNamespace(createBusNamespace(domain, { event: localSubject(z.object({ id: z.string() })) }));

    expect(() => bus.registerNamespace(createBusNamespace(domain, { event: z.object({ id: z.string() }) }))).toThrow(
      /routing metadata/i,
    );
  });

  it('accepts a real duplicate registerNamespace() call whose routing metadata is identical (idempotent registration)', () => {
    const bus = createBusInstance();
    const domain = 'journalRegistryDuplicateEqualLiveTest';
    const schemas = { event: localSubject(z.object({ id: z.string() })) };
    bus.registerNamespace(createBusNamespace(domain, schemas));

    expect(() => bus.registerNamespace(createBusNamespace(domain, schemas))).not.toThrow();
  });

  it('registers a namespace containing a journal-wrapped event and a journal-wrapped request without a cast, reading local/channel/defaultTransports through the journal layer and still validating the request', async () => {
    const bus = createBusInstance();
    const domain = 'journalRegistryJournalWrappedTest';
    const eventJournalOptions: JournalOptions<EventSchema> = {
      retention: 'recorded',
      schemaVersion: '1',
      readOlder: { kind: 'as-recorded' },
    };
    const requestJournalOptions: JournalOptions<{ request: z.ZodType; response: z.ZodType }> = {
      suggestedFor: { send: ['makaio.agent'] },
    };

    const namespace = createBusNamespace(domain, {
      localEvent: journalSubject(localSubject(z.object({ id: z.string() })), eventJournalOptions),
      channelEvent: journalSubject(channelSubject(z.object({ id: z.string() })), eventJournalOptions),
      routedEvent: journalSubject(defaultTransports(z.object({ id: z.string() }), 'local-only'), eventJournalOptions),
      call: journalSubject(
        { request: z.object({ input: z.string() }), response: z.object({ output: z.string() }) },
        requestJournalOptions,
      ),
    });
    const { subjects } = bus.registerNamespace(namespace);

    const registeredLocalEvent = bus.getContext().namespaceRegistry.getRegisteredSubject(`${domain}.localEvent`);
    expect(registeredLocalEvent?.local).toBe(true);
    expect(registeredLocalEvent?.journal).toEqual(eventJournalOptions);

    const registeredChannelEvent = bus.getContext().namespaceRegistry.getRegisteredSubject(`${domain}.channelEvent`);
    expect(registeredChannelEvent?.channel).toBe(true);
    expect(registeredChannelEvent?.journal).toEqual(eventJournalOptions);

    expect(subjects.routedEvent.$meta.defaultTransports).toBe('local-only');

    const registeredCall = bus.getContext().namespaceRegistry.getRegisteredSubject(`${domain}.call`);
    expect(registeredCall?.journal).toEqual(requestJournalOptions);
    expect(
      registeredCall !== undefined && 'request' in registeredCall.schema && 'response' in registeredCall.schema,
    ).toBe(true);

    await expect(bus.request(subjects.call, { input: 123 } as never)).rejects.toThrow(ValidationError);
  });
});
