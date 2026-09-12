import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import {
  MakaioBus,
  type BusTransport,
  type BusMessage,
  type BusRequestMessage,
  type BusEventMessage,
  type BusTransportError,
} from '../index.js';
import { serializeError, deserializeTransportError, transportErrorData, findInErrorChain } from '../utils/transport.js';
import { serializeTransportError } from '../utils/transport-helpers.js';

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

    it('returns bag members after serializeError→deserializeTransportError for an error with a data bag', () => {
      // serializeError copies original.data as result.data.data (nested bag).
      // deserializeTransportError then restores .data = { retryable, count } as own prop.
      // transportErrorData extracts those bag members via the merge rule.
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

    it('merges bag + sibling members for a class instance with both, same result after round-trip', () => {
      // In-process instance: data bag with issues, plus sibling retryable prop.
      const err = new Error('multi') as Error & { data?: unknown; retryable?: boolean };
      err.data = { issues: [1] };
      err.retryable = true;

      const direct = transportErrorData(err);
      expect(direct).toEqual({ issues: [1], retryable: true });

      // After serializeError→deserializeTransportError the merge rule must yield
      // the same result: result.data.data = { issues: [1] }, result.data.retryable = true
      // → deserialized.data = { issues: [1] }, deserialized.retryable = true
      // → transportErrorData merges to { issues: [1], retryable: true }.
      const deserialized = deserializeTransportError(serializeError(err)) as Error & Record<string, unknown>;
      const afterRoundTrip = transportErrorData(deserialized);
      expect(afterRoundTrip).toEqual({ issues: [1], retryable: true });
    });

    it('transportErrorData unwraps the nested bag from serializeTransportError→deserializeTransportError', () => {
      // serializeTransportError now uses the same codec as serializeError: the
      // plain-object 'data' bag nests at wire.data.data, so after
      // deserializeTransportError the rebuilt error carries .data = { a, b } as an
      // own bag. transportErrorData unwraps that bag — result has no 'data' key.
      const wire = serializeTransportError({ message: 'flat', code: 'FC', data: { a: 1, b: 'two' } });
      const rebuilt = deserializeTransportError(wire);
      const result = transportErrorData(rebuilt);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('a', 1);
      expect(result).toHaveProperty('b', 'two');
      expect(result).not.toHaveProperty('data');
    });

    it('extracts bag members from a raw BusTransportError object', () => {
      // A plain BusTransportError object (not yet deserialized) carries the bag
      // under its own 'data' property; transportErrorData must unwrap it.
      const raw = { message: 'raw', code: 'RC', data: { a: 1 } };
      const result = transportErrorData(raw);
      expect(result).toEqual({ a: 1 });
    });

    it('bag member wins on collision with a same-named flat sibling', () => {
      // When both a flat prop and a bag member share the key 'x', the bag wins.
      const err = new Error('collision') as Error & { data?: unknown; x?: string };
      err.data = { x: 'nested' };
      err.x = 'flat';
      const result = transportErrorData(err);
      expect(result).toHaveProperty('x', 'nested');
    });

    it('keeps a non-plain data value (array) as a verbatim flat member', () => {
      // When error.data is an array it is not a plain JSON object, so it stays
      // as the 'data' member of the flat record instead of being unwrapped.
      const err = new Error('array') as Error & { data?: unknown; retryable?: boolean };
      err.data = [1];
      err.retryable = true;
      const result = transportErrorData(err);
      expect(result).toEqual({ data: [1], retryable: true });
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

    // ── Hardening: codec-field reservation and __proto__ safety ──────────────

    it('does not clobber Error fields when the data bag contains codec-named keys', () => {
      // A wire bag with message/stack/code must not overwrite the real Error
      // fields set by new Error(transportError.message).
      const wire: BusTransportError = {
        message: 'real message',
        code: 'REAL_CODE',
        data: { message: 'inner', stack: 'forged-stack', code: 'OVERRIDE', ok: 42 },
      };
      const result = deserializeTransportError(wire) as Error & Record<string, unknown>;
      expect(result.message).toBe('real message');
      expect(result.stack).not.toBe('forged-stack');
      // The dedicated top-level codec field wins — a bag 'code' never overwrites it.
      expect(result['code']).toBe('REAL_CODE');
      // Non-codec bag key must still be promoted.
      expect(result['ok']).toBe(42);
    });

    it('fills code and subject from the bag when the top-level codec fields are absent', () => {
      // Compatibility contract: peers historically carried code/subject inside
      // data, and isNoHandlerErrorForSubject depends on them being promoted.
      const wire: BusTransportError = {
        message: 'No handler registered for request subject "dialog.confirm"',
        code: 'NO_HANDLER',
        data: { subject: 'dialog.confirm' },
      };
      const result = deserializeTransportError(wire) as Error & Record<string, unknown>;
      expect(result['code']).toBe('NO_HANDLER');
      expect(result['subject']).toBe('dialog.confirm');
    });

    it('keeps instanceof Error after deserializeTransportError when bag has a __proto__ key (JSON.parse)', () => {
      // JSON.parse produces an object with an own "__proto__" entry; direct
      // property assignment would invoke Object.prototype.__proto__'s setter and
      // break the instanceof chain.
      const transportError = JSON.parse('{"message":"real","data":{"__proto__":{"x":1},"ok":2}}') as BusTransportError;
      const result = deserializeTransportError(transportError);
      expect(result).toBeInstanceOf(Error);
      expect(Object.getPrototypeOf(result)).toBe(Error.prototype);
      expect((result as Error & Record<string, unknown>)['ok']).toBe(2);
      // The __proto__ bag key is dropped, not preserved as an own member — an
      // own enumerable "__proto__" would re-arm the legacy prototype setter at
      // any downstream copy site that uses [[Set]] semantics.
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
      expect(Object.getPrototypeOf(Object.assign({}, result))).toBe(Object.prototype);
    });

    it('transportErrorData parity: raw wire and deserialized path agree, codec-named bag keys excluded from both', () => {
      // A raw BusTransportError whose bag contains a codec-named key ("message").
      // Both the raw-wire path and the post-deserialize path must exclude it.
      const raw = { message: 'err', code: 'EC', data: { message: 'inner', retryable: true } };
      const rawResult = transportErrorData(raw);
      const deserialized = deserializeTransportError(raw as BusTransportError) as Error & Record<string, unknown>;
      const deserializedResult = transportErrorData(deserialized);
      expect(rawResult).not.toHaveProperty('message');
      expect(deserializedResult).not.toHaveProperty('message');
      expect(rawResult).toHaveProperty('retryable', true);
      expect(deserializedResult).toHaveProperty('retryable', true);
    });

    it('transportErrorData: accessor-backed data property does not invoke the getter and does not throw', () => {
      // If `data` is defined via Object.defineProperty with only get/set, reading
      // the descriptor's `.value` field returns undefined — the getter must never run.
      let getterCallCount = 0;
      const obj: Record<string, unknown> = { retryable: true };
      Object.defineProperty(obj, 'data', {
        get(): unknown {
          getterCallCount++;
          throw new Error('getter must not be called');
        },
        enumerable: true,
        configurable: true,
      });
      expect(() => transportErrorData(obj)).not.toThrow();
      expect(getterCallCount).toBe(0);
      // The flat member is still accessible.
      expect(transportErrorData(obj)).toHaveProperty('retryable', true);
    });

    it('raw-wire bag with a __proto__ key does not forge the result prototype and keeps its siblings', () => {
      // The bag-merge path in transportErrorData writes bag entries into a fresh
      // record; a JSON.parse-produced own "__proto__" bag key must not poison
      // that record's prototype or drop sibling members.
      const raw = JSON.parse('{"message":"m","data":{"__proto__":{"x":1},"ok":2}}') as Record<string, unknown>;
      const result = transportErrorData(raw);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('ok', 2);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect((result as Record<string, unknown>)['x']).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    });

    it('collectStructuredProps path: JSON.parse __proto__ member does not forge result prototype', () => {
      // JSON.parse produces an own "__proto__" key on the result object; if
      // collectStructuredProps uses plain assignment, the forged prototype would
      // poison the returned record. defineOwnValue must prevent this.
      const raw = JSON.parse('{"__proto__":{"x":1},"ok":2}') as Record<string, unknown>;
      const result = transportErrorData(raw);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('ok', 2);
      // Prototype chain of the result must not be forged.
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect((result as Record<string, unknown>)['x']).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    });

    it('symmetry: findInErrorChain finds cause data before and after a round-trip', () => {
      // Before round-trip (class instance)
      const causeErr = new Error('cause') as Error & { data?: Record<string, unknown>; cause?: unknown };
      causeErr.data = { severity: 'critical' };
      const wrapperErr = new Error('wrapper') as Error & { cause?: unknown };
      wrapperErr.cause = causeErr;
      const beforeResult = findInErrorChain(wrapperErr, transportErrorData);
      expect(beforeResult).toEqual({ severity: 'critical' });

      // After round-trip (deserialized bag shape): serializeError copies
      // causeErr.data into result.data.data (nested bag), so deserializeTransportError
      // restores .data = { severity: 'critical' } as the bag on the rebuilt error.
      // transportErrorData extracts its members via the merge rule.
      const serialized = serializeError(wrapperErr);
      const deserialized = deserializeTransportError(serialized);
      const afterResult = findInErrorChain(deserialized, transportErrorData);
      expect(afterResult).toBeDefined();
      expect(afterResult).toHaveProperty('severity', 'critical');
    });
  });

  describe('codec unification: serializeTransportError and serializeError', () => {
    it('produce deep-equal wire output for an Error carrying a data bag and a flat member', () => {
      const err = new Error('structured') as Error & { data?: unknown; retryable?: boolean };
      err.data = { items: ['x'] };
      err.retryable = true;

      const wireA = serializeError(err);
      const wireB = serializeTransportError(err);
      expect(wireA).toEqual(wireB);
    });

    it('plain-object input nests data bag at data.data and transportErrorData merges back', () => {
      const input = { message: 'plain', code: 'PC', data: { retryable: true }, extra: 1 };
      const wire = serializeError(input);

      expect(wire.data).toEqual({ data: { retryable: true }, extra: 1 });

      const rebuilt = deserializeTransportError(wire);
      const result = transportErrorData(rebuilt);
      expect(result).toEqual({ retryable: true, extra: 1 });
    });

    it('still produces a payload when the value has no usable string conversion', () => {
      const nullProto = Object.create(null) as Record<string, unknown>;
      nullProto['code'] = 'NP';
      nullProto['retryable'] = false;

      expect(serializeError(nullProto)).toEqual({ message: 'Unknown error', code: 'NP', data: { retryable: false } });
      expect(serializeError({ toString: 0 })).toEqual({ message: 'Unknown error', data: { toString: 0 } });
    });

    it('ignores accessor-backed message, code and subject on a thrown plain object', () => {
      const hostile = { message: 'kept', retryable: true };
      Object.defineProperty(hostile, 'code', {
        enumerable: true,
        get() {
          throw new Error('getter must not run');
        },
      });
      Object.defineProperty(hostile, 'subject', { enumerable: true, get: () => 'accessor' });

      expect(serializeError(hostile)).toEqual({ message: 'kept', data: { retryable: true } });
    });
  });
});
