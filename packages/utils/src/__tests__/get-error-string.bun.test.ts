import { describe, expect, it } from 'bun:test';
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
});
