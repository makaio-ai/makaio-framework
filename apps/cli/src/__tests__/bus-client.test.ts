/**
 * Unit tests for the pure helpers in `bus-client`.
 *
 * These helpers derive health/auth behavior without establishing any real
 * WebSocket connections.
 */
import type { BusMessage, BusTransport, IMakaioBus } from '@makaio/bus-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HmacAuth } from '@makaio/bus-transport-websocket';
import {
  connectBusClient,
  deriveHealthUrl,
  isRemoteBusUrl,
  probeHealth,
  resolveBusUrl,
  resolveClientAuth,
} from '../bus-client.js';

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

type AnyListener = (context: { subject: string; payload: unknown }) => void;
type CapturedOptions = { debug?: boolean; debugLog?: (message: string) => void };

/**
 * Collect the string chunks written to a stream spy that carry a marker.
 * @param spy - Spy on a stream's `write`.
 * @param marker - Substring identifying the lines under test.
 * @returns The matching chunks, stringified.
 */
function writesContaining(spy: { mock: { calls: unknown[][] } }, marker: string): string[] {
  return spy.mock.calls.map(([chunk]) => String(chunk)).filter((chunk) => chunk.includes(marker));
}

describe('deriveHealthUrl', () => {
  it('replaces a /bus suffix with /health', () => {
    expect(deriveHealthUrl('ws://127.0.0.1:6252/bus')).toBe('http://127.0.0.1:6252/health');
  });

  it('replaces a /bus/ suffix with /health', () => {
    expect(deriveHealthUrl('ws://127.0.0.1:6252/bus/')).toBe('http://127.0.0.1:6252/health');
  });

  it('appends /health when the URL has no /bus suffix', () => {
    expect(deriveHealthUrl('ws://127.0.0.1:6252')).toBe('http://127.0.0.1:6252/health');
  });
});

describe('resolveClientAuth', () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env['MAKAIO_BUS_SECRET'];
  });

  afterEach(() => {
    if (savedSecret === undefined) {
      delete process.env['MAKAIO_BUS_SECRET'];
    } else {
      process.env['MAKAIO_BUS_SECRET'] = savedSecret;
    }
  });

  it('returns undefined when auth is not required', () => {
    const result = resolveClientAuth({ auth: false });
    expect(result).toBeUndefined();
  });

  it('returns an HmacAuth instance when auth is required and the secret is set', () => {
    process.env['MAKAIO_BUS_SECRET'] = 'test-secret-value';

    const result = resolveClientAuth({ auth: true });

    expect(result).toBeDefined();
    expect(result).toBeInstanceOf(HmacAuth);
  });

  it('throws when auth is required but MAKAIO_BUS_SECRET is unset', () => {
    delete process.env['MAKAIO_BUS_SECRET'];

    expect(() => resolveClientAuth({ auth: true })).toThrow(
      'Server requires authentication. Set MAKAIO_BUS_SECRET to connect.',
    );
  });

  it('throws when auth is required and MAKAIO_BUS_SECRET is an empty string', () => {
    process.env['MAKAIO_BUS_SECRET'] = '';

    // normalizeBusSecret throws on empty strings (set but empty = misconfiguration)
    expect(() => resolveClientAuth({ auth: true })).toThrow(
      'MAKAIO_BUS_SECRET is set but empty after trimming; refusing to use an empty secret',
    );
  });
});

describe('resolveBusUrl', () => {
  const savedBusUrl = process.env.MAKAIO_BUS_URL;

  afterEach(() => {
    if (savedBusUrl === undefined) {
      delete process.env.MAKAIO_BUS_URL;
    } else {
      process.env.MAKAIO_BUS_URL = savedBusUrl;
    }
  });

  it('falls back to the default when override and env are blank', () => {
    process.env.MAKAIO_BUS_URL = '   ';

    expect(resolveBusUrl('  ')).toBe('ws://127.0.0.1:6252/bus');
  });

  it('trims an explicit override before using it', () => {
    process.env.MAKAIO_BUS_URL = 'ws://env-host:6252/bus';

    expect(resolveBusUrl('  ws://override-host:6252/bus  ')).toBe('ws://override-host:6252/bus');
  });

  it('uses the trimmed env value when no explicit override is provided', () => {
    process.env.MAKAIO_BUS_URL = '  ws://env-host:6252/bus  ';

    expect(resolveBusUrl()).toBe('ws://env-host:6252/bus');
  });
});

