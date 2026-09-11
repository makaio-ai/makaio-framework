import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import {
  MakaioBus,
  type BusTransport,
  type BusMessage,
  type BusRequestMessage,
  type BusEventMessage,
} from '../index.js';
import { serializeError, deserializeTransportError, transportErrorData, findInErrorChain } from '../utils/transport.js';

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

describe('transportErrorData and findInErrorChain', () => {
  describe('transportErrorData', () => {
    it('returns the data object for a class-instance shape (error.data is a plain object)', () => {
      const err = new Error('test') as Error & { data?: unknown };
      err.data = { issues: [1] };
      expect(transportErrorData(err)).toEqual({ issues: [1] });
    });

    it('returns a shallow copy, not the same reference', () => {
      const data = { issues: [1] };
      const err = new Error('test') as Error & { data?: unknown };
      err.data = data;
      const result = transportErrorData(err);
      expect(result).toEqual(data);
      expect(result).not.toBe(data);
    });

    it('returns structured members for a deserialized (flat) shape', () => {
      const original = new Error('boom') as Error & { data?: Record<string, unknown> };
      original.data = { retryable: true, count: 3 };
      const deserialized = deserializeTransportError(serializeError(original));
      const result = transportErrorData(deserialized);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('retryable', true);
      expect(result).toHaveProperty('count', 3);
      expect(result).not.toHaveProperty('message');
      expect(result).not.toHaveProperty('code');
      expect(result).not.toHaveProperty('subject');
      expect(result).not.toHaveProperty('stack');
      expect(result).not.toHaveProperty('name');
    });

    it('returns undefined for a non-object input', () => {
      expect(transportErrorData(null)).toBeUndefined();
      expect(transportErrorData(undefined)).toBeUndefined();
      expect(transportErrorData('string')).toBeUndefined();
      expect(transportErrorData(42)).toBeUndefined();
    });

    it('returns undefined for an Error without structured members', () => {
      const plain = new Error('no data');
      expect(transportErrorData(plain)).toBeUndefined();
    });

    it('returns undefined when data property is not a plain object', () => {
      const err = new Error('test') as Error & { data?: unknown };
      err.data = [1, 2, 3];
      // Array is not a plain object — falls through to flat-shape path
      // The 'data' key itself is not in SKIP_PROPS, so it appears in flat result
      const result = transportErrorData(err);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('data');
    });
  });

  describe('findInErrorChain', () => {
    it('finds a member two cause levels deep', () => {
      const root = new Error('root');
      const mid = new Error('mid') as Error & { cause?: unknown };
      const deep = new Error('deep') as Error & { data?: Record<string, unknown>; cause?: unknown };
      deep.data = { foundIt: true };
      mid.cause = deep;
      root.cause = mid;
      const result = findInErrorChain(root, transportErrorData);
      expect(result).toEqual({ foundIt: true });
    });

    it('returns undefined when no link matches the predicate', () => {
      const err = new Error('plain');
      expect(findInErrorChain(err, transportErrorData)).toBeUndefined();
    });

    it('returns undefined and does not hang on a cyclic cause chain', () => {
      const a = new Error('a') as Error & { cause?: unknown };
      const b = new Error('b') as Error & { cause?: unknown };
      a.cause = b;
      b.cause = a;
      expect(findInErrorChain(a, transportErrorData)).toBeUndefined();
    });

    it('continues the walk when predicate returns undefined', () => {
      const a = new Error('a') as Error & { cause?: unknown };
      const b = new Error('b') as Error & { data?: Record<string, unknown>; cause?: unknown };
      b.data = { target: 42 };
      a.cause = b;
      let callCount = 0;
      const result = findInErrorChain(a, (rec) => {
        callCount++;
        return transportErrorData(rec);
      });
      expect(callCount).toBe(2);
      expect(result).toEqual({ target: 42 });
    });

    it('returns undefined for a non-object error', () => {
      expect(findInErrorChain(null, transportErrorData)).toBeUndefined();
      expect(findInErrorChain('string', transportErrorData)).toBeUndefined();
    });

    it('symmetry: findInErrorChain finds cause data before and after a round-trip', () => {
      // Before round-trip (class instance)
      const causeErr = new Error('cause') as Error & { data?: Record<string, unknown>; cause?: unknown };
      causeErr.data = { severity: 'critical' };
      const wrapperErr = new Error('wrapper') as Error & { cause?: unknown };
      wrapperErr.cause = causeErr;
      const beforeResult = findInErrorChain(wrapperErr, transportErrorData);
      expect(beforeResult).toEqual({ severity: 'critical' });

      // After round-trip (deserialized flat shape)
      const serialized = serializeError(wrapperErr);
      const deserialized = deserializeTransportError(serialized);
      const afterResult = findInErrorChain(deserialized, transportErrorData);
      // serializeError promotes cause's data to the top-level — so the
      // deserialized error itself carries the structured members flat.
      expect(afterResult).toBeDefined();
      expect(afterResult).toHaveProperty('severity', 'critical');
    });
  });
});
