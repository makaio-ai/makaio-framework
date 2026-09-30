import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawInboundHookPayload } from '../schemas.js';

const fakeBus = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  disconnect: vi.fn<() => Promise<void>>(),
  emit: vi.fn<() => Promise<void>>(),
}));

vi.mock('@makaio/bus-core', () => ({
  createBusInstance: () => fakeBus,
}));

vi.mock('@makaio/bus-transport-websocket', () => ({
  HmacAuth: class HmacAuth {
    public constructor(_options: { readonly secret: string }) {}
  },
  WebSocketClientTransport: class WebSocketClientTransport {
    public constructor(_options: Record<string, unknown>) {}
  },
}));

const payload: RawInboundHookPayload = {
  eventName: 'post-commit',
  receivedAt: 1,
  argv: [],
  stdinText: '',
  payload: {},
};

describe('emitInboundHookReceivedFast', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('fails open when the bus connection exceeds the delivery budget', async () => {
    vi.useFakeTimers();
    fakeBus.connect.mockReturnValue(new Promise(() => {}));
    fakeBus.disconnect.mockResolvedValue(undefined);

    const { emitInboundHookReceivedFast } = await import('../fast-bus.js');
    const delivery = emitInboundHookReceivedFast('git', payload, { timeoutMs: 25 });

    await vi.advanceTimersByTimeAsync(25);

    await expect(delivery).resolves.toBeUndefined();
    expect(fakeBus.disconnect).toHaveBeenCalledTimes(1);
  });

  it('fails open when emit exceeds the delivery budget', async () => {
    vi.useFakeTimers();
    fakeBus.connect.mockResolvedValue(undefined);
    fakeBus.emit.mockReturnValue(new Promise(() => {}));
    fakeBus.disconnect.mockResolvedValue(undefined);

    const { emitInboundHookReceivedFast } = await import('../fast-bus.js');
    const delivery = emitInboundHookReceivedFast('git', payload, { timeoutMs: 25 });

    await vi.advanceTimersByTimeAsync(25);

    await expect(delivery).resolves.toBeUndefined();
    expect(fakeBus.emit).toHaveBeenCalledTimes(1);
    expect(fakeBus.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not wait for slow disconnect after successful emit', async () => {
    vi.useFakeTimers();
    fakeBus.connect.mockResolvedValue(undefined);
    fakeBus.emit.mockResolvedValue(undefined);
    fakeBus.disconnect.mockReturnValue(new Promise(() => {}));

    const { emitInboundHookReceivedFast } = await import('../fast-bus.js');
    const delivery = emitInboundHookReceivedFast('git', payload, { timeoutMs: 25 });

    await vi.advanceTimersByTimeAsync(25);

    await expect(delivery).resolves.toBeUndefined();
    expect(fakeBus.disconnect).toHaveBeenCalledTimes(1);
  });

  describe('wall-clock jumps', () => {
    // Fake only setTimeout/clearTimeout/Date; performance.now is spied so monotonic time is controlled independently of Date.
    const useJumpableClocks = (): { advanceMonotonic: (ms: number) => void } => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let monotonicMs = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs);
      return {
        advanceMonotonic: (ms) => {
          monotonicMs += ms;
        },
      };
    };

    it('does not cut the emit budget when the wall clock jumps forward during connect', async () => {
      const clocks = useJumpableClocks();
      let resolveConnect: () => void = () => {};
      fakeBus.connect.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
      );
      fakeBus.emit.mockReturnValue(new Promise<void>((resolve) => setTimeout(resolve, 10)));
      fakeBus.disconnect.mockResolvedValue(undefined);

      const { emitInboundHookReceivedFast } = await import('../fast-bus.js');
      const delivery = emitInboundHookReceivedFast('git', payload, { timeoutMs: 100 });

      clocks.advanceMonotonic(20);
      vi.setSystemTime(Date.now() + 60_000);
      resolveConnect();
      await vi.advanceTimersByTimeAsync(5);

      // Emit still has 80 ms of monotonic budget left, so the bus must still be connected.
      expect(fakeBus.emit).toHaveBeenCalledTimes(1);
      expect(fakeBus.disconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
      await expect(delivery).resolves.toBeUndefined();
      expect(fakeBus.disconnect).toHaveBeenCalledTimes(1);
    });

    it('does not extend the whole-operation budget when the wall clock jumps backward', async () => {
      const clocks = useJumpableClocks();
      let resolveConnect: () => void = () => {};
      fakeBus.connect.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
      );
      fakeBus.emit.mockReturnValue(new Promise(() => {}));
      fakeBus.disconnect.mockResolvedValue(undefined);

      const { emitInboundHookReceivedFast } = await import('../fast-bus.js');
      let settled = false;
      const delivery = emitInboundHookReceivedFast('git', payload, { timeoutMs: 100 }).then(() => {
        settled = true;
      });

      clocks.advanceMonotonic(40);
      vi.setSystemTime(Date.now() - 60_000);
      resolveConnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeBus.emit).toHaveBeenCalledTimes(1);

      // 60 ms of monotonic budget remained after connect; the hung emit must give up then.
      await vi.advanceTimersByTimeAsync(60);

      expect(settled).toBe(true);
      await delivery;
      expect(fakeBus.disconnect).toHaveBeenCalledTimes(1);
    });
  });
});
