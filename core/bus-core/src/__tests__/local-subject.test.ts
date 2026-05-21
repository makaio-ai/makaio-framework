import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { MakaioBus, localSubject, type BusTransport } from '../index.js';
import type { BusMessage, MakaioBusContext } from '../types/index.js';

describe('localSubject', () => {
  beforeEach(() => {
    MakaioBus.getContext()?.namespaceRegistry.__resetNamespaces?.();
  });

  describe('schema wrapping', () => {
    it('marks event schemas as local', () => {
      const schema = z.object({ id: z.string() });
      const localSchema = localSubject(schema);

      expect(localSchema.__local).toBe(true);
      expect(localSchema.schema).toBe(schema);
    });

    it('marks request schemas as local', () => {
      const schema = {
        request: z.object({ id: z.string() }),
        response: z.object({ success: z.boolean() }),
      };
      const localSchema = localSubject(schema);

      expect(localSchema.__local).toBe(true);
      expect(localSchema.schema).toBe(schema);
    });
  });

  describe('namespace registration', () => {
    it('sets local flag on subject meta for local event', () => {
      const TestNamespace = MakaioBus.registerNamespace(
        createBusNamespace('test-local-event', {
          normalEvent: z.object({ data: z.string() }),
          localEvent: localSubject(z.object({ component: z.unknown() })),
        }),
      );

      expect(TestNamespace.subjects.normalEvent.$meta.local).toBe(false);
      expect(TestNamespace.subjects.normalEvent.$meta.channel).toBe(false);
      expect(TestNamespace.subjects.localEvent.$meta.local).toBe(true);
      expect(TestNamespace.subjects.localEvent.$meta.channel).toBe(false);
    });

    it('sets local flag on subject meta for local request', () => {
      const TestNamespace = MakaioBus.registerNamespace(
        createBusNamespace('test-local-request', {
          normalRequest: {
            request: z.object({ id: z.string() }),
            response: z.object({ data: z.string() }),
          },
          localRequest: localSubject({
            request: z.object({ id: z.string() }),
            response: z.object({ render: z.unknown() }),
          }),
        }),
      );

      expect(TestNamespace.subjects.normalRequest.$meta.local).toBe(false);
      expect(TestNamespace.subjects.normalRequest.$meta.channel).toBe(false);
      expect(TestNamespace.subjects.localRequest.$meta.local).toBe(true);
      expect(TestNamespace.subjects.localRequest.$meta.channel).toBe(false);
    });

    it('correctly identifies isRequest for wrapped schemas', () => {
      const TestNamespace = MakaioBus.registerNamespace(
        createBusNamespace('test-local-isrequest', {
          localEvent: localSubject(z.object({ data: z.string() })),
          localRequest: localSubject({
            request: z.object({ id: z.string() }),
            response: z.object({ data: z.string() }),
          }),
        }),
      );

      expect(TestNamespace.subjects.localEvent.$meta.isRequest).toBe(false);
      expect(TestNamespace.subjects.localRequest.$meta.isRequest).toBe(true);
    });

    it('returns registered subject metadata snapshots', () => {
      MakaioBus.registerNamespace(
        createBusNamespace('test-local-snapshot', {
          event: z.object({ data: z.string() }),
        }),
      );

      const registry = MakaioBus.getContext().namespaceRegistry;
      const subject = registry
        .listRegisteredSubjects()
        .find((registeredSubject) => registeredSubject.fullSubject === 'test-local-snapshot.event');

      if (!subject) {
        throw new Error('Expected registered snapshot subject');
      }

      subject.subject = 'mutated';

      expect(
        registry
          .listRegisteredSubjects()
          .find((registeredSubject) => registeredSubject.fullSubject === 'test-local-snapshot.event'),
      ).toMatchObject({ subject: 'event' });
    });
  });

  describe('transport routing', () => {
    let mockTransport: BusTransport;
    let sentMessages: BusMessage[];
    let context: MakaioBusContext;

    beforeEach(() => {
      sentMessages = [];
      mockTransport = {
        name: 'mock-transport',
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockImplementation((msg: BusMessage) => {
          sentMessages.push(msg);
          return Promise.resolve(true);
        }),
        onReceive: vi.fn().mockReturnValue(() => {}),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
      };

      context = MakaioBus.getContext();
      context.transportRegistry.registerTransport('test' as never, mockTransport as never);
    });

    it('local events are not sent to transports', async () => {
      const TestNamespace = MakaioBus.registerNamespace(
        createBusNamespace('test-local-emit', {
          localEvent: localSubject(z.object({ data: z.string() })),
        }),
      );

      await MakaioBus.emit(TestNamespace.subjects.localEvent, { data: 'test' });

      expect(sentMessages).toHaveLength(0);
    });

    it('normal events are sent to transports', async () => {
      const TestNamespace = MakaioBus.registerNamespace(
        createBusNamespace('test-normal-emit', {
          normalEvent: z.object({ data: z.string() }),
        }),
      );

      await MakaioBus.emit(TestNamespace.subjects.normalEvent, { data: 'test' });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].type).toBe('event');
    });

    it('local requests with local handlers do not go to transports', async () => {
      const TestNamespace = MakaioBus.registerNamespace(
        createBusNamespace('test-local-request-route', {
          localRequest: localSubject({
            request: z.object({ id: z.string() }),
            response: z.object({ found: z.boolean() }),
          }),
        }),
      );

      // Register local handler
      MakaioBus.on(TestNamespace.subjects.localRequest, (ctx) => {
        ctx.setResult({ found: true });
      });

      const result = await MakaioBus.request(TestNamespace.subjects.localRequest, { id: 'test' });

      expect(result).toEqual({ found: true });
      expect(sentMessages).toHaveLength(0);
    });
  });
});
