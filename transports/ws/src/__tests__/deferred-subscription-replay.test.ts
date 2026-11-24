import { describe, expect, it } from 'vitest';
import { createSubscriptionQueue, MAX_QUEUED_SUBSCRIPTION_BYTES } from '../deferred-subscription-replay.js';
import { MockWebSocket } from './test-helpers.js';

describe('subscription queue', () => {
  it('closes the socket at the queued byte limit even without an availability watcher', async () => {
    const socket = new MockWebSocket();
    const closed: { code: number; reason: string }[] = [];
    socket.addEventListener('close', ({ code, reason }) => closed.push({ code, reason }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const enqueue = createSubscriptionQueue(socket, { debug: false }, async () => {
      entered.resolve();
      await release.promise;
    });
    const message = { type: 'unsubscribe', subjects: {} } as const;
    const pending = enqueue(message, MAX_QUEUED_SUBSCRIPTION_BYTES);
    try {
      await entered.promise;
      expect(closed).toEqual([]);
      await enqueue(message, 1);
      expect(closed).toEqual([{ code: 1008, reason: 'Queued subscription frames exceed byte limit' }]);
    } finally {
      release.resolve();
      await pending;
    }
  });
});
