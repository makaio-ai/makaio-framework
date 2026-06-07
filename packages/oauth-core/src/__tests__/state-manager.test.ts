import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OAuthStateManager, safeEqualHex } from '../state-manager.js';

describe('OAuthStateManager', () => {
  it('rejects empty and whitespace-only HMAC secrets', () => {
    expect(() => new OAuthStateManager('')).toThrow('OAuthStateManager requires a non-empty HMAC secret');
    expect(() => new OAuthStateManager('   ')).toThrow('OAuthStateManager requires a non-empty HMAC secret');
  });

  it('rejects non-positive or non-finite TTL values', () => {
    for (const ttlMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => new OAuthStateManager('secret-one', ttlMs)).toThrow(
        'OAuthStateManager requires ttlMs to be a positive finite number',
      );
    }
  });

  it('normalizes HMAC secrets before signing tokens', () => {
    const manager = new OAuthStateManager<{ readonly redirectUri: string }>(' secret-one ');
    const token = manager.create({ redirectUri: '/dashboard/' });
    const [stateId, signature] = token.split('.');

    expect(signature).toBe(
      createHmac('sha256', 'secret-one')
        .update(stateId ?? '')
        .digest('hex'),
    );
    expect(manager.consume(token)).toEqual({ redirectUri: '/dashboard/' });
  });

  it('creates signed single-use state tokens', () => {
    const manager = new OAuthStateManager<{ readonly redirectUri: string }>('secret-one');
    const token = manager.create({ redirectUri: '/dashboard/' });

    expect(manager.pendingCount).toBe(1);
    expect(manager.consume(token)).toEqual({ redirectUri: '/dashboard/' });
    expect(manager.consume(token)).toBeNull();
    expect(manager.pendingCount).toBe(0);
  });

  it('preserves caller-owned createdAt payload fields', () => {
    const manager = new OAuthStateManager<{ readonly createdAt: string; readonly redirectUri: string }>('secret-one');
    const token = manager.create({ createdAt: 'caller-created-at', redirectUri: '/dashboard/' });

    expect(manager.consume(token)).toEqual({ createdAt: 'caller-created-at', redirectUri: '/dashboard/' });
  });

  it('snapshots state payload values when creating tokens', () => {
    const manager = new OAuthStateManager<{ redirectUri: string }>('secret-one');
    const state = { redirectUri: '/dashboard/' };
    const token = manager.create(state);
    state.redirectUri = '/mutated/';

    expect(manager.consume(token)).toEqual({ redirectUri: '/dashboard/' });
  });

  it('rejects tokens signed with a different secret', () => {
    const manager = new OAuthStateManager<{ readonly redirectUri: string }>('secret-one');
    const attacker = new OAuthStateManager<{ readonly redirectUri: string }>('secret-two');

    expect(manager.consume(attacker.create({ redirectUri: '/dashboard/' }))).toBeNull();
  });

  it('rejects malformed tokens and empty token parts', () => {
    const manager = new OAuthStateManager<{ readonly redirectUri: string }>('secret-one');

    expect(manager.consume('not-a-token')).toBeNull();
    expect(manager.consume('.signature')).toBeNull();
    expect(manager.consume('stateId.')).toBeNull();
    expect(manager.consume('stateId.signature.extra')).toBeNull();
  });

  it('expires stale states', () => {
    vi.useFakeTimers();
    try {
      const manager = new OAuthStateManager<{ readonly redirectUri: string }>('secret-one', 1000);
      const token = manager.create({ redirectUri: '/dashboard/' });
      vi.advanceTimersByTime(1001);

      expect(manager.consume(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleanup removes expired tokens without consuming them', () => {
    vi.useFakeTimers();
    try {
      const manager = new OAuthStateManager<{ readonly redirectUri: string }>('secret', 1000);
      manager.create({ redirectUri: '/a' });
      manager.create({ redirectUri: '/b' });
      expect(manager.pendingCount).toBe(2);
      vi.advanceTimersByTime(1001);
      manager.cleanup();
      expect(manager.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('safeEqualHex', () => {
  it('rejects malformed and short hex inputs without throwing', () => {
    expect(safeEqualHex('', '')).toBe(false);
    expect(safeEqualHex('f', 'f')).toBe(false);
    expect(safeEqualHex('zz', 'zz')).toBe(false);
    expect(safeEqualHex('abcd', 'ab')).toBe(false);
  });

  it('compares valid equal-length hex strings safely', () => {
    expect(safeEqualHex('abcd', 'abcd')).toBe(true);
    expect(safeEqualHex('abcd', 'abce')).toBe(false);
  });
});
