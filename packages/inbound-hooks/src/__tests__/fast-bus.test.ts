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
});
