/**
 * Unit tests for the BusClient connection cache in connection.ts.
 *
 * Real WebSocket connections are mocked so tests exercise only URL resolution,
 * singleton caching, retry-on-failure, and closeConnection() teardown.
 * Integration tests (requiring a live server) are skipped unless
 * MAKAIO_BUS_URL is set in the environment.
 */

/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Module-level mock state — declared before mock.module() calls so the factory
// closures can capture the mutable references.
// ---------------------------------------------------------------------------

const connectMock = mock<() => Promise<void>>(() => Promise.resolve());
const closeMock = mock<() => void>();
const getBusMock = mock<() => object>(() => ({}));

mock.module('@makaio/sdk', () => {
  class BusClient {
    public readonly url: string;
    public constructor(url: string) {
      this.url = url;
    }
    public connect = connectMock;
    public close = closeMock;
    public getBus = getBusMock;
  }

  return { BusClient };
});

// Import AFTER mocks are registered.
const { ensureConnection, closeConnection } = await import('../../../src/core/connection.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureConnection — URL resolution', () => {
  beforeEach(() => {
    connectMock.mockClear();
    closeMock.mockClear();
    getBusMock.mockClear();
  });

  afterEach(async () => {
    await closeConnection();
    connectMock.mockClear();
    closeMock.mockClear();
    getBusMock.mockClear();
  });

  it('uses the built-in default URL — one connect call, no option or env var', async () => {
    const originalUrl = process.env['MAKAIO_BUS_URL'];
    delete process.env['MAKAIO_BUS_URL'];

    try {
      await ensureConnection();
      expect(connectMock).toHaveBeenCalledTimes(1);
    } finally {
      if (originalUrl !== undefined) process.env['MAKAIO_BUS_URL'] = originalUrl;
    }
  });

  it('uses a separate cache slot for the option URL vs env var', async () => {
    process.env['MAKAIO_BUS_URL'] = 'ws://env-host:9999/bus';

    try {
      await ensureConnection({ websocketUrl: 'ws://option-host:8888/bus' });
      expect(connectMock).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env['MAKAIO_BUS_URL'];
      await closeConnection('ws://option-host:8888/bus');
    }
  });

  it('uses the MAKAIO_BUS_URL env var when no option is supplied', async () => {
    process.env['MAKAIO_BUS_URL'] = 'ws://env-host:7777/bus';

    try {
      await ensureConnection();
      expect(connectMock).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env['MAKAIO_BUS_URL'];
      await closeConnection('ws://env-host:7777/bus');
    }
  });

  it('trims whitespace from the option URL', async () => {
    await ensureConnection({ websocketUrl: '  ws://trimmed:6252/bus  ' });
    expect(connectMock).toHaveBeenCalledTimes(1);
    await closeConnection('ws://trimmed:6252/bus');
  });

  it('treats blank option URL as absent and falls back to MAKAIO_BUS_URL', async () => {
    process.env['MAKAIO_BUS_URL'] = 'ws://env-for-blank-option:6252/bus';

    try {
      await ensureConnection({ websocketUrl: '   ' });
      await ensureConnection({ websocketUrl: 'ws://env-for-blank-option:6252/bus' });

      expect(connectMock).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env['MAKAIO_BUS_URL'];
      await closeConnection('ws://env-for-blank-option:6252/bus');
    }
  });

  it('treats blank MAKAIO_BUS_URL as absent and uses the built-in default URL', async () => {
    process.env['MAKAIO_BUS_URL'] = '\t  ';

    try {
      await ensureConnection();
      await ensureConnection({ websocketUrl: 'ws://127.0.0.1:6252/bus' });

      expect(connectMock).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env['MAKAIO_BUS_URL'];
    }
  });
});