describe('isRemoteBusUrl', () => {
  it.each([
    'ws://localhost:6252/bus',
    'ws://127.0.0.1:6252/bus',
    'ws://[::1]:6252/bus',
  ])('treats %s as local', (busUrl) => {
    expect(isRemoteBusUrl(busUrl)).toBe(false);
  });

  it.each([
    'ws://build-server.internal:6252/bus',
    'wss://example.com/bus',
    'ws://192.168.1.5:6252/bus',
  ])('treats %s as remote', (busUrl) => {
    expect(isRemoteBusUrl(busUrl)).toBe(true);
  });

  it('treats an unparseable URL as remote, never as a local fallback', () => {
    expect(isRemoteBusUrl('not a url')).toBe(true);
  });
});

describe('probeHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts legacy plain-text health responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    );

    await expect(probeHealth('ws://127.0.0.1:6252/bus')).resolves.toEqual({ auth: false });
  });

  it('accepts JSON health responses with auth metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, auth: true }), { status: 200 })),
    );

    await expect(probeHealth('ws://127.0.0.1:6252/bus')).resolves.toEqual({ auth: true });
  });

  it('returns null when JSON health omits ok=true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ auth: true }), { status: 200 })),
    );

    await expect(probeHealth('ws://127.0.0.1:6252/bus')).resolves.toBeNull();
  });

  it('returns null when the health response body is unrecognized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('maybe', { status: 200 })),
    );

    await expect(probeHealth('ws://127.0.0.1:6252/bus')).resolves.toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(probeHealth('ws://127.0.0.1:6252/bus')).resolves.toBeNull();
  });

  it('returns null when the health response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Internal Server Error', { status: 500 })),
    );

    await expect(probeHealth('ws://127.0.0.1:6252/bus')).resolves.toBeNull();
  });
});

describe('connectBusClient', () => {
  const savedBusUrl = process.env.MAKAIO_BUS_URL;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (savedBusUrl === undefined) {
      delete process.env.MAKAIO_BUS_URL;
    } else {
      process.env.MAKAIO_BUS_URL = savedBusUrl;
    }
  });

  it('preserves auth failures instead of masking them as server-down errors', async () => {
    const transport = {};
    const bus = {
      connect: vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' }),
      disconnect: vi.fn(),
    } as Pick<IMakaioBus, 'connect' | 'disconnect'> as IMakaioBus;

    transportMocks.WebSocketClientTransport.mockImplementation(function MockTransport() {
      return transport;
    });
    busCoreMocks.createBusInstance.mockReturnValue(bus);

    const rejection = connectBusClient('ws://127.0.0.1:6252/bus');

    await expect(rejection).rejects.toThrow('Failed to authenticate with Makaio bus.');
    await expect(rejection).rejects.not.toThrow('Makaio is not running.');
    expect(bus.disconnect).toHaveBeenCalled();
  });

  it('uses the server-down message for non-auth connection failures', async () => {
    const transport = {};
    const connectionError = new Error('ECONNREFUSED');
    const bus = {
      connect: vi.fn().mockRejectedValue(connectionError),
      disconnect: vi.fn(),
    } as Pick<IMakaioBus, 'connect' | 'disconnect'> as IMakaioBus;

    transportMocks.WebSocketClientTransport.mockImplementation(function MockTransport() {
      return transport;
    });
    busCoreMocks.createBusInstance.mockReturnValue(bus);

    const rejection = connectBusClient('ws://127.0.0.1:6252/bus');

    await expect(rejection).rejects.toThrow('Could not connect to Makaio.');
    await expect(rejection).rejects.toMatchObject({
      cause: connectionError,
    });
    expect(bus.disconnect).toHaveBeenCalled();
  });

  it('normalizes a blank env URL before constructing the transport', async () => {
    process.env.MAKAIO_BUS_URL = '   ';
    const transport = {};
    const bus = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    } as Pick<IMakaioBus, 'connect' | 'disconnect'> as IMakaioBus;

    transportMocks.WebSocketClientTransport.mockImplementation(function MockTransport() {
      return transport;
    });
    busCoreMocks.createBusInstance.mockReturnValue(bus);

    await connectBusClient();

    expect(transportMocks.WebSocketClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'ws://127.0.0.1:6252/bus',
      }),
    );
  });
});

