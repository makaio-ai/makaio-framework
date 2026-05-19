import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import {
  MakaioBus,
  type BusTransport,
  type BusMessage,
  type BusRequestMessage,
  type BusEventMessage,
} from '../index.js';
import { serializeError, deserializeTransportError } from '../utils/transport.js';

/**
 * Mock transport for testing structured transport errors.
 */
class MockTransport implements BusTransport {
  public readonly name = 'mock-transport';
  public messages: BusMessage[] = [];
  private handler?: (message: BusMessage) => Promise<void>;

  public send(message: BusRequestMessage): Promise<unknown>;
  public send(message: BusEventMessage): Promise<boolean>;
  public send(message: BusMessage): Promise<unknown | boolean>;
  public send(message: BusMessage): Promise<unknown | boolean> {
    this.messages.push(message);
    if (message.type === 'request') {
      return Promise.resolve({ mocked: true });
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

  async simulateReceive(message: BusMessage): Promise<void> {
    if (this.handler) await this.handler(message);
  }
}

/**
 * Structured error used to validate transport error serialization.
 */
class StructuredTestError extends Error {
  public readonly code = 'TEST_CODE';
  public readonly conflicts = ['conflict-1'];
  public readonly orphans = ['orphan-1'];

  public constructor(message: string) {
    super(message);
    this.name = 'StructuredTestError';
  }
}

const { subjects: ErrorSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('transportError', {
    testRequest: {
      request: z.object({ input: z.string() }),
      response: z.object({ output: z.string() }),
    },
  }),
);

declare module '../index.js' {
  interface BusTransportRegistry {
    mock: BusTransport;
  }
}

const { registerTransport } = MakaioBus.getContext().transportRegistry;

describe('Transport error serialization', () => {
  let mockTransport: MockTransport;
  let unregister: () => void;

  beforeEach(() => {
    mockTransport = new MockTransport();
    unregister = registerTransport('mock', mockTransport).unregister;
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    unregister();
    MakaioBus.__resetHandlers?.();
  });

  it('serializes structured handler errors from RequestError cause', async () => {
    MakaioBus.on(ErrorSubjects.testRequest, () => {
      throw new StructuredTestError('boom');
    });

    await mockTransport.simulateReceive({
      type: 'request',
      namespace: 'transportError',
      subject: 'testRequest',
      payload: { input: 'from-remote' },
      correlationId: 'corr-incoming-structured',
      messageId: 'incoming-request-structured',
    });

    expect(mockTransport.messages).toHaveLength(1);
    expect(mockTransport.messages[0]).toMatchObject({
      type: 'response',
      correlationId: 'corr-incoming-structured',
      error: {
        code: 'TEST_CODE',
        data: {
          conflicts: ['conflict-1'],
          orphans: ['orphan-1'],
        },
      },
    });
  });
});

describe('serializeError generic data extraction', () => {
  it('extracts arbitrary own enumerable properties from error.cause into data', () => {
    const cause = new Error('handler failed');
    (cause as Error & Record<string, unknown>).code = 'IMPORT_FAILED';
    (cause as Error & Record<string, unknown>).data = { items: ['a', 'b'] };
    (cause as Error & Record<string, unknown>).retryable = true;

    const wrapper = new Error(`Request to "import.run" failed: handler failed`);
    wrapper.cause = cause;

    const serialized = serializeError(wrapper);

    expect(serialized.code).toBe('IMPORT_FAILED');
    expect(serialized.data).toMatchObject({
      data: { items: ['a', 'b'] },
      retryable: true,
    });
    // Top-level Error fields and already-extracted fields must not leak into data
    expect(serialized.data).not.toHaveProperty('message');
    expect(serialized.data).not.toHaveProperty('name');
    expect(serialized.data).not.toHaveProperty('stack');
    expect(serialized.data).not.toHaveProperty('cause');
    expect(serialized.data).not.toHaveProperty('code');
  });

  it('round-trips arbitrary properties through deserializeTransportError', () => {
    const cause = new Error('handler failed');
    (cause as Error & Record<string, unknown>).code = 'IMPORT_FAILED';
    (cause as Error & Record<string, unknown>).data = { items: ['a', 'b'] };
    (cause as Error & Record<string, unknown>).retryable = true;

    const wrapper = new Error(`Request to "import.run" failed: handler failed`);
    wrapper.cause = cause;

    const serialized = serializeError(wrapper);
    const reconstructed = deserializeTransportError(serialized) as Error & Record<string, unknown>;

    expect(reconstructed.code).toBe('IMPORT_FAILED');
    expect(reconstructed.data).toEqual({ items: ['a', 'b'] });
    expect(reconstructed.retryable).toBe(true);
  });

  it('excludes functions and undefined values from data', () => {
    const cause = new Error('fail');
    (cause as Error & Record<string, unknown>).retryable = true;
    (cause as Error & Record<string, unknown>).handler = (): void => undefined;
    (cause as Error & Record<string, unknown>).count = undefined;

    const wrapper = new Error('Request failed');
    wrapper.cause = cause;

    const serialized = serializeError(wrapper);

    expect(serialized.data).toMatchObject({ retryable: true });
    expect(serialized.data).not.toHaveProperty('handler');
    expect(serialized.data).not.toHaveProperty('count');
  });

  it('extracts subject from structuredSource when wrapper lacks it', () => {
    const cause = new Error('no handler');
    (cause as Error & Record<string, unknown>).subject = 'test.missing';

    const wrapper = new Error('Request failed');
    wrapper.cause = cause;

    const serialized = serializeError(wrapper);

    expect(serialized.subject).toBe('test.missing');
  });

  it('falls back to structuredSource subject when wrapper subject is present but non-string', () => {
    const cause = new Error('no handler');
    (cause as Error & Record<string, unknown>).subject = 'adapter.log';

    const wrapper = new Error('Request failed') as Error & { subject?: unknown };
    wrapper.subject = undefined;
    wrapper.cause = cause;

    const serialized = serializeError(wrapper);

    expect(serialized.subject).toBe('adapter.log');
  });

  it('excludes bigint and symbol values from data', () => {
    const cause = new Error('fail');
    (cause as Error & Record<string, unknown>).retryable = true;
    (cause as Error & Record<string, unknown>).bigField = BigInt(42);
    (cause as Error & Record<string, unknown>).symField = Symbol('test');

    const wrapper = new Error('Request failed');
    wrapper.cause = cause;

    const serialized = serializeError(wrapper);

    expect(serialized.data).toMatchObject({ retryable: true });
    expect(serialized.data).not.toHaveProperty('bigField');
    expect(serialized.data).not.toHaveProperty('symField');
  });
});
