import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFastHookBus, DEFAULT_FAST_HOOK_BUS_URL } from '../fast-connection.js';

const mocks = vi.hoisted(() => ({
  bus: {
    connect: vi.fn<() => Promise<void>>(),
    disconnect: vi.fn<() => unknown>(),
  },
  createBusInstance: vi.fn<(options: Record<string, unknown>) => unknown>(),
  transportError: undefined as Error | undefined,
  transports: [] as Record<string, unknown>[],
  auths: [] as { readonly secret: string }[],
}));

vi.mock('@makaio/bus-core', () => ({
  createBusInstance: (options: Record<string, unknown>) => mocks.createBusInstance(options),
}));

vi.mock('@makaio/bus-transport-websocket', () => ({
  HmacAuth: class HmacAuth {
    public constructor(options: { readonly secret: string }) {
      mocks.auths.push(options);
    }
  },
  WebSocketClientTransport: class WebSocketClientTransport {
    public constructor(options: Record<string, unknown>) {
      if (mocks.transportError) throw mocks.transportError;
      mocks.transports.push(options);
    }
  },
}));

describe('connectFastHookBus', () => {
  beforeEach(() => {
    mocks.transports.length = 0;
    mocks.auths.length = 0;
    mocks.transportError = undefined;
    mocks.createBusInstance.mockReturnValue(mocks.bus);
    mocks.bus.connect.mockResolvedValue(undefined);
    mocks.bus.disconnect.mockResolvedValue(undefined);
    vi.stubEnv('MAKAIO_BUS_URL', '');
    vi.stubEnv('MAKAIO_BUS_SECRET', '');
    vi.stubEnv('MAKAIO_DEBUG', '');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it('resolves a connection and builds the transport without auto-reconnect', async () => {
    const connection = await connectFastHookBus({ name: 'hook-git' });

    expect(connection).not.toBeNull();
    expect(connection?.bus).toBe(mocks.bus);
    expect(typeof connection?.dispose).toBe('function');
    expect(mocks.transports).toHaveLength(1);
    expect(mocks.transports[0]).toMatchObject({ name: 'hook-git', autoReconnect: false });
    expect(mocks.bus.disconnect).not.toHaveBeenCalled();
  });

  describe('URL and secret resolution', () => {
    it('prefers the explicit URL over the environment', async () => {
      vi.stubEnv('MAKAIO_BUS_URL', 'ws://env.invalid/bus');
      await connectFastHookBus({ name: 'n', busUrl: 'ws://explicit.invalid/bus' });
      expect(mocks.transports[0]?.['url']).toBe('ws://explicit.invalid/bus');
    });

    it('falls back to MAKAIO_BUS_URL', async () => {
      vi.stubEnv('MAKAIO_BUS_URL', 'ws://env.invalid/bus');
      await connectFastHookBus({ name: 'n' });
      expect(mocks.transports[0]?.['url']).toBe('ws://env.invalid/bus');
    });

    it('falls back to the default URL when option and env are blank', async () => {
      await connectFastHookBus({ name: 'n', busUrl: '   ' });
      expect(mocks.transports[0]?.['url']).toBe(DEFAULT_FAST_HOOK_BUS_URL);
    });

    it('prefers the explicit secret over the environment', async () => {
      vi.stubEnv('MAKAIO_BUS_SECRET', 'env-secret');
      await connectFastHookBus({ name: 'n', secret: 'explicit-secret' });
      expect(mocks.auths).toEqual([{ secret: 'explicit-secret' }]);
      expect(mocks.transports[0]?.['auth']).toBeDefined();
    });

    it('falls back to MAKAIO_BUS_SECRET', async () => {
      vi.stubEnv('MAKAIO_BUS_SECRET', 'env-secret');
      await connectFastHookBus({ name: 'n' });
      expect(mocks.auths).toEqual([{ secret: 'env-secret' }]);
    });

    it('uses no auth for a blank secret', async () => {
      vi.stubEnv('MAKAIO_BUS_SECRET', 'env-secret');
      await connectFastHookBus({ name: 'n', secret: '  ' });
      expect(mocks.auths).toHaveLength(0);
      expect(mocks.transports[0]?.['auth']).toBeUndefined();
    });

    it('uses no auth when no secret is configured', async () => {
      await connectFastHookBus({ name: 'n' });
      expect(mocks.auths).toHaveLength(0);
      expect(mocks.transports[0]?.['auth']).toBeUndefined();
    });
  });

  describe('debug resolution', () => {
    it('enables transport debug for debug: true without MAKAIO_DEBUG', async () => {
      await connectFastHookBus({ name: 'n', debug: true });
      expect(mocks.transports[0]?.['debug']).toBe(true);
    });

    it('lets an explicit debug: false win over MAKAIO_DEBUG', async () => {
      vi.stubEnv('MAKAIO_DEBUG', 'true');
      await connectFastHookBus({ name: 'n', debug: false });
      expect(mocks.transports[0]?.['debug']).toBe(false);
    });

    it('falls back to MAKAIO_DEBUG when the option is omitted', async () => {
      vi.stubEnv('MAKAIO_DEBUG', 'true');
      await connectFastHookBus({ name: 'n' });
      expect(mocks.transports[0]?.['debug']).toBe(true);
    });

    it('routes transport debug lines to stderr, never stdout', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await connectFastHookBus({ name: 'n', debug: true });
        const debugLog = mocks.transports[0]?.['debugLog'] as ((message: string) => void) | undefined;
        expect(debugLog).toBeTypeOf('function');

        debugLog?.('[WebSocketClientTransport:n] Connected');

        expect(stderrSpy).toHaveBeenCalledWith('[WebSocketClientTransport:n] Connected\n');
        expect(stdoutSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
      }
    });
  });

  describe('bus diagnostics channel', () => {
    it.each([
      ['with MAKAIO_DEBUG=true', 'true'],
      ['without MAKAIO_DEBUG', ''],
    ])('gives the bus a debugLog that writes to stderr, never stdout %s', async (_label, envValue) => {
      vi.stubEnv('MAKAIO_DEBUG', envValue);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await connectFastHookBus({ name: 'n' });
        const busOptions = mocks.createBusInstance.mock.calls[0]?.[0];
        const debugLog = busOptions?.['debugLog'] as ((message: string) => void) | undefined;
        expect(debugLog).toBeTypeOf('function');

        debugLog?.('[bus] bus-marker');

        expect(stderrSpy).toHaveBeenCalledWith('[bus] bus-marker\n');
        expect(stdoutSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
      }
    });
  });

  describe('failure handling', () => {
    it('resolves null without rejecting when createBusInstance throws', async () => {
      mocks.createBusInstance.mockImplementation(() => {
        throw new Error('bus construction failed');
      });

      await expect(connectFastHookBus({ name: 'n' })).resolves.toBeNull();
      expect(mocks.bus.connect).not.toHaveBeenCalled();
    });

    it('resolves null without rejecting when the transport constructor throws', async () => {
      mocks.transportError = new Error('transport construction failed');

      await expect(connectFastHookBus({ name: 'n' })).resolves.toBeNull();
      expect(mocks.createBusInstance).not.toHaveBeenCalled();
      expect(mocks.bus.connect).not.toHaveBeenCalled();
    });

    it('resolves null and disconnects when connect rejects', async () => {
      mocks.bus.connect.mockRejectedValue(new Error('refused'));

      await expect(connectFastHookBus({ name: 'n' })).resolves.toBeNull();
      expect(mocks.bus.disconnect).toHaveBeenCalledTimes(1);
    });

    it('resolves null and disconnects when connect exceeds the deadline', async () => {
      vi.useFakeTimers();
      mocks.bus.connect.mockReturnValue(new Promise(() => {}));

      const pending = connectFastHookBus({ name: 'n', timeoutMs: 25 });
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toBeNull();
      expect(mocks.bus.disconnect).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['negative', -5],
      ['NaN', Number.NaN],
    ])('falls back to the 250 ms default for a %s timeout', async (_label, timeoutMs) => {
      vi.useFakeTimers();
      mocks.bus.connect.mockReturnValue(new Promise(() => {}));
      let settled = false;

      const pending = connectFastHookBus({ name: 'n', timeoutMs }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeNull();
    });
  });

  describe('dispose', () => {
    it('disconnects the bus', async () => {
      const connection = await connectFastHookBus({ name: 'n' });
      connection?.dispose();
      expect(mocks.bus.disconnect).toHaveBeenCalledTimes(1);
    });

    it('does not throw when disconnect throws synchronously', async () => {
      const connection = await connectFastHookBus({ name: 'n' });
      mocks.bus.disconnect.mockImplementation(() => {
        throw new Error('boom');
      });

      expect(() => connection?.dispose()).not.toThrow();
      expect(mocks.bus.disconnect).toHaveBeenCalledTimes(1);
    });
  });
});
