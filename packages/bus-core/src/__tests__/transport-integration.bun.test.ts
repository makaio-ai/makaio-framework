import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import {
  MakaioBus,
  type BusTransport,
  type BusMessage,
  type BusRequestMessage,
  type BusEventMessage,
  NoHandlerError,
  type BusTransportRegistry,
} from '../index.js';

/**
 * Mock transport for testing transport integration.
 * Tracks all sent messages and allows simulation of incoming messages.
 */
class MockTransport implements BusTransport {
  public readonly name = 'mock-transport';
  public messages: BusMessage[] = [];
  public lastTimeout: number | undefined;
  private handler?: (message: BusMessage) => Promise<void>;

  // Overloads to satisfy conditional return type
  public send(message: BusRequestMessage, timeout?: number): Promise<unknown>;
  public send(message: BusEventMessage, timeout?: number): Promise<boolean>;
  public send(message: BusMessage, timeout?: number): Promise<unknown | boolean>;
  public send(message: BusMessage, timeout?: number): Promise<unknown | boolean> {
    this.lastTimeout = timeout;
    this.messages.push(message);
    if (message.type === 'request') {
      // Return schema-compliant response: { output: string }
      return Promise.resolve({ output: 'mocked' });
    }
    return Promise.resolve(true);
  }

  onReceive(handler: (message: BusMessage) => Promise<void>): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async subscribe(): Promise<void> {}
  async unsubscribe(): Promise<void> {}

  // Test helper: simulate receiving a message
  async simulateReceive(message: BusMessage): Promise<void> {
    if (this.handler) await this.handler(message);
  }

  // Test helper: clear recorded messages
  clear(): void {
    this.messages = [];
  }
}

/**
 * Mock transport with explicit subscription set for filtering tests.
 */
class SubscribedMockTransport extends MockTransport {
  /**
   * @param subscriptions - Subject patterns this transport claims interest in
   */
  public constructor(private readonly subscriptions: Set<string>) {
    super();
  }

  /**
   * @returns Copy of the subscription patterns
   */
  public getSubscriptions(): Set<string> {
    return new Set(this.subscriptions);
  }
}

class PendingRequestTransport extends MockTransport {
  public send(message: BusRequestMessage, timeout?: number): Promise<unknown>;
  public send(message: BusEventMessage, timeout?: number): Promise<boolean>;
  public send(message: BusMessage, timeout?: number): Promise<unknown | boolean> {
    this.lastTimeout = timeout;
    this.messages.push(message);
    if (message.type === 'request') {
      return new Promise(() => {});
    }
    return Promise.resolve(true);
  }
}

// Register test subjects
const { subjects: TestSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('test', {
    // Event subject
    testEvent: z.object({ message: z.string() }),

    // Request subject
    testRequest: {
      request: z.object({ input: z.string() }),
      response: z.object({ output: z.string() }),
    },
  }),
);

// Augment types for type safety
declare module '../index.js' {
  interface BusTransportRegistry {
    mock: BusTransport;
  }

  interface BusSubjectsNamespace {
    test: typeof TestSubjects;
  }
}
const { registerTransport, getTransport } = MakaioBus.getContext().transportRegistry;

