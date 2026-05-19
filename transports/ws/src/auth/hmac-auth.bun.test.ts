import { describe, expect, it } from 'bun:test';
import { HmacAuth } from './hmac-auth.js';

describe('HmacAuth client-side message ordering', () => {
  it('uses auth frames that arrive before authenticateClient installs its waits', async () => {
    const auth = new HmacAuth({ secret: 'test-secret', challengeTimeout: 50 });
    const sentMessages: unknown[] = [];

    expect(auth.handleAuthMessage({ type: 'auth-challenge', nonce: 'early-nonce' })).toBe(true);

    await auth.authenticateClient((message: unknown) => {
      sentMessages.push(message);
      expect(auth.handleAuthMessage({ type: 'auth-result', success: true })).toBe(true);
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ type: 'auth-response' });
  });

  it('drops late duplicate auth frames after client authentication completes', async () => {
    const auth = new HmacAuth({ secret: 'test-secret', challengeTimeout: 10 });
    const sentMessages: unknown[] = [];

    expect(auth.handleAuthMessage({ type: 'auth-challenge', nonce: 'first-nonce' })).toBe(true);
    await auth.authenticateClient((message: unknown) => {
      sentMessages.push(message);
      expect(auth.handleAuthMessage({ type: 'auth-result', success: true })).toBe(true);
    });

    expect(auth.handleAuthMessage({ type: 'auth-challenge', nonce: 'late-nonce' })).toBe(true);
    expect(auth.handleAuthMessage({ type: 'auth-result', success: true })).toBe(true);

    await expect(auth.authenticateClient((message: unknown) => sentMessages.push(message))).rejects.toThrow(
      'Authentication challenge timeout',
    );
    expect(sentMessages).toHaveLength(1);
  });

  it('clears queued client auth frames on cleanup', async () => {
    const auth = new HmacAuth({ secret: 'test-secret', challengeTimeout: 10 });
    const sentMessages: unknown[] = [];

    expect(auth.handleAuthMessage({ type: 'auth-challenge', nonce: 'stale-nonce' })).toBe(true);
    auth.cleanup();

    await expect(auth.authenticateClient((message: unknown) => sentMessages.push(message))).rejects.toThrow(
      'Authentication challenge timeout',
    );
    expect(sentMessages).toHaveLength(0);
  });
});
