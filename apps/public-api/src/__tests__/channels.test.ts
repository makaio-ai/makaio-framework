import { describe, it, expect } from 'vitest';
import { parseChannel, isUpdateJson } from '../releases/channels.js';

describe('parseChannel', () => {
  it('extracts stable channel from artifact filename', () => {
    expect(parseChannel('stable-macos-arm64-update.json')).toBe('stable');
  });

  it('extracts canary channel', () => {
    expect(parseChannel('canary-macos-arm64-update.json')).toBe('canary');
  });

  it('extracts cef channel', () => {
    expect(parseChannel('cef-macos-arm64-Makaio-cef.app.tar.zst')).toBe('cef');
  });

  it('extracts cef-canary channel (not mismatched as cef)', () => {
    expect(parseChannel('cef-canary-macos-arm64-update.json')).toBe('cef-canary');
  });

  it('returns null for unknown channel prefix', () => {
    expect(parseChannel('nightly-macos-arm64-update.json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseChannel('')).toBeNull();
  });

  it('does not match partial prefix', () => {
    expect(parseChannel('stableish-macos-arm64-update.json')).toBeNull();
  });
});

describe('isUpdateJson', () => {
  it('returns true for update.json files', () => {
    expect(isUpdateJson('stable-macos-arm64-update.json')).toBe(true);
  });

  it('returns false for tar.zst files', () => {
    expect(isUpdateJson('stable-macos-arm64-Makaio.app.tar.zst')).toBe(false);
  });

  it('returns false for dmg files', () => {
    expect(isUpdateJson('stable-macos-arm64-Makaio.dmg')).toBe(false);
  });

  it('returns false for patch files', () => {
    expect(isUpdateJson('stable-macos-arm64-abc123.patch')).toBe(false);
  });
});
