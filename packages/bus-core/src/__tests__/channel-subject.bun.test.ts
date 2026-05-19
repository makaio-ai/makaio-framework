import { describe, it, expect, beforeEach } from 'bun:test';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { MakaioBus, channelSubject, ChannelOnlyError } from '../index.js';

const ChannelTestNamespace = MakaioBus.registerNamespace(
  createBusNamespace('channelTest', {
    secret: channelSubject({
      request: z.object({ key: z.string() }),
      response: z.object({ value: z.string() }),
    }),
    notify: channelSubject(z.object({ message: z.string() })),
    normal: z.object({ data: z.string() }),
    normalRequest: {
      request: z.object({ id: z.string() }),
      response: z.object({ found: z.boolean() }),
    },
  }),
);

const TestSubjects = ChannelTestNamespace.subjects;

describe('channelSubject() compile-time and runtime guards', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('$meta flags', () => {
    it('channel subject has $meta.channel = true', () => {
      expect(TestSubjects.secret.$meta.channel).toBe(true);
      expect(TestSubjects.notify.$meta.channel).toBe(true);
    });

    it('normal subject has $meta.channel = false', () => {
      expect(TestSubjects.normal.$meta.channel).toBe(false);
      expect(TestSubjects.normalRequest.$meta.channel).toBe(false);
    });

    it('channel request subject is also marked isRequest', () => {
      expect(TestSubjects.secret.$meta.isRequest).toBe(true);
      expect(TestSubjects.notify.$meta.isRequest).toBe(false);
    });

    it('channel event subject is not marked isRequest', () => {
      expect(TestSubjects.notify.$meta.isRequest).toBe(false);
    });
  });

  describe('runtime guards', () => {
    it('request() throws ChannelOnlyError for channel subjects', async () => {
      // @ts-expect-error - channel subjects rejected at compile time
      await expect(MakaioBus.request(TestSubjects.secret, { key: 'test' })).rejects.toThrow(ChannelOnlyError);
    });

    it('request() error message contains "channel-only"', async () => {
      // @ts-expect-error - channel subjects rejected at compile time
      await expect(MakaioBus.request(TestSubjects.secret, { key: 'test' })).rejects.toThrow('channel-only');
    });

    it('emit() throws ChannelOnlyError for channel subjects', async () => {
      // @ts-expect-error - channel subjects rejected at compile time
      await expect(MakaioBus.emit(TestSubjects.notify, { message: 'test' })).rejects.toThrow(ChannelOnlyError);
    });

    it('emit() error message contains "channel-only"', async () => {
      // @ts-expect-error - channel subjects rejected at compile time
      await expect(MakaioBus.emit(TestSubjects.notify, { message: 'test' })).rejects.toThrow('channel-only');
    });

    it('on() throws ChannelOnlyError for channel subjects', () => {
      // @ts-expect-error - channel subjects rejected at compile time
      expect(() => MakaioBus.on(TestSubjects.secret, () => {})).toThrow(ChannelOnlyError);
    });

    it('once() throws ChannelOnlyError for channel subjects', () => {
      // @ts-expect-error - channel subjects rejected at compile time
      expect(() => MakaioBus.once(TestSubjects.secret, () => {})).toThrow('channel-only');
    });

    it('requestOptional() throws ChannelOnlyError for channel subjects', async () => {
      // @ts-expect-error - channel subjects rejected at compile time
      await expect(MakaioBus.requestOptional(TestSubjects.secret, { key: 'test' })).rejects.toThrow(ChannelOnlyError);
    });
  });

  describe('compile-time guards', () => {
    it('compile-time: channel request rejected by bus.request()', async () => {
      // @ts-expect-error - channel subjects resolve to never in request()
      await expect(MakaioBus.request(TestSubjects.secret, { key: 'test' })).rejects.toThrow(ChannelOnlyError);
    });

    it('compile-time: channel event rejected by bus.emit()', async () => {
      // @ts-expect-error - channel subjects resolve to never in emit()
      await expect(MakaioBus.emit(TestSubjects.notify, { message: 'test' })).rejects.toThrow(ChannelOnlyError);
    });

    it('compile-time: channel rejected by bus.on()', () => {
      // @ts-expect-error - channel subjects resolve to never in on()
      expect(() => MakaioBus.on(TestSubjects.secret, () => {})).toThrow(ChannelOnlyError);
    });

    it('compile-time: channel rejected by bus.once() callback', () => {
      // @ts-expect-error - channel subjects resolve to never in once()
      expect(() => MakaioBus.once(TestSubjects.secret, () => {})).toThrow(ChannelOnlyError);
    });

    it('compile-time: channel rejected by bus.once() promise', () => {
      // @ts-expect-error - channel subjects resolve to never in once() promise overload
      expect(() => MakaioBus.once(TestSubjects.notify)).toThrow(ChannelOnlyError);
    });
  });

  describe('normal subjects still work', () => {
    it('normal subjects work on bus.emit()', async () => {
      const unsub = MakaioBus.on(TestSubjects.normal, () => {});
      await MakaioBus.emit(TestSubjects.normal, { data: 'hello' });
      unsub();
    });

    it('normal subjects work on bus.request()', async () => {
      const unsub = MakaioBus.on(TestSubjects.normalRequest, (ctx) => {
        ctx.setResult({ found: true });
      });
      const result = await MakaioBus.request(TestSubjects.normalRequest, { id: '1' });
      expect(result.found).toBe(true);
      unsub();
    });
  });
});
