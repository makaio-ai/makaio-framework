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
import { HmacAuth, MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
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
 * Bus hostnames that resolve to this machine.
 *
 * `127.0.0.1` and `::1` are the loopback literals the WebSocket transport
 * accepts; `localhost` is the conventional alias for the same loopback
 * address. `[::1]` is also listed because `URL#hostname` serializes an IPv6
 * host with its brackets (per the URL Standard's host serializer), so
 * `new URL('ws://[::1]:6252/bus').hostname` is the bracketed form, not the
 * bare address — omitting it would misclassify an IPv6-loopback bus URL as
 * remote. This CLI has no unix-domain-socket bus transport, so no additional
 * local-socket form needs to be recognized here.
 */
const LOCAL_BUS_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Determine whether a bus URL points at a different machine than this CLI
 * process is running on.
 *
 * Used to gate every offline fallback that reads or writes this machine's own
 * extension state (see `runSetEnabled` and `runList` in
 * `extension-toggle-commands.ts` / `extension-commands.ts`): falling back is
 * only correct when the state this process would touch is the state the
 * configured server would have used — true only when the bus is local. A URL
 * that fails to parse is treated as remote so a malformed override never
 * causes a write to, or a report about, the wrong machine.
 * @param busUrl - Resolved bus URL, as returned by {@link resolveBusUrl}.
 * @returns `true` when the URL's host is not a recognized loopback form.
 */
export function isRemoteBusUrl(busUrl: string): boolean {
  try {
    const { hostname } = new URL(busUrl);
    return !LOCAL_BUS_HOSTNAMES.has(hostname);
  } catch {
    return true;
  }
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
 * Transport error codes that mean the peer explicitly refused the credentials.
 *
 * Mirrors the classification the WebSocket server applies to itself: in
 * `transports/ws/src/server-client-setup.ts` exactly these two codes are the
 * "explicitly classified rejection" that closes the socket with 1008
 * ("Authentication failed"); every other code is a lifecycle failure closed
 * with 1011. Codes such as `WS_CONNECTION_UNAVAILABLE` (socket dropped mid
 * handshake) and `WS_HANDSHAKE_TIMEOUT` (challenge/response/result timed out)
 * carry the word "authentication" in their diagnostic text but describe a
 * transport problem, not a credential problem.
 */
const AUTH_TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set(['WS_AUTHENTICATION_REJECTED', 'WS_POLICY_REJECTED']);

/**
 * Maximum `cause` links walked while classifying a connection failure.
 *
 * The typed transport error is wrapped twice before CLI callers see it — once
 * by `bus.connect()` and once by {@link connectBusClient} — so a one-level
 * lookup would miss the code.
 */
const MAX_CAUSE_DEPTH = 8;

/** Keyword fallback for untyped failures that carry no machine-readable code. */
const AUTH_MESSAGE_PATTERN = /\b(401|403|auth|unauthori[sz]ed|forbidden|credential|secret)\b/i;

/** How a connection failure is classified once a machine-readable code is found. */
type ConnectionFailureClass = 'auth' | 'transport';

/**
 * Classify a connection failure by its machine-readable code, walking the
 * `cause` chain until one is found.
 * @param error - Unknown connection failure, possibly wrapped.
 * @returns The classification, or `undefined` when no known code is present.
 */
function classifyConnectionFailureByCode(error: unknown): ConnectionFailureClass | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    const meta = current as { code?: unknown; status?: unknown; cause?: unknown };
    if (meta.code === 401 || meta.code === 403 || meta.status === 401 || meta.status === 403) {
      return 'auth';
    }
    if (typeof meta.code === 'string') {
      if (AUTH_TRANSPORT_ERROR_CODES.has(meta.code)) return 'auth';
      // Any other transport-typed code is a lifecycle failure, never auth.
      if (meta.code.startsWith('WS_')) return 'transport';
    }
    current = meta.cause;
  }
  return undefined;
}

/**
 * Read the human-readable message of an unknown failure value.
 * @param error - Unknown connection failure.
 * @returns The message string, or `undefined` when there is none.
 */
function readFailureMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return undefined;
  const { message } = error as { message?: unknown };
  return typeof message === 'string' ? message : undefined;
}

/**
 * Detect whether a bus connection error indicates authentication failure.
 *
 * Typed failures are classified by their code (or the code preserved on a
 * wrapped `cause`), never by message text: the HMAC handshake's timeout and
 * disconnect errors describe themselves as "authentication" failures while
 * being pure transport problems, and misreading them as auth would suppress
 * the built-in hook failure cool-down for a server that is genuinely down.
 * The keyword match is only a fallback for untyped failures.
 * @param error - Unknown connection failure.
 * @returns `true` when the failure points to missing or invalid credentials.
 */
export function isAuthConnectionError(error: unknown): boolean {
  const classified = classifyConnectionFailureByCode(error);
  if (classified !== undefined) return classified === 'auth';

  const message = readFailureMessage(error);
  return message !== undefined && AUTH_MESSAGE_PATTERN.test(message);
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
  return new HmacAuth({ secret, identityId: MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID });
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
  const debug = process.env['MAKAIO_DEBUG'] === 'true';
  const transport = new WebSocketClientTransport({
    url: resolvedUrl,
    name: 'ws-client',
    autoReconnect: resolvedReconnectConfig,
    auth: options?.auth,
    debug,
  });

  const bus = createBusInstance({ transports: [transport] });

  if (debug) {
    bus.__onAny((context) => {
      let payload: string;
      try {
        payload = JSON.stringify(context.payload);
      } catch {
        payload = '[unserializable payload]';
      }
      console.debug(`[bus-client] subject: ${context.subject}, payload: ${payload}`);
    });
  }

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
      `Could not connect to Makaio.\n` +
        `If the app was just started, it may still be initializing.\n` +
        `Otherwise, start it with 'makaio serve' or 'makaio open'.\n` +
        `(tried ${resolvedUrl})`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  return bus;
}
