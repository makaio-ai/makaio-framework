import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HmacAuth } from '@makaio/bus-transport-websocket';
import { HostSubjects } from '@makaio/contracts';
import { connectAndFocus } from '../src/second-instance.js';

/**
 * Constructor-level unit tests for `connectAndFocus` local policy: URL/auth
 * wiring, auth short-circuiting, timeout handling, and cleanup after failed
 * connect/request paths. Keep these mocks scoped to this file; the companion
 * `second-instance.integration.test.ts` imports the real bus and WebSocket
 * transport over a loopback server for end-to-end coverage.
 */
type FocusRequest = (
  subject: typeof HostSubjects.app.focus,
  payload: Record<string, never>,
) => Promise<{ focused: boolean; windowId: number | null }>;

interface MockBus {
  connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  disconnect: ReturnType<typeof vi.fn<() => void>>;
  request: ReturnType<typeof vi.fn<FocusRequest>>;
}

const busCoreMocks = vi.hoisted(() => ({
  createBusInstance: vi.fn(),
}));

const transportMocks = vi.hoisted(() => ({
  WebSocketClientTransport: vi.fn(),
}));

vi.mock('@makaio/bus-core', async () => {
  const actual = await vi.importActual<typeof import('@makaio/bus-core')>('@makaio/bus-core');
  return {
    ...actual,
    createBusInstance: busCoreMocks.createBusInstance,
  };
});

vi.mock('@makaio/bus-transport-websocket', async () => {
  const actual = await vi.importActual<typeof import('@makaio/bus-transport-websocket')>(
    '@makaio/bus-transport-websocket',
  );
  return {
    ...actual,
    WebSocketClientTransport: transportMocks.WebSocketClientTransport,
  };
});

function createMockBus(overrides?: Partial<MockBus>): MockBus {
  return {
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    disconnect: vi.fn<() => void>(),
    request: vi.fn<FocusRequest>().mockResolvedValue({ focused: true, windowId: 1 }),
    ...overrides,
  };
}

describe('connectAndFocus', () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env['MAKAIO_BUS_SECRET'];
    vi.clearAllMocks();
    transportMocks.WebSocketClientTransport.mockImplementation(function MockWebSocketClientTransport(options: unknown) {
      return { options };
    });
  });

  afterEach(() => {
    if (savedSecret === undefined) {
      delete process.env['MAKAIO_BUS_SECRET'];
    } else {
      process.env['MAKAIO_BUS_SECRET'] = savedSecret;
    }
    vi.useRealTimers();
  });

  it('connects without auth, requests app focus, and disconnects', async () => {
    const bus = createMockBus();
    busCoreMocks.createBusInstance.mockReturnValue(bus);

    const focused = await connectAndFocus(7777, { auth: false });

    expect(transportMocks.WebSocketClientTransport).toHaveBeenCalledWith({
      url: 'ws://127.0.0.1:7777/bus',
      name: 'second-instance',
      autoReconnect: false,
      auth: undefined,
    });
    expect(bus.request).toHaveBeenCalledWith(HostSubjects.app.focus, {});
    expect(bus.disconnect).toHaveBeenCalledOnce();
    expect(focused).toBe(true);
  });

  it('returns false without connecting when auth is required but no secret is configured', async () => {
    delete process.env['MAKAIO_BUS_SECRET'];

    const focused = await connectAndFocus(6252, { auth: true });

    expect(focused).toBe(false);
    expect(transportMocks.WebSocketClientTransport).not.toHaveBeenCalled();
    expect(busCoreMocks.createBusInstance).not.toHaveBeenCalled();
  });

  it('passes HMAC auth when health requires auth and a secret is configured', async () => {
    process.env['MAKAIO_BUS_SECRET'] = 'second-instance-secret';
    const bus = createMockBus();
    busCoreMocks.createBusInstance.mockReturnValue(bus);

    await connectAndFocus(6252, { auth: true });

    const options = transportMocks.WebSocketClientTransport.mock.calls[0]?.[0] as { auth?: unknown };
    expect(options.auth).toBeInstanceOf(HmacAuth);
  });

  it('disconnects when the focus request fails', async () => {
    const bus = createMockBus({
      request: vi.fn().mockRejectedValue(new Error('focus failed')),
    });
    busCoreMocks.createBusInstance.mockReturnValue(bus);

    await expect(connectAndFocus(6252, { auth: false })).resolves.toBe(false);

    expect(bus.disconnect).toHaveBeenCalledOnce();
  });

  it('times out a stalled bus connection and disconnects', async () => {
    vi.useFakeTimers();
    const bus = createMockBus({
      connect: vi.fn(() => new Promise<void>(() => undefined)),
    });
    busCoreMocks.createBusInstance.mockReturnValue(bus);

    const focusPromise = connectAndFocus(6252, { auth: false });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(focusPromise).resolves.toBe(false);
    expect(bus.disconnect).toHaveBeenCalledOnce();
  });
});
