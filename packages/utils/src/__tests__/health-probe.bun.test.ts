import { describe, expect, it } from 'bun:test';
import { parseHealthBody, probeHealth } from '../health-probe.js';

describe('parseHealthBody', () => {
  it('returns { auth: false } for literal "ok" (case-insensitive)', () => {
    expect(parseHealthBody('ok')).toEqual({ auth: false });
    expect(parseHealthBody('OK')).toEqual({ auth: false });
    expect(parseHealthBody('  ok  ')).toEqual({ auth: false });
  });

  it('returns { auth: false } for JSON ok:true without auth field', () => {
    expect(parseHealthBody('{"ok":true}')).toEqual({ auth: false });
  });

  it('returns { auth: true } for JSON ok:true with auth:true', () => {
    expect(parseHealthBody('{"ok":true,"auth":true}')).toEqual({ auth: true });
  });

  it('returns null for JSON ok:false', () => {
    expect(parseHealthBody('{"ok":false}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseHealthBody('{invalid}')).toBeNull();
    expect(parseHealthBody('not-json')).toBeNull();
  });

  it('accepts JSON-string "ok" responses from JSON-serialized desktop health callbacks', () => {
    expect(parseHealthBody('"ok"')).toEqual({ auth: false });
  });

  it('returns null for empty or whitespace-only body', () => {
    expect(parseHealthBody('')).toBeNull();
    expect(parseHealthBody('   ')).toBeNull();
  });
});

describe('probeHealth', () => {
  it('returns null when no server is running at the given URL', async () => {
    const result = await probeHealth('http://127.0.0.1:59999/health');
    expect(result).toBeNull();
  });
});