describe('connectBusClient debug output channel', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;
  let onAny: ReturnType<typeof vi.fn>;

  /**
   * Connect with minimal fakes for transport and bus.
   */
  async function connectWithFakes(): Promise<void> {
    transportMocks.WebSocketClientTransport.mockImplementation(function MockTransport() {
      return {};
    });
    busCoreMocks.createBusInstance.mockReturnValue({
      __onAny: onAny,
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    });
    await connectBusClient('ws://127.0.0.1:6252/bus');
  }

  const transportOptions = (): CapturedOptions | undefined =>
    transportMocks.WebSocketClientTransport.mock.calls[0]?.[0];
  const busOptions = (): CapturedOptions | undefined => busCoreMocks.createBusInstance.mock.calls[0]?.[0];
  const anyListener = (): AnyListener | undefined => onAny.mock.calls[0]?.[0];

  beforeEach(() => {
    vi.clearAllMocks();
    onAny = vi.fn();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  it('passes a transport debugLog that writes to stderr and not stdout', async () => {
    vi.stubEnv('MAKAIO_DEBUG', 'true');
    await connectWithFakes();

    expect(transportOptions()?.debug).toBe(true);
    transportOptions()?.debugLog?.('[ws-client] transport-marker');

    expect(writesContaining(stderrSpy, '[ws-client] transport-marker')).toEqual(['[ws-client] transport-marker\n']);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('writes the __onAny bus trace to stderr, not stdout or console.debug', async () => {
    vi.stubEnv('MAKAIO_DEBUG', 'true');
    await connectWithFakes();

    anyListener()?.({ subject: 'test.subject', payload: { a: 1 } });

    expect(writesContaining(stderrSpy, '[bus-client]')).toEqual([
      '[bus-client] subject: test.subject, payload: {"a":1}\n',
    ]);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(consoleDebugSpy).not.toHaveBeenCalled();
  });

  it('marks unserializable payloads instead of throwing', async () => {
    vi.stubEnv('MAKAIO_DEBUG', 'true');
    await connectWithFakes();

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    anyListener()?.({ subject: 'test.circular', payload: circular });

    expect(writesContaining(stderrSpy, '[bus-client]')).toEqual([
      '[bus-client] subject: test.circular, payload: [unserializable payload]\n',
    ]);
  });

  it('registers no trace listener and disables transport debug without MAKAIO_DEBUG', async () => {
    vi.stubEnv('MAKAIO_DEBUG', '');
    await connectWithFakes();

    expect(transportOptions()?.debug).toBe(false);
    expect(onAny).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['with MAKAIO_DEBUG=true', 'true'],
    ['without MAKAIO_DEBUG', ''],
  ])('passes a bus debugLog that writes to stderr and not stdout %s', async (_label, envValue) => {
    vi.stubEnv('MAKAIO_DEBUG', envValue);
    await connectWithFakes();

    expect(busOptions()?.debugLog).toBeTypeOf('function');
    busOptions()?.debugLog?.('[bus] bus-marker');

    expect(writesContaining(stderrSpy, '[bus] bus-marker')).toEqual(['[bus] bus-marker\n']);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(consoleDebugSpy).not.toHaveBeenCalled();
  });

  it('routes a real bus diagnostic through the sink to stderr, leaving stdout untouched', async () => {
    const actual = await vi.importActual<typeof import('@makaio/bus-core')>('@makaio/bus-core');
    busCoreMocks.createBusInstance.mockImplementation(actual.createBusInstance);
    vi.stubEnv('MAKAIO_DEBUG', '');
    const failingTransport: BusTransport = {
      name: 'ws-client',
      ready: Promise.resolve(),
      send: (async (_message: BusMessage) => {
        throw new Error('handshake refused');
      }) as BusTransport['send'],
      onReceive: () => () => undefined,
      connect: async () => undefined,
      disconnect: async () => undefined,
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
    };
    transportMocks.WebSocketClientTransport.mockImplementation(function MockTransport() {
      return failingTransport;
    });

    const bus = await connectBusClient('ws://127.0.0.1:6252/bus');
    try {
      await vi.waitFor(() => {
        expect(writesContaining(stderrSpy, '[AdvertisedState] subscribe-sync-complete send failed')).toHaveLength(1);
      });
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(consoleDebugSpy).not.toHaveBeenCalled();
    } finally {
      bus.disconnect();
    }
  });
});