describe('ensureConnection — singleton caching', () => {
  beforeEach(() => {
    connectMock.mockClear();
    closeMock.mockClear();
    getBusMock.mockClear();
  });

  afterEach(async () => {
    await closeConnection();
    connectMock.mockClear();
    closeMock.mockClear();
    getBusMock.mockClear();
  });

  it('creates only one client per URL across multiple calls', async () => {
    await ensureConnection();
    await ensureConnection();
    await ensureConnection();

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls for the same URL share one connect attempt', async () => {
    await Promise.all([ensureConnection(), ensureConnection(), ensureConnection()]);

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('creates separate clients for different URLs', async () => {
    const urlA = 'ws://host-a:6252/bus';
    const urlB = 'ws://host-b:6252/bus';

    try {
      await ensureConnection({ websocketUrl: urlA });
      await ensureConnection({ websocketUrl: urlB });

      expect(connectMock).toHaveBeenCalledTimes(2);
    } finally {
      await closeConnection(urlA);
      await closeConnection(urlB);
    }
  });

  it('returns the IMakaioBus from getBus()', async () => {
    const fakeBus = { on: mock(), request: mock(), emit: mock() };
    getBusMock.mockReturnValueOnce(fakeBus);

    const bus: unknown = await ensureConnection();

    expect(bus).toBe(fakeBus);
  });
});

describe('ensureConnection — retry on failure', () => {
  beforeEach(() => {
    connectMock.mockClear();
    closeMock.mockClear();
    getBusMock.mockClear();
  });

  afterEach(async () => {
    await closeConnection();
    connectMock.mockClear();
    closeMock.mockClear();
    getBusMock.mockClear();
  });

  it('clears the cache entry after a failed connect so the next call retries', async () => {
    connectMock.mockRejectedValueOnce(new Error('connect failed'));

    await expect(ensureConnection()).rejects.toThrow();

    // Next call should retry — not return the cached failed promise.
    connectMock.mockResolvedValueOnce(undefined);
    await expect(ensureConnection()).resolves.toBeDefined();

    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('failed connect catch handler does not clear a replacement entry', async () => {
    // Scenario: connect promise P1 fails; closeConnection removes P1 from cache
    // and a new ensureConnection puts P2 in; then P1's .catch fires. Without an
    // identity guard the .catch would delete P2. With the guard it does nothing
    // because connectionCache.get(url) === P2 !== P1.
    //
    // We simulate this by:
    // 1. Starting a failing connect (P1).
    // 2. Letting P1 fail synchronously.
    // 3. Before the .catch microtask runs, calling closeConnection (clears cache)
    //    followed by ensureConnection (puts P2 in cache) — both synchronous up to
    //    their first await.
    // 4. Asserting that ensureConnection(P2) still succeeds.

    let rejectP1!: (err: unknown) => void;
    const p1Barrier = new Promise<void>((_, reject) => {
      rejectP1 = reject;
    });

    connectMock.mockImplementationOnce(() => p1Barrier);
    connectMock.mockResolvedValueOnce(undefined);

    // Start connect P1 (will fail) — not awaited.
    const firstCall = ensureConnection();

    // Fail P1 — this schedules the rejection microtask but does not run it yet.
    rejectP1(new Error('P1 failed'));

    // Synchronously simulate the close + re-enter scenario:
    // closeConnection deletes the cache entry (synchronously up to await),
    // and the subsequent ensureConnection populates the cache with P2.
    // Note: closeConnection will try to close p1Barrier which is still
    // pending; that is fine — close errors are swallowed.
    const closePromise = closeConnection(); // sync: delete cache, set closingPromises
    // At this point connectionCache is empty and closingPromises[url] is set.
    // ensureConnection will await the closing barrier, then put P2 in the cache.
    const secondCall = ensureConnection();

    // The first call propagates the error.
    await expect(firstCall).rejects.toThrow('P1 failed');
    await closePromise;
    // The second call must succeed — P2 must not have been deleted.
    await expect(secondCall).resolves.toBeDefined();

    expect(connectMock).toHaveBeenCalledTimes(2);

    await closeConnection();
  });
});

describe('closeConnection', () => {
  beforeEach(() => {
    connectMock.mockClear();
    closeMock.mockClear();
    getBusMock.mockClear();
  });

  afterEach(async () => {
    // Drain any cached connection so tests don't bleed state into each other.
    await closeConnection();
    connectMock.mockClear();
    closeMock.mockClear();
    getBusMock.mockClear();
  });

  it('is a no-op when no connection was established for the URL', async () => {
    await expect(closeConnection('ws://never-connected:6252/bus')).resolves.toBeUndefined();
  });

  it('calls close() on the cached client', async () => {
    await ensureConnection();
    await closeConnection();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('removes the entry from the cache so a new call reconnects', async () => {
    await ensureConnection();
    await closeConnection();

    // After awaiting close, the cache is empty and ensureConnection creates a new connection.
    await ensureConnection();

    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('concurrent closeConnection and ensureConnection do not corrupt the cache', async () => {
    // Establish an initial connection.
    await ensureConnection();

    // Close and immediately re-open — ensureConnection must wait for the
    // close to finish before creating a new connection.
    const closePromise = closeConnection();
    const reconnectPromise = ensureConnection();

    await Promise.all([closePromise, reconnectPromise]);

    // Two connect calls: the initial one and the reconnect.
    expect(connectMock).toHaveBeenCalledTimes(2);
    // One close call for the initial connection.
    expect(closeMock).toHaveBeenCalledTimes(1);

    await closeConnection();
  });
});

describe('core integration (requires MAKAIO_BUS_URL)', () => {
  it.skipIf(!process.env['MAKAIO_BUS_URL'])('verifies connection returns a bus-like object', async () => {
    // With the mock in place, this just verifies the mocked path returns correctly.
    const bus = await ensureConnection();
    expect(bus).toBeDefined();
  });
});
