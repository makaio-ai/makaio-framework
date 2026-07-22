import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { hostLocalRequest, isHostLocalRequestSchema } from '../subject-helpers/host-local-request-schema.js';
import { unwrapSchema } from '../subject-helpers/unwrap-schema.js';
import { nestSubjectDefinitions } from '../subject-helpers/nest-subject-definitions.js';
import { localSubject } from '../subject-helpers/is-local-schema.js';
import { collectorOnlySubject } from '../subject-helpers/is-collector-only-schema.js';
import { channelSubject } from '../subject-helpers/is-channel-schema.js';
import type { HostLocalRequestSubjectSchema, SubjectSchema } from '../types/schema.js';
import type { InferSchemaPayload, InferSubjectMeta } from '../types/type-helpers.js';

const requestSchema = {
  request: z.object({ capabilityId: z.string() }),
  response: z.object({ available: z.boolean() }),
};

const eventSchema = z.object({ name: z.string() });

describe('hostLocalRequest() schema wrapper', () => {
  describe('factory function', () => {
    it('wraps a RequestSchema with the __hostLocalRequest flag', () => {
      const wrapped = hostLocalRequest(requestSchema);

      expect(wrapped.__hostLocalRequest).toBe(true);
      expect(wrapped.schema).toBe(requestSchema);
    });

    it('accepts RequestSchema at the type level', () => {
      const wrapped = hostLocalRequest(requestSchema);
      expectTypeOf(wrapped).toEqualTypeOf<HostLocalRequestSubjectSchema<typeof requestSchema>>();
    });

    it('rejects EventSchema at the type level', () => {
      // @ts-expect-error EventSchema is not assignable to RequestSchema
      hostLocalRequest(eventSchema);
    });

    it('rejects bare ZodType at the type level', () => {
      // @ts-expect-error ZodType is not assignable to RequestSchema
      hostLocalRequest(z.string());
    });
  });

  describe('type guard', () => {
    it('returns true for hostLocalRequest-wrapped schemas', () => {
      const wrapped = hostLocalRequest(requestSchema);
      expect(isHostLocalRequestSchema(wrapped)).toBe(true);
    });

    it('returns false for plain request schemas', () => {
      expect(isHostLocalRequestSchema(requestSchema as SubjectSchema)).toBe(false);
    });

    it('returns false for plain event schemas', () => {
      expect(isHostLocalRequestSchema(eventSchema)).toBe(false);
    });

    it('returns false for localSubject-wrapped schemas', () => {
      const local = localSubject(requestSchema);
      expect(isHostLocalRequestSchema(local)).toBe(false);
    });

    it('returns false for channelSubject-wrapped schemas', () => {
      const channel = channelSubject(requestSchema);
      expect(isHostLocalRequestSchema(channel)).toBe(false);
    });

    it('returns false for collectorOnlySubject-wrapped schemas', () => {
      const collector = collectorOnlySubject(eventSchema);
      expect(isHostLocalRequestSchema(collector)).toBe(false);
    });

    it('narrows the type via is-guard', () => {
      const schema: SubjectSchema = hostLocalRequest(requestSchema);
      if (isHostLocalRequestSchema(schema)) {
        expectTypeOf(schema).toEqualTypeOf<HostLocalRequestSubjectSchema>();
      }
    });
  });

  describe('unwrapSchema', () => {
    it('unwraps hostLocalRequest to the inner RequestSchema', () => {
      const wrapped = hostLocalRequest(requestSchema);
      const inner = unwrapSchema(wrapped);
      expect(inner).toBe(requestSchema);
    });
  });

  describe('UnwrapSchema type-level inference', () => {
    it('preserves request and response types through InferSchemaPayload', () => {
      type Wrapped = HostLocalRequestSubjectSchema<typeof requestSchema>;
      type Payload = InferSchemaPayload<Wrapped>;

      expectTypeOf<Payload>().toEqualTypeOf<{
        request: { capabilityId: string };
        response: { available: boolean };
      }>();
    });
  });

  describe('InferSubjectMeta', () => {
    it('sets hostLocalRequest to true for wrapped schemas', () => {
      type Wrapped = HostLocalRequestSubjectSchema<typeof requestSchema>;
      type Meta = InferSubjectMeta<Wrapped, 'test'>;

      expectTypeOf<Meta['hostLocalRequest']>().toEqualTypeOf<true>();
      expectTypeOf<Meta['isRequest']>().toEqualTypeOf<true>();
      expectTypeOf<Meta['local']>().toEqualTypeOf<false>();
      expectTypeOf<Meta['channel']>().toEqualTypeOf<false>();
      expectTypeOf<Meta['namespace']>().toEqualTypeOf<'test'>();
    });

    it('sets hostLocalRequest to false for plain request schemas', () => {
      type PlainReq = typeof requestSchema;
      type Meta = InferSubjectMeta<PlainReq, 'test'>;

      expectTypeOf<Meta['hostLocalRequest']>().toEqualTypeOf<false>();
    });

    it('sets hostLocalRequest to false for localSubject-wrapped schemas', () => {
      type Local = ReturnType<typeof localSubject<typeof requestSchema>>;
      type Meta = InferSubjectMeta<Local, 'test'>;

      expectTypeOf<Meta['hostLocalRequest']>().toEqualTypeOf<false>();
      expectTypeOf<Meta['local']>().toEqualTypeOf<true>();
    });

    it('sets hostLocalRequest to false for plain event schemas', () => {
      type Meta = InferSubjectMeta<typeof eventSchema, 'test'>;

      expectTypeOf<Meta['hostLocalRequest']>().toEqualTypeOf<false>();
      expectTypeOf<Meta['isRequest']>().toEqualTypeOf<false>();
    });
  });

  describe('nestSubjectDefinitions runtime $meta', () => {
    it('sets $meta.hostLocalRequest = true for hostLocalRequest subjects', () => {
      const subjects = nestSubjectDefinitions('test', {
        resolve: hostLocalRequest(requestSchema),
      });

      expect(subjects.resolve.$meta.hostLocalRequest).toBe(true);
      expect(subjects.resolve.$meta.isRequest).toBe(true);
      expect(subjects.resolve.$meta.local).toBe(false);
      expect(subjects.resolve.$meta.channel).toBe(false);
    });

    it('does not set hostLocalRequest for plain request subjects', () => {
      const subjects = nestSubjectDefinitions('test', {
        resolve: requestSchema,
      });

      expect(subjects.resolve.$meta.hostLocalRequest).toBeUndefined();
    });

    it('does not set hostLocalRequest for localSubject-wrapped schemas', () => {
      const subjects = nestSubjectDefinitions('test', {
        resolve: localSubject(requestSchema),
      });

      expect(subjects.resolve.$meta.hostLocalRequest).toBeUndefined();
      expect(subjects.resolve.$meta.local).toBe(true);
    });

    it('does not set hostLocalRequest for event schemas', () => {
      const subjects = nestSubjectDefinitions('test', {
        notify: eventSchema,
      });

      expect(subjects.notify.$meta.hostLocalRequest).toBeUndefined();
    });

    it('preserves existing wrappers alongside hostLocalRequest', () => {
      const subjects = nestSubjectDefinitions('test', {
        hostLocal: hostLocalRequest(requestSchema),
        local: localSubject(requestSchema),
        channel: channelSubject(requestSchema),
        plain: requestSchema,
        event: eventSchema,
      });

      expect(subjects.hostLocal.$meta.hostLocalRequest).toBe(true);
      expect(subjects.local.$meta.local).toBe(true);
      expect(subjects.channel.$meta.channel).toBe(true);
      expect(subjects.plain.$meta.hostLocalRequest).toBeUndefined();
      expect(subjects.event.$meta.hostLocalRequest).toBeUndefined();
    });
  });
});
