/**
 * Unit tests for the pure helpers in `bus-client`.
 *
 * These helpers derive health/auth behavior without establishing any real
 * WebSocket connections.
 */
import type { IMakaioBus } from '@makaio/bus-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HmacAuth } from '@makaio/bus-transport-websocket';
import { connectBusClient, deriveHealthUrl, probeHealth, resolveBusUrl, resolveClientAuth } from '../bus-client.js';

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

    await expect(rejection).rejects.toThrow('Makaio is not running.');
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
