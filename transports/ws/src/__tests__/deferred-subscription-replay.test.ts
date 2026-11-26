import { describe, expect, it } from 'vitest';
import {
  createInboundQueue,
  DeferredSubscriptionReplay,
  MAX_QUEUED_SUBSCRIPTION_BYTES,
} from '../deferred-subscription-replay.js';
import { MockWebSocket } from './test-helpers.js';

describe('subscription queue', () => {
  it('closes the socket at the queued byte limit even without an availability watcher', async () => {
    const socket = new MockWebSocket();
    const closed: { code: number; reason: string }[] = [];
    socket.addEventListener('close', ({ code, reason }) => closed.push({ code, reason }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { enqueue } = createInboundQueue(
      socket,
      { debug: false },
      new DeferredSubscriptionReplay(socket),
      async () => undefined,
    );
    const pending = enqueue(
      async () => {
        entered.resolve();
        await release.promise;
      },
      { bytes: MAX_QUEUED_SUBSCRIPTION_BYTES, subscriptionBytes: MAX_QUEUED_SUBSCRIPTION_BYTES },
      () => expect.unreachable(),
    );
    try {
      await entered.promise;
      expect(closed).toEqual([]);
      await enqueue(
        async () => expect.unreachable(),
        { bytes: 1, subscriptionBytes: 1 },
        () => socket.close(1008, 'Queued subscription frames exceed byte limit'),
      );
      expect(closed).toEqual([{ code: 1008, reason: 'Queued subscription frames exceed byte limit' }]);
    } finally {
      release.resolve();
      await pending;
    }
  });
});
