/**
 * Tests for bidirectional request relay and subscription propagation
 * in the transport registry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import {
  MakaioBus,
  type BusTransport,
  type BusMessage,
  type BusRequestMessage,
  type BusSubscribeMessage,
  type BusUnsubscribeMessage,
  type BusTransportRegistry,
  NoHandlerError,
} from '../index.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../types/options.js';
import { MockTransport, createStubTransport } from './helpers/transport-fixtures.js';

interface RecordedSend {
  message: BusMessage;
  timeout?: number;
}

interface RecordedRelayTransport {
  transport: BusTransport;
  recordedSends: RecordedSend[];
  /** Simulate the relay transport sending a subscribe message to advertise its handlers. */
  advertise(subjects: Record<string, number[]>): Promise<void>;
}

function createRecordedRelayTransport(
  result: (message: BusMessage) => unknown | boolean,
  subscriptions?: Set<string>,
): RecordedRelayTransport {
  const recordedSends: RecordedSend[] = [];
  let capturedHandler: ((message: BusMessage) => Promise<void>) | undefined;
  const transport: BusTransport = {
    name: 'recorded-relay-transport',
    send: (async (message: BusMessage, timeout?: number) => {
      recordedSends.push({ message, timeout });
      return result(message);
    }) as BusTransport['send'],
    onReceive: (handler) => {
      capturedHandler = handler;
      return () => {
        capturedHandler = undefined;
      };
    },
    connect: async () => {},
    disconnect: async () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
    ...(subscriptions ? { getSubscriptions: () => new Set(subscriptions) } : {}),
  };
  return {
    transport,
    recordedSends,
    advertise: async (subjects) => {
      if (capturedHandler) {
        await capturedHandler({
          type: 'subscribe',
          subjects,
          deliveryClasses: Object.fromEntries(Object.keys(subjects).map((subject) => [subject, 'relayable' as const])),
        });
      }
    },
  };
}

const TestSubjects = MakaioBus.registerNamespace(
  createBusNamespace('relayTest', {
    testRequest: {
      request: z.object({ input: z.string() }),
      response: z.object({ output: z.string() }),
    },
  }),
).subjects;

declare module '../index.js' {
  interface BusTransportRegistry {
    source: BusTransport;
  }

  interface BusSubjectsNamespace {
    relayTest: typeof TestSubjects;
  }
}

const { registerTransport } = MakaioBus.getContext().transportRegistry;

