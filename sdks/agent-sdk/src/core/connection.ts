/**
 * Lazy BusClient singleton manager for the /core entry point.
 *
 * Each unique WebSocket URL maps to one connected {@link BusClient} instance.
 * The first call for a given URL creates and connects the client; subsequent
 * calls return the same cached instance immediately.
 *
 * Auth is resolved automatically: when the server requires HMAC authentication
 * and no explicit auth is provided, the {@link BusClient} probes `/health` and
 * reads `MAKAIO_BUS_SECRET` from the environment.
 */

import { BusClient } from '@makaio/sdk';
import type { BusClientOptions } from '@makaio/sdk';
import type { IMakaioBus } from '@makaio/bus-core';
import type { TransportAuth } from '@makaio/bus-transport-websocket';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default WebSocket bus URL. */
const DEFAULT_BUS_URL = 'ws://127.0.0.1:6252/bus';

// ---------------------------------------------------------------------------
// Singleton cache
// ---------------------------------------------------------------------------

/**
 * Cache of connected {@link BusClient} instances, keyed by WebSocket URL.
 *
 * Each entry holds either a settled client or the in-flight connect promise
 * so that concurrent callers for the same URL share one connection attempt.
 */
const connectionCache = new Map<string, Promise<BusClient>>();

/**
 * In-flight close promises, keyed by WebSocket URL.
 *
 * `ensureConnection` awaits the matching entry before creating a new
 * connection so that a fresh connect is never started while the previous
 * client is still closing.
 */
const closingPromises = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an optional URL value and discard blank strings.
 * @param value - Candidate URL value.
 * @returns Trimmed URL, or undefined when absent/blank.
 */
const normalizeOptionalUrl = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/**
 * Resolve the bus URL from options, environment, or the built-in default.
 * @param websocketUrl - Caller-supplied URL override.
 * @returns Resolved WebSocket URL string.
 */
const resolveBusUrl = (websocketUrl?: string): string =>
  normalizeOptionalUrl(websocketUrl) ??
  normalizeOptionalUrl(typeof process !== 'undefined' ? process.env['MAKAIO_BUS_URL'] : undefined) ??
  DEFAULT_BUS_URL;

/**
 * Create and connect a new {@link BusClient} for the given URL and options.
 *
 * Failures clear the cache entry so the next call retries rather than
 * returning a permanently broken instance.
 * @param url - Resolved WebSocket URL.
 * @param auth - Optional explicit auth strategy.
 * @returns Connected {@link BusClient} instance.
 */
const createConnection = async (url: string, auth?: TransportAuth): Promise<BusClient> => {
  const client = new BusClient(url);
  const connectOptions: BusClientOptions = {
    ...(auth !== undefined ? { auth } : {}),
    autoReconnect: true,
  };
  await client.connect(connectOptions);
  return client;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for {@link ensureConnection}.
 */
export interface ConnectionOptions {
  /**
   * WebSocket URL for the Makaio bus.
   *
   * Resolved in priority order:
   * 1. This option
   * 2. `MAKAIO_BUS_URL` environment variable
   * 3. `ws://127.0.0.1:6252/bus` (built-in default)
   */
  websocketUrl?: string;
  /**
   * Authentication strategy for the bus connection.
   *
   * When omitted, auth is probed automatically: if the server's `/health`
   * endpoint indicates auth is required, `MAKAIO_BUS_SECRET` is read from the
   * environment.
   */
  websocketAuth?: TransportAuth;
}

/**
 * Ensure a connected {@link BusClient} exists for the given URL and return
 * the underlying {@link IMakaioBus} instance.
 *
 * The first call for each URL creates and caches the connection; subsequent
 * calls return immediately from cache.  If a connection attempt fails the
 * cache entry is cleared so the next caller retries.
 *
 * If a close is in progress for this URL the call waits for it to finish
 * before creating a new connection, preventing a new client from being
 * created while the old one is still shutting down.
 * @param options - URL and optional auth overrides.
 * @returns Connected {@link IMakaioBus} instance ready for use.
 */
export const ensureConnection = async (options?: ConnectionOptions): Promise<IMakaioBus> => {
  const url = resolveBusUrl(options?.websocketUrl);

  // Serialize against any in-progress close so we never open a new
  // connection while the previous client is still tearing down.
  const closing = closingPromises.get(url);
  if (closing !== undefined) {
    await closing;
  }

  let connectPromise = connectionCache.get(url);
  if (connectPromise === undefined) {
    connectPromise = createConnection(url, options?.websocketAuth).catch((err: unknown) => {
      // Only clear if this promise is still the active cache entry.
      // A concurrent closeConnection + ensureConnection could have replaced
      // it already, and we must not clobber the replacement.
      if (connectionCache.get(url) === connectPromise) {
        connectionCache.delete(url);
      }
      throw err;
    });
    connectionCache.set(url, connectPromise);
  }

  const client = await connectPromise;
  return client.getBus();
};

/**
 * Close the cached {@link BusClient} for a given URL and remove it from the
 * cache.
 *
 * Safe to call when no connection was ever established for that URL.  The next
 * call to {@link ensureConnection} with the same URL will start a fresh
 * connection only after this close completes, preventing a new client from
 * racing against an in-progress teardown.
 *
 * **Breaking change from pre-1.0:** now returns `Promise<void>` so callers
 * can await full teardown.
 * @param websocketUrl - URL whose connection to close (default: built-in
 *   default URL resolved via environment variable).
 * @returns Promise that resolves once the underlying client has fully closed.
 */
export const closeConnection = async (websocketUrl?: string): Promise<void> => {
  const url = resolveBusUrl(websocketUrl);
  const promise = connectionCache.get(url);
  if (promise === undefined) return;

  connectionCache.delete(url);

  const closePromise = promise
    .then((client) => client.close())
    .catch(() => {
      // Nothing to do — the connection may have already failed.
    })
    .finally(() => {
      closingPromises.delete(url);
    });

  closingPromises.set(url, closePromise);
  await closePromise;
};
