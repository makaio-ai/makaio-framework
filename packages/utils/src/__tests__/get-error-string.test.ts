import { describe, expect, it } from 'vitest';
import { getErrorString } from '../getErrorString.js';

describe('getErrorString', () => {
  it('returns the message from an Error instance', () => {
    expect(getErrorString(new Error('something went wrong'))).toBe('something went wrong');
  });

  it('returns the string directly when given a string', () => {
    expect(getErrorString('plain string error')).toBe('plain string error');
  });

  it('returns "Unknown error" when given undefined', () => {
    expect(getErrorString(undefined)).toBe('Unknown error');
  });

  it('returns "Unknown error" when given an empty string', () => {
    // empty string is falsy, falls into the !error branch
    expect(getErrorString('')).toBe('Unknown error');
  });

  it('returns "Unknown error" when given an Error with an empty message', () => {
    expect(getErrorString(new Error(''))).toBe('Unknown error');
  });

  it('returns "Unknown error" for an Error whose message is empty', () => {
    const err = new Error('temp');
    // Force message to empty to exercise the fallback
    Object.defineProperty(err, 'message', { value: '', configurable: true });
    expect(getErrorString(err)).toBe('Unknown error');
  });

  it('coerces a runtime-mutated non-string Error message', () => {
    const err = new Error('temp');
    Object.defineProperty(err, 'message', { value: 503, configurable: true });
    expect(getErrorString(err)).toBe('503');
  });

  it('describes a non-Error thrown value by coercing it', () => {
    expect(getErrorString({ status: 503 })).toBe('[object Object]');
    expect(getErrorString(404)).toBe('404');
    expect(getErrorString(Symbol('boom'))).toBe('Symbol(boom)');
  });

  it('returns "Unknown error" for falsy non-string values', () => {
    expect(getErrorString(null)).toBe('Unknown error');
    expect(getErrorString(0)).toBe('Unknown error');
    expect(getErrorString(false)).toBe('Unknown error');
  });

  it('never lets a hostile value throw out of the describing helper', () => {
    // A `catch` binding can hold anything, including values whose coercion
    // throws. Describing the failure must not become a second failure.
    const nullPrototype: unknown = Object.create(null);
    const hostileToString = {
      toString() {
        throw new Error('refused');
      },
    };
    const revokedProxy = Proxy.revocable({}, {});
    revokedProxy.revoke();

    expect(getErrorString(nullPrototype)).toBe('Unknown error');
    expect(getErrorString(hostileToString)).toBe('Unknown error');
    expect(getErrorString(revokedProxy.proxy)).toBe('Unknown error');
  });
});
