import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  localSubject,
  isLocalSchema,
  channelSubject,
  isChannelSchema,
  collectorOnlySubject,
  isCollectorOnlySchema,
  hostLocalRequest,
  isHostLocalRequestSchema,
  defaultTransports,
  isDefaultTransportsSchema,
  journalSubject,
  unwrapSchema,
  inspectSubjectSchema,
} from '../index.js';
import type {
  ChannelSubjectSchema,
  CollectorOnlySubjectSchema,
  DefaultTransportsSubjectSchema,
  HostLocalRequestSubjectSchema,
  JournalOrSelf,
  JournalSubjectSchema,
  LocalSubjectSchema,
  SubjectSchema,
} from '../index.js';

/**
 * Present a deliberately malformed object to the guards, which accept any
 * subject schema. The single cast is the point of the fixture: no well-formed
 * subject schema can carry these shapes.
 * @param value - The malformed object.
 * @returns The same object, typed as a subject schema.
 */
function asMalformedSubjectSchema(value: object): SubjectSchema {
  return value as SubjectSchema;
}

const eventSchema = z.object({ name: z.string() });

const requestSchema = {
  request: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
};

describe('journal subject wrapper', () => {
  describe('journalSubject()', () => {
    it('wraps a bare event schema', () => {
      const wrapped = journalSubject(eventSchema, { retention: 'volatile' });

      expect(wrapped.__journal).toBe(true);
      expect(wrapped.schema).toBe(eventSchema);
      expect(wrapped.options).toEqual({ retention: 'volatile' });

      const inspected = inspectSubjectSchema(wrapped);
      expect(inspected.marks.journal).toEqual({ retention: 'volatile' });
      expect(inspected.schema).toBe(eventSchema);
      expect(unwrapSchema(wrapped)).toBe(eventSchema);
    });

    it('wraps a bare request schema', () => {
      const wrapped = journalSubject(requestSchema, { suggestedFor: { send: ['makaio.host'] } });

      expect(wrapped.__journal).toBe(true);
      expect(wrapped.schema).toBe(requestSchema);

      const inspected = inspectSubjectSchema(wrapped);
      expect(inspected.marks.journal).toEqual({ suggestedFor: { send: ['makaio.host'] } });
      expect(inspected.schema).toBe(requestSchema);
      expect(unwrapSchema(wrapped)).toBe(requestSchema);
    });

    it('stores a frozen snapshot of options, immune to later mutation of the caller-owned object and its suggestedFor arrays', () => {
      const send = ['makaio.host'];
      const subscribe = ['makaio.worker'];
      const options = {
        suggestedFor: { send, subscribe },
        retention: 'recorded' as const,
        schemaVersion: '1',
        retainPayload: { maxAgeMs: 1000 },
        readOlder: { kind: 'as-recorded' as const },
      };

      const wrapped = journalSubject(eventSchema, options);
      const inspected = inspectSubjectSchema(wrapped);

      // Mutate the caller's objects after registration.
      send.push('makaio.extension');
      subscribe.push('makaio.extension');
      options.retainPayload.maxAgeMs = 999_999;

      const expected = {
        suggestedFor: { send: ['makaio.host'], subscribe: ['makaio.worker'] },
        retention: 'recorded',
        schemaVersion: '1',
        retainPayload: { maxAgeMs: 1000 },
        readOlder: { kind: 'as-recorded' },
      };

      expect(wrapped.options).toEqual(expected);
      expect(inspected.marks.journal).toEqual(expected);

      expect(Object.isFrozen(wrapped)).toBe(true);
      expect(Object.isFrozen(wrapped.options)).toBe(true);
      expect(Object.isFrozen(wrapped.options.suggestedFor)).toBe(true);
      expect(Object.isFrozen(wrapped.options.suggestedFor?.send)).toBe(true);
      expect(Object.isFrozen(wrapped.options.suggestedFor?.subscribe)).toBe(true);
      expect(Object.isFrozen(wrapped.options.retainPayload)).toBe(true);
      expect(Object.isFrozen(wrapped.options.readOlder)).toBe(true);
    });

    it('reads a hand-built journal layer into a frozen copy, immune to later mutation of its options', () => {
      const send: ('makaio.host' | 'makaio.agent')[] = ['makaio.host'];
      const options = {
        retention: 'recorded' as const,
        schemaVersion: '1',
        readOlder: { kind: 'as-recorded' as const },
        suggestedFor: { send },
      };
      const wrapped: JournalSubjectSchema<typeof eventSchema> = { __journal: true, schema: eventSchema, options };

      const journal = inspectSubjectSchema(wrapped).marks.journal;
      send.push('makaio.agent');
      options.schemaVersion = '2';

      expect(journal).toEqual({
        retention: 'recorded',
        schemaVersion: '1',
        readOlder: { kind: 'as-recorded' },
        suggestedFor: { send: ['makaio.host'] },
      });
      expect(Object.isFrozen(journal)).toBe(true);
      expect(Object.isFrozen(journal?.suggestedFor?.send)).toBe(true);
    });

    it('inspectSubjectSchema() returns its own marks object for a bare schema, so writing to it does not affect a later inspection', () => {
      const first = inspectSubjectSchema(eventSchema).marks;
      Object.assign(first, { local: true, channel: true });

      expect(inspectSubjectSchema(eventSchema).marks).toEqual({
        local: false,
        channel: false,
        collectorOnly: false,
        hostLocalRequest: false,
      });
    });

    it('wraps an existing local wrapper and reports both the journal and the inner mark', () => {
      const inner = localSubject(eventSchema);
      const wrapped = journalSubject(inner, { retention: 'volatile' });

      expect(wrapped.schema).toBe(inner);

      const inspected = inspectSubjectSchema(wrapped);
      expect(inspected.marks.journal).toEqual({ retention: 'volatile' });
      expect(inspected.marks.local).toBe(true);
      expect(inspected.schema).toBe(eventSchema);
      expect(unwrapSchema(wrapped)).toBe(eventSchema);
    });
  });

  describe('inspectSubjectSchema', () => {
    it('collects the local mark and the journal options from a journal-over-local wrapper', () => {
      const options = { retention: 'volatile' as const };
      const journalOverLocal: JournalSubjectSchema<LocalSubjectSchema<typeof eventSchema>> = {
        __journal: true,
        schema: localSubject(eventSchema),
        options,
      };

      const inspected = inspectSubjectSchema(journalOverLocal);

      expect(inspected.marks.local).toBe(true);
      expect(inspected.marks.journal).toEqual(options);
      expect(inspected.marks.journal).not.toBe(options);
      expect(inspected.schema).toBe(eventSchema);
    });

    it('descends below a journal layer by its brand, not by the presence of options', () => {
      const journalOverLocalNoOptions = asMalformedSubjectSchema({
        __journal: true,
        schema: localSubject(eventSchema),
      });

      const inspected = inspectSubjectSchema(journalOverLocalNoOptions);

      expect(inspected.marks.local).toBe(true);
    });

    it('collects the defaultTransports mark from a journal-over-defaultTransports(request) wrapper', () => {
      const journalOverDefaultTransportsRequest: JournalSubjectSchema<
        DefaultTransportsSubjectSchema<typeof requestSchema, 'local-only'>
      > = {
        __journal: true,
        schema: defaultTransports(requestSchema, 'local-only'),
        options: {},
      };

      const inspected = inspectSubjectSchema(journalOverDefaultTransportsRequest);

      expect(inspected.marks.defaultTransports).toBe('local-only');
      expect(inspected.schema).toBe(requestSchema);
    });
  });

  describe('base identity', () => {
    it('returns the very object passed to the inner factory for a bare schema', () => {
      expect(inspectSubjectSchema(eventSchema).schema).toBe(eventSchema);
      expect(unwrapSchema(eventSchema)).toBe(eventSchema);
    });

    it('returns the very object passed to the inner factory for a one-wrapper schema', () => {
      const wrapped = localSubject(eventSchema);

      expect(inspectSubjectSchema(wrapped).schema).toBe(eventSchema);
      expect(unwrapSchema(wrapped)).toBe(eventSchema);
    });

    it('returns the very object passed to the inner factory for a journal-over-wrapper schema', () => {
      const journalOverLocal: JournalSubjectSchema<LocalSubjectSchema<typeof eventSchema>> = {
        __journal: true,
        schema: localSubject(eventSchema),
        options: { retention: 'volatile' },
      };

      expect(inspectSubjectSchema(journalOverLocal).schema).toBe(eventSchema);
      expect(unwrapSchema(journalOverLocal)).toBe(eventSchema);
    });
  });

  describe('several brands on one layer (regression: no mark is masked by an earlier match)', () => {
    it('reports both local and channel when both brands sit on the same layer', () => {
      const localPlusChannel = { ...localSubject(eventSchema), __channel: true as const };

      expect(isLocalSchema(localPlusChannel)).toBe(true);
      expect(isChannelSchema(localPlusChannel)).toBe(true);
    });

    it('reports both local and collectorOnly when both brands sit on the same layer', () => {
      const localPlusCollector = { ...localSubject(eventSchema), __collectorOnly: true as const };

      expect(isLocalSchema(localPlusCollector)).toBe(true);
      expect(isCollectorOnlySchema(localPlusCollector)).toBe(true);
    });

    it('reports both local and hostLocalRequest when both brands sit on the same layer', () => {
      const localPlusHostLocal = { ...localSubject(requestSchema), __hostLocalRequest: true as const };

      expect(isLocalSchema(localPlusHostLocal)).toBe(true);
      expect(isHostLocalRequestSchema(localPlusHostLocal)).toBe(true);
    });

    it('reports every guard false for an object that carries only brands and no schema', () => {
      const brandsOnlyNoSchema = asMalformedSubjectSchema({
        __local: true,
        __channel: true,
        __collectorOnly: true,
        __hostLocalRequest: true,
        __defaultTransports: 'all',
      });

      expect(isLocalSchema(brandsOnlyNoSchema)).toBe(false);
      expect(isChannelSchema(brandsOnlyNoSchema)).toBe(false);
      expect(isCollectorOnlySchema(brandsOnlyNoSchema)).toBe(false);
      expect(isHostLocalRequestSchema(brandsOnlyNoSchema)).toBe(false);
      expect(isDefaultTransportsSchema(brandsOnlyNoSchema)).toBe(false);
    });

    it('rejects an invalid __defaultTransports value', () => {
      const invalidDefaultTransports = asMalformedSubjectSchema({
        schema: eventSchema,
        __defaultTransports: 'nope',
      });

      expect(isDefaultTransportsSchema(invalidDefaultTransports)).toBe(false);
    });
  });

  describe('guards preserve the outer shape', () => {
    const journalOverBareEvent: JournalSubjectSchema<typeof eventSchema> = {
      __journal: true,
      schema: eventSchema,
      options: { retention: 'volatile' },
    };

    it('isLocalSchema is true for the bare wrapper and for a journal wrapper around it, false otherwise', () => {
      const bareWrapper = localSubject(eventSchema);
      const journalOverWrapper: JournalSubjectSchema<LocalSubjectSchema<typeof eventSchema>> = {
        __journal: true,
        schema: bareWrapper,
        options: { retention: 'volatile' },
      };

      expect(isLocalSchema(bareWrapper)).toBe(true);
      expect(isLocalSchema(journalOverWrapper)).toBe(true);
      expect(isLocalSchema(eventSchema)).toBe(false);
      expect(isLocalSchema(journalOverBareEvent)).toBe(false);

      const value: SubjectSchema = journalOverWrapper;
      if (isLocalSchema(value)) {
        expect(value).toBe(journalOverWrapper);
      }
    });

    it('isChannelSchema is true for the bare wrapper and for a journal wrapper around it, false otherwise', () => {
      const bareWrapper = channelSubject(eventSchema);
      const journalOverWrapper: JournalSubjectSchema<ChannelSubjectSchema<typeof eventSchema>> = {
        __journal: true,
        schema: bareWrapper,
        options: { retention: 'volatile' },
      };

      expect(isChannelSchema(bareWrapper)).toBe(true);
      expect(isChannelSchema(journalOverWrapper)).toBe(true);
      expect(isChannelSchema(eventSchema)).toBe(false);
      expect(isChannelSchema(journalOverBareEvent)).toBe(false);

      const value: SubjectSchema = journalOverWrapper;
      if (isChannelSchema(value)) {
        expect(value).toBe(journalOverWrapper);
      }
    });

    it('isCollectorOnlySchema is true for the bare wrapper and for a journal wrapper around it, false otherwise', () => {
      const bareWrapper = collectorOnlySubject(eventSchema);
      const journalOverWrapper: JournalSubjectSchema<CollectorOnlySubjectSchema<typeof eventSchema>> = {
        __journal: true,
        schema: bareWrapper,
        options: { retention: 'volatile' },
      };

      expect(isCollectorOnlySchema(bareWrapper)).toBe(true);
      expect(isCollectorOnlySchema(journalOverWrapper)).toBe(true);
      expect(isCollectorOnlySchema(eventSchema)).toBe(false);
      expect(isCollectorOnlySchema(journalOverBareEvent)).toBe(false);

      const value: SubjectSchema = journalOverWrapper;
      if (isCollectorOnlySchema(value)) {
        expect(value).toBe(journalOverWrapper);
      }
    });

    it('isHostLocalRequestSchema is true for the bare wrapper and for a journal wrapper around it, false otherwise', () => {
      const bareWrapper = hostLocalRequest(requestSchema);
      const journalOverWrapper: JournalSubjectSchema<HostLocalRequestSubjectSchema<typeof requestSchema>> = {
        __journal: true,
        schema: bareWrapper,
        options: {},
      };

      expect(isHostLocalRequestSchema(bareWrapper)).toBe(true);
      expect(isHostLocalRequestSchema(journalOverWrapper)).toBe(true);
      expect(isHostLocalRequestSchema(eventSchema)).toBe(false);
      expect(isHostLocalRequestSchema(journalOverBareEvent)).toBe(false);

      const value: SubjectSchema = journalOverWrapper;
      if (isHostLocalRequestSchema(value)) {
        expect(value).toBe(journalOverWrapper);
      }
    });

    it('isDefaultTransportsSchema is true for the bare wrapper and for a journal wrapper around it, false otherwise', () => {
      const bareWrapper = defaultTransports(eventSchema, 'all');
      const journalOverWrapper: JournalSubjectSchema<DefaultTransportsSubjectSchema<typeof eventSchema, 'all'>> = {
        __journal: true,
        schema: bareWrapper,
        options: { retention: 'volatile' },
      };

      expect(isDefaultTransportsSchema(bareWrapper)).toBe(true);
      expect(isDefaultTransportsSchema(journalOverWrapper)).toBe(true);
      expect(isDefaultTransportsSchema(eventSchema)).toBe(false);
      expect(isDefaultTransportsSchema(journalOverBareEvent)).toBe(false);

      const value: SubjectSchema = journalOverWrapper;
      if (isDefaultTransportsSchema(value)) {
        expect(value).toBe(journalOverWrapper);
      }
    });
  });

  describe('JournalOrSelf type level', () => {
    it('accepts a journal wrapper over defaultTransports(eventSchema, "all")', () => {
      const journalOverDefaultTransports: JournalSubjectSchema<
        DefaultTransportsSubjectSchema<typeof eventSchema, 'all'>
      > = {
        __journal: true,
        schema: defaultTransports(eventSchema, 'all'),
        options: { retention: 'volatile' },
      };

      expectTypeOf(journalOverDefaultTransports).toMatchTypeOf<
        JournalOrSelf<DefaultTransportsSubjectSchema<typeof eventSchema, 'all'>>
      >();
    });

    it('accepts a journal wrapper over localSubject(eventSchema) and over localSubject(requestSchema)', () => {
      const journalOverLocalEvent: JournalSubjectSchema<LocalSubjectSchema<typeof eventSchema>> = {
        __journal: true,
        schema: localSubject(eventSchema),
        options: { retention: 'volatile' },
      };
      const journalOverLocalRequest: JournalSubjectSchema<LocalSubjectSchema<typeof requestSchema>> = {
        __journal: true,
        schema: localSubject(requestSchema),
        options: {},
      };

      expectTypeOf(journalOverLocalEvent).toMatchTypeOf<JournalOrSelf<LocalSubjectSchema>>();
      expectTypeOf(journalOverLocalRequest).toMatchTypeOf<JournalOrSelf<LocalSubjectSchema>>();
    });

    it('keeps both journal alternatives for a mixed-kind defaultTransports specialization', () => {
      const journalOverDefaultTransportsEvent: JournalSubjectSchema<
        DefaultTransportsSubjectSchema<typeof eventSchema, 'all'>
      > = {
        __journal: true,
        schema: defaultTransports(eventSchema, 'all'),
        options: { retention: 'volatile' },
      };
      const journalOverDefaultTransportsRequest: JournalSubjectSchema<
        DefaultTransportsSubjectSchema<typeof requestSchema, 'all'>
      > = {
        __journal: true,
        schema: defaultTransports(requestSchema, 'all'),
        options: {},
      };

      expectTypeOf(journalOverDefaultTransportsEvent).toMatchTypeOf<
        JournalOrSelf<DefaultTransportsSubjectSchema<typeof eventSchema | typeof requestSchema, 'all'>>
      >();
      expectTypeOf(journalOverDefaultTransportsRequest).toMatchTypeOf<
        JournalOrSelf<DefaultTransportsSubjectSchema<typeof eventSchema | typeof requestSchema, 'all'>>
      >();
    });

    it('keeps the concrete inner schema in the journal alternative', () => {
      const otherEventSchema = z.object({ count: z.number() });
      const journalOverOtherLocal: JournalSubjectSchema<LocalSubjectSchema<typeof otherEventSchema>> = {
        __journal: true,
        schema: localSubject(otherEventSchema),
        options: {},
      };

      // @ts-expect-error a journal over a local wrapper of another event schema is not a journal alternative of this one
      const rejected: JournalOrSelf<LocalSubjectSchema<typeof eventSchema>> = journalOverOtherLocal;
      expect(rejected).toBe(journalOverOtherLocal);
    });
  });

  describe('non-journal traversal equivalence (regression: the journal wrapper is the only layer looked through)', () => {
    it('does not treat a routing brand nested two layers down as the layer beneath a non-journal wrapper', () => {
      // `inner` is data that happens to carry a `__channel` brand and a `schema`
      // property on its own, underneath a `localSubject()` wrapper. `outer` is not
      // a journal wrapper, so only its own (single) layer is read: a non-journal
      // wrapper is never peeled further, whatever its inner schema carries.
      const inner = { ...requestSchema, __channel: true as const, schema: eventSchema };
      const outer = localSubject(inner);

      expect(isChannelSchema(outer)).toBe(false);
      expect(isLocalSchema(outer)).toBe(true);
      expect(unwrapSchema(outer)).toBe(inner);

      const inspected = inspectSubjectSchema(outer);
      expect(inspected.marks.channel).toBe(false);
      expect(inspected.marks.local).toBe(true);
      expect(inspected.schema).toBe(inner);
    });

    it('still reads the inner mark for a journal wrapper over a local wrapper', () => {
      const journalOverLocal: JournalSubjectSchema<LocalSubjectSchema<typeof eventSchema>> = {
        __journal: true,
        schema: localSubject(eventSchema),
        options: { retention: 'volatile' },
      };

      expect(isLocalSchema(journalOverLocal)).toBe(true);
      expect(unwrapSchema(journalOverLocal)).toBe(eventSchema);
    });
  });
});