describe('Transport Integration', () => {
  let mockTransport: MockTransport;
  let unregister: () => void;

  beforeEach(() => {
    // Create and register mock transport
    mockTransport = new MockTransport();
    unregister = registerTransport('mock', mockTransport).unregister;

    // Clear global handler maps
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    // Unregister transport
    unregister();

    // Clear handlers
    MakaioBus.__resetHandlers?.();
  });

  describe('emit() with transport filtering', () => {
    it('should send to all transports when transports is undefined', async () => {
      await MakaioBus.emit(TestSubjects.testEvent, { message: 'hello' });

      expect(mockTransport.messages).toHaveLength(1);
      expect(mockTransport.messages[0]).toMatchObject({
        type: 'event',
        subject: 'testEvent',
        namespace: 'test',
        payload: { message: 'hello' },
      });
    });

    it('should not send to any transport when transports is empty array', async () => {
      await MakaioBus.emit(TestSubjects.testEvent, { message: 'hello' }, { transports: [] });

      expect(mockTransport.messages).toHaveLength(0);
    });

    it('should send to specific transport when transports array contains it', async () => {
      await MakaioBus.emit(
        TestSubjects.testEvent,
        { message: 'hello' },
        {
          transports: ['mock'],
        },
      );

      expect(mockTransport.messages).toHaveLength(1);
      expect(mockTransport.messages[0]).toMatchObject({
        type: 'event',
        subject: 'testEvent',
        namespace: 'test',
        payload: { message: 'hello' },
      });
    });

    it('should execute local handlers even when transports is empty', async () => {
      const localPayloads: Array<{ message: string }> = [];

      MakaioBus.on(TestSubjects.testEvent, ({ payload }) => {
        localPayloads.push(payload);
      });

      await MakaioBus.emit(TestSubjects.testEvent, { message: 'hello' }, { transports: [] });

      expect(localPayloads).toHaveLength(1);
      expect(localPayloads[0]).toEqual({ message: 'hello' });
      expect(mockTransport.messages).toHaveLength(0);
    });

    it('should include messageId and correlationId in transport message', async () => {
      await MakaioBus.emit(
        TestSubjects.testEvent,
        { message: 'hello' },
        {
          messageId: 'test-msg-123',
          correlationId: 'test-corr-456',
        },
      );

      expect(mockTransport.messages[0]).toMatchObject({
        messageId: 'test-msg-123',
        correlationId: 'test-corr-456',
      });
    });
  });

  describe('request() with transport', () => {
    /**
     * Advertise the test request subject on the mock transport so that
     * remoteRequestHandlers is populated and dispatch can route to the transport.
     * Must be called after __resetHandlers() to re-populate the registry.
     */
    async function advertiseTestRequest(): Promise<void> {
      await mockTransport.simulateReceive({
        type: 'subscribe',
        subjects: { 'test.testRequest': [0] },
      });
    }

    it('should use local handler when available (no transport)', async () => {
      MakaioBus.on(TestSubjects.testRequest, (context) => {
        context.setResult({ output: `processed: ${context.payload.input}` });
      });

      const result = await MakaioBus.request(TestSubjects.testRequest, { input: 'test' });

      expect(result).toEqual({ output: 'processed: test' });
      expect(mockTransport.messages).toHaveLength(0);
    });

    it('should fall back to transport when no local handler exists', async () => {
      await advertiseTestRequest();

      const result = await MakaioBus.request(TestSubjects.testRequest, { input: 'test' });

      expect(result).toEqual({ output: 'mocked' });
      expect(mockTransport.messages).toHaveLength(1);
      expect(mockTransport.messages[0]).toMatchObject({
        type: 'request',
        subject: 'testRequest',
        namespace: 'test',
        payload: { input: 'test' },
      });
    });

    it('should not use transport when transports is empty array', async () => {
      await expect(MakaioBus.request(TestSubjects.testRequest, { input: 'test' }, { transports: [] })).rejects.toThrow(
        NoHandlerError,
      );

      expect(mockTransport.messages).toHaveLength(0);
    });

    it('should route to advertised transport (remote handler registry)', async () => {
      await advertiseTestRequest();

      const result = await MakaioBus.request(TestSubjects.testRequest, { input: 'test' });

      expect(result).toEqual({ output: 'mocked' });
      expect(mockTransport.messages).toHaveLength(1);
    });

    it('should allow non-empty transport allowlists for remote requests', async () => {
      await advertiseTestRequest();

      const result = await MakaioBus.request(TestSubjects.testRequest, { input: 'test' }, { transports: ['mock'] });

      expect(result).toEqual({ output: 'mocked' });
      expect(mockTransport.messages).toHaveLength(1);
      expect(mockTransport.messages[0]).toMatchObject({
        type: 'request',
        subject: 'testRequest',
        namespace: 'test',
        payload: { input: 'test' },
      });
    });

    it('should include messageId and correlationId in transport request', async () => {
      await advertiseTestRequest();

      await MakaioBus.request(
        TestSubjects.testRequest,
        { input: 'test' },
        {
          messageId: 'req-msg-123',
          correlationId: 'req-corr-456',
        },
      );

      expect(mockTransport.messages[0]).toMatchObject({
        messageId: 'req-msg-123',
        correlationId: 'req-corr-456',
      });
    });

    it('should route to transport regardless of its getSubscriptions() result', async () => {
      // In the priority cursor dispatch model, routing is driven by remoteRequestHandlers
      // (populated via subscribe wire messages), not by the transport's getSubscriptions().
      // A transport that was advertised via a subscribe message will receive requests
      // regardless of what its getSubscriptions() filter reports.
      unregister();
      const filteredOutTransport = new SubscribedMockTransport(new Set(['widget.register']));
      unregister = registerTransport('mock', filteredOutTransport).unregister;

      // Advertise the test request subject on the filtered transport.
      await filteredOutTransport.simulateReceive({
        type: 'subscribe',
        subjects: { 'test.testRequest': [0] },
      });

      const result = await MakaioBus.request(TestSubjects.testRequest, { input: 'stale-subscription' });

      expect(result).toEqual({ output: 'mocked' });
      expect(filteredOutTransport.messages).toHaveLength(1);
      expect(filteredOutTransport.messages[0]).toMatchObject({
        type: 'request',
        subject: 'testRequest',
        namespace: 'test',
      });
    });

    it('should try the next advertised transport when first throws a non-nohandler error', async () => {
      const secondTransport = new MockTransport();
      const unregisterSecond = registerTransport('second' as keyof BusTransportRegistry, secondTransport).unregister;

      try {
        // Advertise the request subject on both transports at the same priority.
        // The mock transport (registered as 'mock') will fail; the second should be tried.
        await advertiseTestRequest();
        await secondTransport.simulateReceive({
          type: 'subscribe',
          subjects: { 'test.testRequest': [0] },
        });

        const originalSend = mockTransport.send.bind(mockTransport);
        mockTransport.send = async () => {
          throw new Error('E2E relay session not established');
        };

        try {
          const result = await MakaioBus.request(TestSubjects.testRequest, { input: 'fallback' });

          expect(result).toEqual({ output: 'mocked' });
          expect(secondTransport.messages).toHaveLength(1);
          expect(secondTransport.messages[0]).toMatchObject({
            type: 'request',
            subject: 'testRequest',
            namespace: 'test',
            payload: { input: 'fallback' },
          });
        } finally {
          mockTransport.send = originalSend;
        }
      } finally {
        unregisterSecond();
      }
    });

    it('should not try additional transports after caller aborts', async () => {
      unregister();

      const pendingTransport = new PendingRequestTransport();
      const fallbackTransport = new MockTransport();
      const unregisterPending = registerTransport('mock', pendingTransport).unregister;
      const unregisterFallback = registerTransport(
        'second' as keyof BusTransportRegistry,
        fallbackTransport,
      ).unregister;

      // Advertise the pending transport as the handler for this subject so dispatch
      // routes to it. The fallback transport is intentionally not advertised — the
      // test verifies it never receives a request after the caller aborts.
      MakaioBus.getContext().remoteRequestHandlers.set('test.testRequest', [{ transport: 'mock', priority: 0 }]);

      const controller = new AbortController();

      try {
        const requestPromise = MakaioBus.request(
          TestSubjects.testRequest,
          { input: 'abort' },
          { timeout: 0, signal: controller.signal },
        );
        setTimeout(() => controller.abort(new Error('caller-aborted')), 10);

        await expect(requestPromise).rejects.toThrow('caller-aborted');
        expect(pendingTransport.messages).toHaveLength(1);
        expect(fallbackTransport.messages).toHaveLength(0);
      } finally {
        unregisterPending();
        unregisterFallback();
      }
    });
  });

  describe('broadcast() with transport', () => {
    it('should pass default timeout to transport broadcasts', async () => {
      await MakaioBus.broadcast(TestSubjects.testRequest, { input: 'broadcast-default-timeout' });
      expect(mockTransport.lastTimeout).toBe(60_000);
    });

    it('should pass custom timeout to transport broadcasts', async () => {
      await MakaioBus.broadcast(TestSubjects.testRequest, { input: 'broadcast-custom-timeout' }, { timeout: 5_432 });
      expect(mockTransport.lastTimeout).toBe(5_432);
    });

    it('should honor timeout=0 as no-timeout and allow AbortSignal cancellation', async () => {
      MakaioBus.on(TestSubjects.testRequest, async () => {
        await new Promise(() => {});
      });

      const controller = new AbortController();
      const broadcastPromise = MakaioBus.broadcast(
        TestSubjects.testRequest,
        { input: 'broadcast-abort' },
        { timeout: 0, signal: controller.signal },
      );

      setTimeout(() => controller.abort(new Error('broadcast-aborted')), 10);

      await expect(broadcastPromise).rejects.toThrow('broadcast-aborted');
    });
  });

  describe('Incoming transport messages', () => {
    it('should route incoming events to local handlers', async () => {
      const received: Array<{ message: string }> = [];

      MakaioBus.on(TestSubjects.testEvent, ({ payload }) => {
        received.push(payload);
      });

      await mockTransport.simulateReceive({
        type: 'event',
        namespace: 'test',
        subject: 'testEvent',
        payload: { message: 'from-remote' },
        messageId: 'incoming-event-1',
      });

      expect(received).toEqual([{ message: 'from-remote' }]);
    });

    it('should resolve incoming requests and reply with response', async () => {
      MakaioBus.on(TestSubjects.testRequest, (context) => {
        context.setResult({ output: `processed:${context.payload.input}` });
      });

      mockTransport.clear();

      await mockTransport.simulateReceive({
        type: 'request',
        namespace: 'test',
        subject: 'testRequest',
        payload: { input: 'from-remote' },
        correlationId: 'corr-incoming-1',
        messageId: 'incoming-request-1',
      });

      expect(mockTransport.messages).toHaveLength(1);
      expect(mockTransport.messages[0]).toMatchObject({
        type: 'response',
        correlationId: 'corr-incoming-1',
        result: { output: 'processed:from-remote' },
      });
    });

    it('should send error response when subject is unknown and no relay target available', async () => {
      mockTransport.clear();

      await mockTransport.simulateReceive({
        type: 'request',
        namespace: 'test',
        subject: 'nonExisting',
        payload: { input: 'noop' },
        correlationId: 'corr-incoming-unknown',
        messageId: 'incoming-request-unknown',
      });

      expect(mockTransport.messages).toHaveLength(1);
      expect(mockTransport.messages[0]).toMatchObject({
        type: 'response',
        correlationId: 'corr-incoming-unknown',
        error: {
          code: 'NO_HANDLER',
          subject: 'test.nonExisting',
          message: expect.stringContaining('No handler registered'),
        },
      });
    });
  });

  describe('Transport registration', () => {
    it('should register transport successfully', () => {
      const transport = getTransport('mock');
      expect(transport).toBe(mockTransport);
    });

    it('should return transport by name', () => {
      const retrieved = getTransport('mock');
      expect(retrieved).toBe(mockTransport);
    });

    it('should unregister transport when unregister function is called', () => {
      unregister();
      const transport = getTransport('mock');
      expect(transport).toBeUndefined();
    });

    it('should allow re-registration after unregister', () => {
      unregister();

      const newTransport = new MockTransport();
      const newUnregister = registerTransport('mock', newTransport).unregister;

      const retrieved = getTransport('mock');
      expect(retrieved).toBe(newTransport);
      expect(retrieved).not.toBe(mockTransport);

      newUnregister();
    });
  });

  describe('Multiple transports', () => {
    let secondTransport: MockTransport;
    let unregisterSecond: () => void;

    beforeEach(() => {
      secondTransport = new MockTransport();

      // Augment registry for second transport (cast needed as 'second' isn't in BusTransportRegistry)
      unregisterSecond = registerTransport('second' as keyof BusTransportRegistry, secondTransport).unregister;
    });

    afterEach(() => {
      unregisterSecond();
    });

    it('should send event to all registered transports by default', async () => {
      await MakaioBus.emit(TestSubjects.testEvent, { message: 'broadcast' });

      expect(mockTransport.messages).toHaveLength(1);
      expect(secondTransport.messages).toHaveLength(1);
    });

    it('should send event only to specified transports', async () => {
      await MakaioBus.emit(
        TestSubjects.testEvent,
        { message: 'selective' },
        {
          transports: ['mock'],
        },
      );

      expect(mockTransport.messages).toHaveLength(1);
      expect(secondTransport.messages).toHaveLength(0);
    });
  });

  describe('Error handling', () => {
    it('should continue execution if transport send fails for events', async () => {
      // Make transport throw error
      const originalSend = mockTransport.send.bind(mockTransport);
      mockTransport.send = async () => {
        throw new Error('Transport error');
      };

      // Should not throw
      await expect(MakaioBus.emit(TestSubjects.testEvent, { message: 'test' })).resolves.toBeUndefined();

      // Restore
      mockTransport.send = originalSend;
    });

    it('should throw if transport send fails for requests', async () => {
      // Advertise the mock transport so dispatch routes to it, then override send to throw.
      await mockTransport.simulateReceive({ type: 'subscribe', subjects: { 'test.testRequest': [0] } });
      mockTransport.send = async () => {
        throw new Error('Transport error');
      };

      await expect(MakaioBus.request(TestSubjects.testRequest, { input: 'test' })).rejects.toThrow('Transport error');
    });
  });
});
