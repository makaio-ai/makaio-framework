import { describe, expect, it } from 'bun:test';
import { isTextLikeMimeType, normalizeMimeType } from '../normalizeMimeType.js';

describe('normalizeMimeType', () => {
  it('returns application/octet-stream for null', () => {
    expect(normalizeMimeType(null)).toBe('application/octet-stream');
  });

  it('returns application/octet-stream for undefined', () => {
    expect(normalizeMimeType(undefined)).toBe('application/octet-stream');
  });

  it('returns application/octet-stream for empty string', () => {
    expect(normalizeMimeType('')).toBe('application/octet-stream');
  });

  it('lowercases the MIME type', () => {
    expect(normalizeMimeType('IMAGE/PNG')).toBe('image/png');
  });

  it('strips parameters after semicolon', () => {
    expect(normalizeMimeType('text/plain; charset=utf-8')).toBe('text/plain');
  });

  it('strips parameters and lowercases in combination', () => {
    expect(normalizeMimeType('IMAGE/PNG; charset=binary')).toBe('image/png');
  });

  it('trims whitespace from base type', () => {
    expect(normalizeMimeType('  image/jpeg  ')).toBe('image/jpeg');
  });

  it('passes through already-normalized types unchanged', () => {
    expect(normalizeMimeType('application/pdf')).toBe('application/pdf');
  });

  it('returns application/octet-stream for whitespace-only input', () => {
    expect(normalizeMimeType(' ')).toBe('application/octet-stream');
    expect(normalizeMimeType('\t')).toBe('application/octet-stream');
    expect(normalizeMimeType('   ')).toBe('application/octet-stream');
  });
});

describe('isTextLikeMimeType', () => {
  it('returns true for text/* types', () => {
    expect(isTextLikeMimeType('text/plain')).toBe(true);
    expect(isTextLikeMimeType('text/html')).toBe(true);
    expect(isTextLikeMimeType('text/markdown')).toBe(true);
    expect(isTextLikeMimeType('text/csv')).toBe(true);
  });

  it('returns true for known text-like application/* types', () => {
    expect(isTextLikeMimeType('application/json')).toBe(true);
    expect(isTextLikeMimeType('application/xml')).toBe(true);
    expect(isTextLikeMimeType('application/javascript')).toBe(true);
    expect(isTextLikeMimeType('application/typescript')).toBe(true);
    expect(isTextLikeMimeType('application/x-yaml')).toBe(true);
  });

  it('returns false for binary types', () => {
    expect(isTextLikeMimeType('application/octet-stream')).toBe(false);
    expect(isTextLikeMimeType('image/png')).toBe(false);
    expect(isTextLikeMimeType('application/pdf')).toBe(false);
  });

  it('handles null and undefined as non-text (application/octet-stream fallback)', () => {
    expect(isTextLikeMimeType(null)).toBe(false);
    expect(isTextLikeMimeType(undefined)).toBe(false);
  });

  it('normalizes parameters before classification', () => {
    expect(isTextLikeMimeType('text/plain; charset=utf-8')).toBe(true);
    expect(isTextLikeMimeType('TEXT/PLAIN; charset=utf-8')).toBe(true);
  });
});
