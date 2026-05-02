/**
 * Bus client connection for CLI commands.
 *
 * Connects to the running Makaio instance's WebSocket bus at `:6252/bus`.
 * CLI commands use this to send RPC requests to services running in the
 * server process (Electron or `makaio serve`).
 *
 * Before connecting, callers may use {@link probeHealth} to check whether
 * the server requires authentication, then pass the resolved auth strategy
 * via {@link connectBusClient}'s `options.auth` parameter.
 */
import { createBusInstance } from '@makaio/bus-core';
import { HmacAuth, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import type { TransportAuth, WebSocketClientTransportReconnectOptions } from '@makaio/bus-transport-websocket';
import type { IMakaioBus } from '@makaio/bus-core';
import { normalizeBusSecret } from '@makaio/utils';
import { parseHealthBody, type HealthResult } from '@makaio/utils/health-probe';
export type { HealthResult as ServerHealth } from '@makaio/utils/health-probe';

const DEFAULT_BUS_URL = 'ws://127.0.0.1:6252/bus';
/** CLI commands should fail fast — 5 seconds is generous for a local socket. */
const CONNECT_TIMEOUT_MS = 5_000;
/** Timeout for the health endpoint probe (ms). */
const HEALTH_PROBE_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

/**
 * Resolve the CLI bus URL from an explicit override or environment.
 *
 * Empty or whitespace-only values are treated as absent so callers reliably
 * fall back to {@link DEFAULT_BUS_URL} instead of attempting to connect to an
 * invalid target.
 * @param busUrl - Optional explicit bus URL override.
 * @returns Normalized bus URL.
 */
export function resolveBusUrl(busUrl?: string): string {
  const normalizedOverride = typeof busUrl === 'string' ? busUrl.trim() : '';
  if (normalizedOverride.length > 0) {
    return normalizedOverride;
  }

  const normalizedEnv = process.env.MAKAIO_BUS_URL?.trim() ?? '';
  return normalizedEnv.length > 0 ? normalizedEnv : DEFAULT_BUS_URL;
}

/**
 * Probe the server's `/health` endpoint to determine auth requirements.
 *
 * Returns the server's health status, or `null` if the server is unreachable.
 * @param busUrl - WebSocket URL of the bus (default from env or `ws://127.0.0.1:6252/bus`).
 * @returns Health status or `null` if unreachable.
 */
export async function probeHealth(busUrl?: string): Promise<HealthResult | null> {
  const url = resolveBusUrl(busUrl);
  const healthUrl = deriveHealthUrl(url);
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.text();
    return parseHealthBody(body);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Derive the HTTP health endpoint URL from a WebSocket bus URL.
 * @param wsUrl - WebSocket bus URL (e.g. `ws://127.0.0.1:6252/bus`).
 * @returns HTTP health URL (e.g. `http://127.0.0.1:6252/health`).
 */
export function deriveHealthUrl(wsUrl: string): string {
  const httpUrl = wsUrl.replace(/^ws(s?)/, 'http$1');
  return /\/bus\/?$/.test(httpUrl) ? httpUrl.replace(/\/bus\/?$/, '/health') : httpUrl.replace(/\/?$/, '/health');
}

/**
 * Detect whether a bus connection error indicates authentication failure.
 * @param error - Unknown connection failure.
 * @returns `true` when the failure points to missing or invalid credentials.
 */
export function isAuthConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    if (typeof error === 'string') {
      return /\b(401|403|auth|unauthori[sz]ed|forbidden|credential|secret)\b/i.test(error);
    }
    return false;
  }

  const withMeta = error as { code?: unknown; status?: unknown; message?: unknown };
  if (withMeta.code === 401 || withMeta.code === 403 || withMeta.status === 401 || withMeta.status === 403) {
    return true;
  }

  if (typeof withMeta.message === 'string') {
    return /\b(401|403|auth|unauthori[sz]ed|forbidden|credential|secret)\b/i.test(withMeta.message);
  }

  return false;
}

/**
 * Resolve the auth strategy based on the server's health response.
 *
 * If the server requires auth, reads `MAKAIO_BUS_SECRET` from the environment.
 * Throws if auth is required but no secret is available.
 * @param health - Health probe result.
 * @returns An HmacAuth instance, or `undefined` for unauthenticated connections.
 */
