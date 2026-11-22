import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { ChannelSubjectSchema, JournalSubjectSchema, SubjectSchema } from '@makaio/core';
import { channelSubject } from '../index.js';
import { isChannelSchema, unwrapChannelSchema } from '../utils/channel-schema.js';
import { isLocalSchema, localSubject } from '../utils/local-schema.js';

describe('channel-schema utilities', () => {
  const eventSchema = z.object({ message: z.string() });
  const requestSchema = {
    request: z.object({ id: z.string() }),
    response: z.object({ found: z.boolean() }),
  };

  it('isChannelSchema returns true for channel event schema', () => {
    expect(isChannelSchema(channelSubject(eventSchema))).toBe(true);
  });

  it('isChannelSchema returns true for channel request schema', () => {
    expect(isChannelSchema(channelSubject(requestSchema))).toBe(true);
  });

  it('isChannelSchema returns false for plain event schema', () => {
    expect(isChannelSchema(eventSchema)).toBe(false);
  });

  it('isChannelSchema returns false for plain request schema', () => {
    expect(isChannelSchema(requestSchema)).toBe(false);
  });

  it('isChannelSchema returns false for local schema', () => {
    expect(isChannelSchema(localSubject(eventSchema))).toBe(false);
  });

  it('unwrapChannelSchema returns inner event schema', () => {
    const wrapped = channelSubject(eventSchema);
    expect(unwrapChannelSchema(wrapped)).toBe(eventSchema);
  });

  it('unwrapChannelSchema returns inner request schema', () => {
    const wrapped = channelSubject(requestSchema);
    expect(unwrapChannelSchema(wrapped)).toBe(requestSchema);
  });

  it('unwrapChannelSchema returns inner event schema from a journal-wrapped channel event', () => {
    const journalOverChannelEvent: JournalSubjectSchema<ChannelSubjectSchema<typeof eventSchema>> = {
      __journal: true,
      schema: channelSubject(eventSchema),
      options: { retention: 'volatile' },
    };

    expect(unwrapChannelSchema(journalOverChannelEvent)).toBe(eventSchema);
  });

  it('unwrapChannelSchema returns inner request schema from a journal-wrapped channel request', () => {
    const journalOverChannelRequest: JournalSubjectSchema<ChannelSubjectSchema<typeof requestSchema>> = {
      __journal: true,
      schema: channelSubject(requestSchema),
      options: {},
    };

    expect(unwrapChannelSchema(journalOverChannelRequest)).toBe(requestSchema);
  });

  it('narrows SubjectSchema to unwrap a channel schema without a cast', () => {
    function unwrapIfChannel(s: SubjectSchema): ReturnType<typeof unwrapChannelSchema> | undefined {
      if (isChannelSchema(s)) {
        return unwrapChannelSchema(s);
      }
      return undefined;
    }

    const journalOverChannelEvent: JournalSubjectSchema<ChannelSubjectSchema<typeof eventSchema>> = {
      __journal: true,
      schema: channelSubject(eventSchema),
      options: { retention: 'volatile' },
    };

    expect(unwrapIfChannel(journalOverChannelEvent)).toBe(eventSchema);
    expect(unwrapIfChannel(channelSubject(eventSchema))).toBe(eventSchema);
    expect(unwrapIfChannel(eventSchema)).toBeUndefined();
    expect(unwrapIfChannel(localSubject(eventSchema))).toBeUndefined();
  });

  it('channel and local are mutually exclusive', () => {
    const channelWrapped = channelSubject(eventSchema);
    const localWrapped = localSubject(eventSchema);

    expect(isChannelSchema(channelWrapped)).toBe(true);
    expect(isLocalSchema(channelWrapped)).toBe(false);

    expect(isLocalSchema(localWrapped)).toBe(true);
    expect(isChannelSchema(localWrapped)).toBe(false);
  });
});
