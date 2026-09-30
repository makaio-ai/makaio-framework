/**
 * Unit tests for the bus diagnostic sink helpers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatBusDiagnostic, resolveBusDebugLog } from '../debug-log.js';

describe('resolveBusDebugLog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to console.debug, resolved at call time', () => {
    const log = resolveBusDebugLog();
    // Spy installed after resolving: the default must still intercept.
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    log('hello');
    expect(spy).toHaveBeenCalledExactlyOnceWith('hello');
  });

  it('forwards the message to a custom sink and leaves console.debug alone', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const sink = vi.fn();
    resolveBusDebugLog(sink)('custom');
    expect(sink).toHaveBeenCalledExactlyOnceWith('custom');
    expect(spy).not.toHaveBeenCalled();
  });

  it('swallows a synchronously throwing sink', () => {
    const log = resolveBusDebugLog(() => {
      throw new Error('sink exploded');
    });
    expect(() => log('x')).not.toThrow();
  });

  it('swallows a rejecting sink without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const sink = (() => Promise.reject(new Error('async sink exploded'))) as unknown as (message: string) => void;
      expect(() => resolveBusDebugLog(sink)('x')).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('formatBusDiagnostic', () => {
  it('returns the bare message without details', () => {
    expect(formatBusDiagnostic('[Tag] text', {})).toBe('[Tag] text');
  });

  it('flattens details into key=value pairs', () => {
    expect(
      formatBusDiagnostic('[Tag] text', { transport: 'ws', count: 2, list: ['a', 'b'], flag: true, none: null }),
    ).toBe('[Tag] text transport=ws count=2 list=["a","b"] flag=true none=null');
  });

  it('renders errors as Name: message', () => {
    expect(formatBusDiagnostic('m', { error: new TypeError('boom') })).toBe('m error=TypeError: boom');
    expect(formatBusDiagnostic('m', { error: new RangeError('') })).toBe('m error=RangeError');
  });

  it('falls back to String() for circular values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatBusDiagnostic('m', { value: circular })).toBe('m value=[object Object]');
  });

  it('renders undefined without throwing', () => {
    expect(formatBusDiagnostic('m', { value: undefined })).toBe('m value=undefined');
  });

  it('does not throw for a circular object with a null prototype', () => {
    const circular = Object.create(null) as Record<string, unknown>;
    circular.self = circular;
    let line = '';
    expect(() => {
      line = formatBusDiagnostic('m', { value: circular });
    }).not.toThrow();
    expect(line).toBe('m value=[object Object]');
  });

  it('does not throw for an Error whose message getter throws', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('getter exploded');
      },
    });
    let line = '';
    expect(() => {
      line = formatBusDiagnostic('m', { error });
    }).not.toThrow();
    expect(line).toBe('m error=[object Error]');
  });
});