export function resolveClientAuth(health: HealthResult): TransportAuth | undefined {
  if (!health.auth) return undefined;

  const secret = normalizeBusSecret(process.env['MAKAIO_BUS_SECRET']);
  if (!secret) {
    throw new Error('Server requires authentication. Set MAKAIO_BUS_SECRET to connect.');
  }
  return new HmacAuth({ secret });
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * Options for {@link connectBusClient}.
 */
export interface ConnectBusClientOptions {
  /** Authentication strategy. */
  auth?: TransportAuth;
  /**
   * Automatic reconnection configuration. When provided, the transport will
   * automatically attempt to reconnect with exponential backoff on unexpected
   * disconnection. Pass `true` to use the transport's built-in defaults.
   * Pass `false` or omit to disable (fail-fast, default for CLI commands).
   */
  autoReconnect?: WebSocketClientTransportReconnectOptions | boolean;
}

/**
 * Resolve the auto-reconnect config to pass to the transport from the caller
 * option.
 *
 * - `false` / `undefined` → `false` (fail-fast)
 * - `true` → `{}` (empty object, lets the transport apply its own defaults)
 * - object → passed through as-is
 * @param autoReconnect - Caller-supplied auto-reconnect option.
 * @returns Resolved reconnect config for the transport.
 */
function resolveReconnectConfig(
  autoReconnect: ConnectBusClientOptions['autoReconnect'],
): WebSocketClientTransportReconnectOptions | false {
  if (!autoReconnect) return false;
  if (autoReconnect === true) return {};
  return autoReconnect;
}

/**
 * Connect to the running Makaio bus as a WebSocket client.
 *
 * Creates an isolated bus instance (not the global singleton) so that each
 * CLI command gets its own connection without state leaks between invocations.
 * Reconnection is disabled by default — CLI commands should fail fast if the
 * server is not running rather than silently retrying. Long-lived consumers
 * (such as the interactive TUI) may opt in via `options.autoReconnect`.
 *
 * Lifecycle events are emitted automatically by the transport registry for any
 * bus with registered transports — no factory wiring is required.
 * @param url - WebSocket URL of the bus server.
 * @param options - Optional connection options.
 * @returns A connected bus client.
 * @throws When the bus is unreachable (server not running).
 */
export async function connectBusClient(url?: string, options?: ConnectBusClientOptions): Promise<IMakaioBus> {
  const resolvedUrl = resolveBusUrl(url);
  const resolvedReconnectConfig = resolveReconnectConfig(options?.autoReconnect);

  const transport = new WebSocketClientTransport({
    url: resolvedUrl,
    name: 'ws-client',
    autoReconnect: resolvedReconnectConfig,
    auth: options?.auth,
    debug: process.env['MAKAIO_DEBUG'] === 'true',
  });

  const bus = createBusInstance({ transports: [transport] });

  // Always enforce an initial connection timeout so both fail-fast CLI commands
  // and interactive sessions surface a failure state if the TCP/WebSocket open
  // or auth handshake stalls. After a successful first connect, the transport's
  // reconnect backoff loop runs without this timeout.
  //
  // Guard against late-completing connect() after timeout — the losing promise
  // may finish and reopen a socket after disconnect().
  // bus.disconnect() is idempotent — no dedup wrapper needed for the
  // timeout-finalizer vs catch-path race.
  let timedOut = false;
  const connectPromise = bus.connect().finally(() => {
    if (timedOut) bus.disconnect();
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connectPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error('Bus connection timed out'));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    bus.disconnect();
    if (isAuthConnectionError(error)) {
      throw new Error(
        `Failed to authenticate with Makaio bus.\nCheck MAKAIO_BUS_SECRET and try again.\n(tried ${resolvedUrl})`,
        {
          cause: error,
        },
      );
    }
    throw new Error(
      `Makaio is not running. Start it with 'makaio serve' or open Makaio.app.\n` + `(tried ${resolvedUrl})`,
      {
        cause: error,
      },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  return bus;
}