describe('Transport relay and subscription propagation', () => {
  let sourceTransport: MockTransport;
  let unregisterSource: () => void;

  beforeEach(() => {
    sourceTransport = new MockTransport();
    unregisterSource = registerTransport('source', sourceTransport).unregister;
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    unregisterSource();
    MakaioBus.__resetHandlers?.();
  });

  describe('Request relay', () => {
    it('should relay request to another transport when no local schema exists', async () => {
      const {
        transport: relayTransport,
        recordedSends,
        advertise,
      } = createRecordedRelayTransport((message) => (message.type === 'request' ? { relayed: true } : true));

      const unregister = registerTransport('relay' as keyof BusTransportRegistry, relayTransport).unregister;

      try {
        // Advertise the relay transport's handler so dispatch knows to route there.
        await advertise({ 'unknown.remoteAction': [0] });

        await sourceTransport.simulateReceive({
          type: 'request',
          namespace: 'unknown',
          subject: 'remoteAction',
          payload: { data: 'test' },
          correlationId: 'corr-relay',
          messageId: 'msg-relay',
          timeout: 0,
        });

        expect(recordedSends).toHaveLength(1);
        expect(recordedSends[0]?.message).toMatchObject({
          type: 'request',
          subject: 'remoteAction',
          namespace: 'unknown',
        });
        expect(recordedSends[0]?.timeout).toBe(0);

        expect(sourceTransport.messages).toHaveLength(1);
        expect(sourceTransport.messages[0]).toMatchObject({
          type: 'response',
          correlationId: 'corr-relay',
          result: { relayed: true },
        });
      } finally {
        unregister();
      }
    });

    it('should relay requests even when relay transport subscriptions do not match', async () => {
      const {
        transport: relayTransport,
        recordedSends,
        advertise,
      } = createRecordedRelayTransport(
        (message) => (message.type === 'request' ? { relayed: true } : true),
        new Set(['widget.register']),
      );

      const unregister = registerTransport('relayFiltered' as keyof BusTransportRegistry, relayTransport).unregister;

      try {
        // Advertise the relay transport's handler so dispatch knows to route there,
        // even though its getSubscriptions() filter doesn't include the subject.
        await advertise({ 'unknown.remoteAction': [0] });

        await sourceTransport.simulateReceive({
          type: 'request',
          namespace: 'unknown',
          subject: 'remoteAction',
          payload: { data: 'test' },
          correlationId: 'corr-relay-filtered',
          messageId: 'msg-relay-filtered',
        });

        expect(recordedSends).toHaveLength(1);
        expect(recordedSends[0]?.message).toMatchObject({
          type: 'request',
          subject: 'remoteAction',
          namespace: 'unknown',
        });
        // Relay dispatch forwards the remaining budget after installing a
        // deadline, so the timeout can be just below the default on fast runs.
        expect(recordedSends[0]?.timeout).toBeGreaterThan(0);
        expect(recordedSends[0]?.timeout).toBeLessThanOrEqual(DEFAULT_REQUEST_TIMEOUT_MS);
        expect(sourceTransport.messages[0]).toMatchObject({
          type: 'response',
          correlationId: 'corr-relay-filtered',
          result: { relayed: true },
        });
      } finally {
        unregister();
      }
    });

    it('should try next transport when first relay target fails', async () => {
      const failingTransport = createStubTransport({
        send: async () => {
          throw new NoHandlerError('unknown.action');
        },
      });

      const successTransport = createStubTransport({
        send: async (message) => (message.type === 'request' ? { fromSecond: true } : true),
      });

      const unregister1 = registerTransport('failing' as keyof BusTransportRegistry, failingTransport).unregister;
      const unregister2 = registerTransport('success' as keyof BusTransportRegistry, successTransport).unregister;

      try {
        // Advertise both transports for the subject — dispatch will try failing first,
        // then fall through to successTransport.
        await failingTransport.simulateReceive({
          type: 'subscribe',
          subjects: { 'unknown.action': [0] },
          deliveryClasses: { 'unknown.action': 'relayable' },
        });
        await successTransport.simulateReceive({
          type: 'subscribe',
          subjects: { 'unknown.action': [0] },
          deliveryClasses: { 'unknown.action': 'relayable' },
        });

        await sourceTransport.simulateReceive({
          type: 'request',
          namespace: 'unknown',
          subject: 'action',
          payload: {},
          correlationId: 'corr-fallback',
          messageId: 'msg-fallback',
        });

        expect(sourceTransport.messages).toHaveLength(1);
        expect(sourceTransport.messages[0]).toMatchObject({
          type: 'response',
          correlationId: 'corr-fallback',
          result: { fromSecond: true },
        });
      } finally {
        unregister1();
        unregister2();
      }
    });

    it('should try next transport when first throws a non-NoHandler error', async () => {
      const failingTransport = createStubTransport({
        send: async () => {
          throw new Error('Transport disconnected');
        },
      });

      const successTransport = createStubTransport({
        send: async (message) => (message.type === 'request' ? { fromSecond: true } : true),
      });

      const unregister1 = registerTransport('failing' as keyof BusTransportRegistry, failingTransport).unregister;
      const unregister2 = registerTransport('success' as keyof BusTransportRegistry, successTransport).unregister;

      try {
        // Advertise both transports — dispatch skips the failing one and falls through.
        await failingTransport.simulateReceive({
          type: 'subscribe',
          subjects: { 'unknown.action': [0] },
          deliveryClasses: { 'unknown.action': 'relayable' },
        });
        await successTransport.simulateReceive({
          type: 'subscribe',
          subjects: { 'unknown.action': [0] },
          deliveryClasses: { 'unknown.action': 'relayable' },
        });

        await sourceTransport.simulateReceive({
          type: 'request',
          namespace: 'unknown',
          subject: 'action',
          payload: {},
          correlationId: 'corr-skip-broken',
          messageId: 'msg-skip-broken',
        });

        expect(sourceTransport.messages).toHaveLength(1);
        expect(sourceTransport.messages[0]).toMatchObject({
          type: 'response',
          correlationId: 'corr-skip-broken',
          result: { fromSecond: true },
        });
      } finally {
        unregister1();
        unregister2();
      }
    });

    it('should return first non-NoHandler error when all transports fail', async () => {
      const failingTransport = createStubTransport({
        send: async () => {
          throw new Error('Downstream failure');
        },
      });

      const alsoFailingTransport = createStubTransport({
        send: async () => {
          throw new NoHandlerError('unknown.action');
        },
      });

      const unregister1 = registerTransport('failing' as keyof BusTransportRegistry, failingTransport).unregister;
      const unregister2 = registerTransport('noHandler' as keyof BusTransportRegistry, alsoFailingTransport).unregister;

      try {
        // Advertise both — dispatch tries both, collects the first non-NoHandler error.
        await failingTransport.simulateReceive({
          type: 'subscribe',
          subjects: { 'unknown.action': [0] },
          deliveryClasses: { 'unknown.action': 'relayable' },
        });
        await alsoFailingTransport.simulateReceive({
          type: 'subscribe',
          subjects: { 'unknown.action': [0] },
          deliveryClasses: { 'unknown.action': 'relayable' },
        });

        await sourceTransport.simulateReceive({
          type: 'request',
          namespace: 'unknown',
          subject: 'action',
          payload: {},
          correlationId: 'corr-all-fail',
          messageId: 'msg-all-fail',
        });

        expect(sourceTransport.messages).toHaveLength(1);
        expect(sourceTransport.messages[0]).toMatchObject({
          type: 'response',
          correlationId: 'corr-all-fail',
          error: { message: 'Downstream failure' },
        });
      } finally {
        unregister1();
        unregister2();
      }
    });

    it('should send error when all relay transports fail', async () => {
      await sourceTransport.simulateReceive({
        type: 'request',
        namespace: 'unknown',
        subject: 'noHandler',
        payload: {},
        correlationId: 'corr-none',
        messageId: 'msg-none',
      });

      expect(sourceTransport.messages).toHaveLength(1);
      expect(sourceTransport.messages[0]).toMatchObject({
        type: 'response',
        correlationId: 'corr-none',
        error: {
          code: 'NO_HANDLER',
          subject: 'unknown.noHandler',
          message: expect.stringContaining('No handler registered'),
        },
      });
    });
  });

  describe('Subscribe propagation via transport messages', () => {
    it('should propagate subscribe messages to transports with subscribe()', async () => {
      const subscribable = createStubTransport({ subscribe: async () => {} });

      const unregister = registerTransport('sub' as keyof BusTransportRegistry, subscribable).unregister;

      try {
        const subscribeMsg: BusSubscribeMessage = {
          type: 'subscribe',
          subjects: { 'test.confirm': [], 'test.prompt': [] },
          deliveryClasses: { 'test.confirm': 'relayable', 'test.prompt': 'relayable' },
        };
        await sourceTransport.simulateReceive(subscribeMsg);

        expect(subscribable.subscribe).toHaveBeenCalledWith('test.confirm', undefined, [], 'relayable');
        expect(subscribable.subscribe).toHaveBeenCalledWith('test.prompt', undefined, [], 'relayable');
      } finally {
        unregister();
      }
    });

    it('waits for advertised subscribe propagation before resolving inbound subscribe handling', async () => {
      let releaseSubscribe!: () => void;
      const subscribePropagation = new Promise<void>((resolve) => {
        releaseSubscribe = resolve;
      });
      const subscribable = createStubTransport({
        subscribe: async () => {
          await subscribePropagation;
        },
      });

      const unregister = registerTransport('sub' as keyof BusTransportRegistry, subscribable).unregister;

      try {
        let settled = false;
        const receive = sourceTransport
          .simulateReceive({
            type: 'subscribe',
            subjects: { 'test.confirm': [] },
            deliveryClasses: { 'test.confirm': 'relayable' },
          })
          .then(() => {
            settled = true;
          });

        await Promise.resolve();
        expect(subscribable.subscribe).toHaveBeenCalledWith('test.confirm', undefined, [], 'relayable');
        expect(settled).toBe(false);

        releaseSubscribe();
        await receive;
        expect(settled).toBe(true);
      } finally {
        unregister();
      }
    });

    it('should propagate unsubscribe messages to transports with unsubscribe()', async () => {
      const recordedUnsubscribes: string[] = [];
      const subscribable: BusTransport = {
        name: 'subscribable-transport',
        send: (async (message: BusMessage) =>
          message.type === 'request' ? { output: 'mocked' } : true) as BusTransport['send'],
        onReceive: () => () => {},
        connect: async () => {},
        disconnect: async () => {},
        subscribe: async () => {},
        unsubscribe: async (subject: string) => {
          recordedUnsubscribes.push(subject);
        },
      };

      const unregister = registerTransport('unsub' as keyof BusTransportRegistry, subscribable).unregister;

      try {
        const unsubscribeMsg: BusUnsubscribeMessage = {
          type: 'unsubscribe',
          subjects: { 'test.confirm': [], 'test.prompt': [] },
        };
        await sourceTransport.simulateReceive(unsubscribeMsg);

        expect(recordedUnsubscribes).toEqual(['test.confirm', 'test.prompt']);
      } finally {
        unregister();
      }
    });

    it('waits for advertised unsubscribe propagation before resolving inbound unsubscribe handling', async () => {
      let releaseUnsubscribe!: () => void;
      const unsubscribePropagation = new Promise<void>((resolve) => {
        releaseUnsubscribe = resolve;
      });
      const subscribable = createStubTransport({
        subscribe: async () => {},
        unsubscribe: async () => {
          await unsubscribePropagation;
        },
      });

      const unregister = registerTransport('unsub' as keyof BusTransportRegistry, subscribable).unregister;

      try {
        let settled = false;
        const receive = sourceTransport
          .simulateReceive({
            type: 'unsubscribe',
            subjects: { 'test.confirm': [] },
          })
          .then(() => {
            settled = true;
          });

        await Promise.resolve();
        expect(subscribable.unsubscribe).toHaveBeenCalledWith('test.confirm');
        expect(settled).toBe(false);

        releaseUnsubscribe();
        await receive;
        expect(settled).toBe(true);
      } finally {
        unregister();
      }
    });
  });

  describe('E2E: three-context request relay', () => {
    it('should relay a request from server through worker to tab and return the response', async () => {
      const recordedRequests: BusRequestMessage[] = [];
      let tabHandler: ((message: BusMessage) => Promise<void>) | undefined;
      const tabTransport: BusTransport = {
        name: 'tab-transport',
        send: (async (message: BusMessage) => {
          if (message.type === 'request') {
            recordedRequests.push(message);
            return { answer: 42 };
          }
          return true;
        }) as BusTransport['send'],
        onReceive: (handler) => {
          tabHandler = handler;
          return () => {
            tabHandler = undefined;
          };
        },
        connect: async () => {},
        disconnect: async () => {},
        subscribe: async () => {},
        unsubscribe: async () => {},
      };

      const unregisterTab = registerTransport('tab' as keyof BusTransportRegistry, tabTransport).unregister;

      try {
        // Advertise the tab transport's handler so dispatch knows to route compute.solve there.
        await tabHandler?.({
          type: 'subscribe',
          subjects: { 'compute.solve': [0] },
          deliveryClasses: { 'compute.solve': 'relayable' },
        });

        // Act: server sends a request into the worker bus (MakaioBus).
        // The worker has no local handler, so the registry relays to tabTransport.
        await sourceTransport.simulateReceive({
          type: 'request',
          namespace: 'compute',
          subject: 'solve',
          payload: { problem: 'meaning-of-life' },
          correlationId: 'corr-e2e-relay',
          messageId: 'msg-e2e-relay',
        });

        expect(recordedRequests).toHaveLength(1);
        expect(recordedRequests[0]).toMatchObject({
          type: 'request',
          namespace: 'compute',
          subject: 'solve',
        });

        // Assert: serverTransport received the response with the tab's result.
        expect(sourceTransport.messages).toHaveLength(1);
        expect(sourceTransport.messages[0]).toMatchObject({
          type: 'response',
          correlationId: 'corr-e2e-relay',
          result: { answer: 42 },
        });
      } finally {
        unregisterTab();
      }
    });
  });

  describe('Subscribe propagation via bus.on()', () => {
    it('should call transport.subscribe() when handler is registered', async () => {
      const subscribable = createStubTransport({ subscribe: async () => {} });

      const unregister = registerTransport('sub' as keyof BusTransportRegistry, subscribable).unregister;

      try {
        const cleanup = MakaioBus.on(TestSubjects.testRequest, (ctx) => {
          ctx.setResult({ output: 'handled' });
        });

        expect(subscribable.subscribe).toHaveBeenCalledWith('relayTest.testRequest', undefined, [0], 'relayable');

        cleanup();

        expect(subscribable.unsubscribe).toHaveBeenCalledWith('relayTest.testRequest');
      } finally {
        unregister();
      }
    });

    it('should derive exact-subject handler kind from the subject schema', async () => {
      const subscribable = createStubTransport({ subscribe: async () => {} });

      const unregister = registerTransport('sub' as keyof BusTransportRegistry, subscribable).unregister;

      try {
        const cleanup = MakaioBus.on(TestSubjects.testRequest, () => undefined, { handlerKind: 'event' });

        expect(subscribable.subscribe).toHaveBeenCalledWith('relayTest.testRequest', undefined, [0], 'relayable');

        cleanup();
      } finally {
        unregister();
      }
    });

    it('should advertise wildcard event handlers without request priority when handlerKind is event', async () => {
      const subscribable = createStubTransport({ subscribe: async () => {} });

      const unregister = registerTransport('sub' as keyof BusTransportRegistry, subscribable).unregister;

      try {
        const cleanup = MakaioBus.on(TestSubjects.$all, () => undefined, { handlerKind: 'event' });

        expect(subscribable.subscribe).toHaveBeenCalledWith('relayTest.*', undefined, [], 'relayable');

        cleanup();

        expect(subscribable.unsubscribe).toHaveBeenCalledWith('relayTest.*');
      } finally {
        unregister();
      }
    });

    it('should advertise wildcard request handlers with priority when handlerKind is request', async () => {
      const subscribable = createStubTransport({ subscribe: async () => {} });

      const unregister = registerTransport('sub' as keyof BusTransportRegistry, subscribable).unregister;

      try {
        const cleanup = MakaioBus.on(TestSubjects.$all, () => undefined, { handlerKind: 'request', priority: 250 });

        expect(subscribable.subscribe).toHaveBeenCalledWith('relayTest.*', undefined, [250], 'relayable');

        cleanup();

        expect(subscribable.unsubscribe).toHaveBeenCalledWith('relayTest.*');
      } finally {
        unregister();
      }
    });

    it('should backfill existing subscriptions when transport registers after handlers', async () => {
      const cleanup = MakaioBus.on(TestSubjects.testRequest, (ctx) => {
        ctx.setResult({ output: 'handled' });
      });

      const subscribable = createStubTransport({ subscribe: async () => {} });

      const unregister = registerTransport('late-sub' as keyof BusTransportRegistry, subscribable).unregister;

      try {
        expect(subscribable.subscribe).toHaveBeenCalledWith('relayTest.testRequest', undefined, [0], 'relayable');
      } finally {
        unregister();
        cleanup();
      }
    });

    it('should not fail transport registration when backfill subscribe rejects', () => {
      const cleanup = MakaioBus.on(TestSubjects.testRequest, (ctx) => {
        ctx.setResult({ output: 'handled' });
      });

      const subscribable = createStubTransport({
        subscribe: async () => {
          throw new Error('E2E relay session not established');
        },
      });

      expect(() => registerTransport('late-sub-fail' as keyof BusTransportRegistry, subscribable)).not.toThrow();
      cleanup();
    });
  });
});
