/**
 * Async Makaio bus protocol client for external consumers.
 *
 * Wraps `@makaio/bus-core` and `@makaio/bus-transport-websocket`
 * into a single, developer-friendly API that mirrors the Python and Rust SDKs.
 */
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus, OnOptions } from '@makaio/bus-core';
import type { EventContext, RequestContext, SubjectDefinition } from '@makaio/core';
import { HmacAuth, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import type {
  TransportAuth,
  WebSocketClientTransportReconnectOptions,
  WebSocketLike,
} from '@makaio/bus-transport-websocket';
import { normalizeBusSecret } from '@makaio/utils';

const DEFAULT_BUS_URL = 'ws://127.0.0.1:6252/bus';
const CONNECT_TIMEOUT_MS = 5_000;
const HEALTH_PROBE_TIMEOUT_MS = 3_000;
const SDK_CLIENT_TRANSPORT_NAME = 'sdk-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link BusClient.connect}. */
export interface BusClientOptions {
  /** Authentication strategy. Resolved automatically when omitted and the server requires auth. */
  auth?: TransportAuth;
  /**
   * WebSocket factory used by the underlying transport.
   *
   * Defaults to the transport's Node `ws` factory. Override for tests, browser
   * runtimes, or custom socket implementations.
   * @param url - Target WebSocket URL.
   * @returns WebSocket-like connection object.
   */
  createWebSocket?: (url: string) => WebSocketLike | Promise<WebSocketLike>;
  /**
   * Automatic reconnection configuration.
   * - `true` — use transport defaults (recommended for long-lived consumers)
   * - `false` / omitted — fail fast on disconnect
   */
  autoReconnect?: WebSocketClientTransportReconnectOptions | boolean;
  /** Connection timeout in milliseconds (default: 5000). */
  connectTimeoutMs?: number;
  /** Enable debug logging on the transport (default: false). */
  debug?: boolean;
}

/** Health probe result from the server's `/health` endpoint. */
export interface ServerHealth {
  auth: boolean;
}

/** Callback for event subscriptions. */
export type EventHandler<T = unknown> = (context: EventContext<T>) => void | Promise<void>;

/** Callback for request handlers. Return the response payload or call `context.setResult()`. */
export type RequestHandler<TReq = unknown, TRes = unknown> = (
  context: RequestContext<TReq, TRes>,
) => TRes | void | Promise<TRes | void>;

/** Options for event subscriptions and request handlers. */
export type HandlerOptions = Pick<OnOptions, 'filter' | 'priority'>;

/** Options for {@link BusClient.once}. */
export interface OnceOptions {
  /** Declarative payload filter applied both locally and server-side. */
  filter?: Record<string, unknown>;
  /** Timeout in milliseconds; rejects with `OnceTimeoutError` if exceeded. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// BusClient
// ---------------------------------------------------------------------------

/**
 * Client for the Makaio WebSocket bus protocol.
 * @example
 * ```ts
 * import { BusClient, SessionSubjects } from '@makaio/sdk';
 *
 * const client = new BusClient('ws://localhost:6252/bus');
 * await client.connect();
 *
 * const result = await client.request(SessionSubjects.sendMessage, {
 *   sessionId: crypto.randomUUID(),
 *   agent: { kind: 'canonical-model', model: 'gpt-5.2' },
 *   message: 'Hello!',
 * });
 *
 * client.close();
 * ```
 */
export class BusClient {
  private bus: IMakaioBus | null = null;
  private readonly url: string;

  public constructor(url?: string) {
    this.url = (url ?? readEnv('MAKAIO_BUS_URL')?.trim()) || DEFAULT_BUS_URL;
  }

  /**
   * Open a WebSocket connection to the bus server.
   *
   * When no explicit auth is provided and the server requires authentication,
   * HMAC auth is resolved automatically from `MAKAIO_BUS_SECRET`.
   * @param options - Optional connection configuration.
   */
  public async connect(options?: BusClientOptions): Promise<void> {
    if (this.bus) return;

    const auth = options?.auth ?? (await this.resolveAuth());
    const reconnect = resolveReconnectConfig(options?.autoReconnect);

    const transport = new WebSocketClientTransport({
      url: this.url,
      name: SDK_CLIENT_TRANSPORT_NAME,
      autoReconnect: reconnect,
      auth,
      createWebSocket: options?.createWebSocket,
      debug: options?.debug ?? readEnv('MAKAIO_DEBUG') === 'true',
    });

    const bus = createBusInstance({ transports: [transport] });
    const timeoutMs = options?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

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
            reject(new Error(`Bus connection timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      bus.disconnect();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to connect to Makaio bus at ${this.url}: ${detail}\n` +
          `Make sure Makaio is running ('makaio serve' or Makaio.app).`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    this.bus = bus;
  }

  /**
   * Subscribe to events matching a subject or wildcard pattern.
   * @param subject - Subject definition or wildcard subject to subscribe to.
   * @param handler - Handler invoked for each matching event.
   * @param options - Optional local filter and handler priority.
   * @returns Unsubscribe function.
   */
  public subscribe<T = unknown>(
    subject: SubjectDefinition,
    handler: EventHandler<T>,
    options?: HandlerOptions,
  ): () => void {
    return this.getBus().on(
      subject as never,
      ((ctx: EventContext<T>) => {
        if (ctx.isRequest) return;
        return handler(ctx);
      }) as never,
      { ...options, handlerKind: 'event' },
    );
  }

  /**
   * Send a request and wait for the response.
   * @param subject - Request subject definition.
   * @param payload - Request payload.
   * @param options - Optional timeout configuration.
   * @returns Promise resolving to the response payload.
   */
  public async request<TReq, TRes>(
    subject: SubjectDefinition,
    payload: TReq,
    options?: { timeout?: number },
  ): Promise<TRes> {
    return this.getBus().request(subject as never, payload as never, {
      ...options,
      transports: [SDK_CLIENT_TRANSPORT_NAME],
    }) as Promise<TRes>;
  }

  /**
   * Emit a fire-and-forget event.
   * @param subject - Event subject definition.
   * @param payload - Event payload.
   */
  public async emit<T = unknown>(subject: SubjectDefinition, payload: T): Promise<void> {
    await this.getBus().emit(subject as never, payload as never);
  }

  /**
   * Register a request handler with optional priority.
   * @param subject - Request subject definition to handle.
   * @param handler - Handler invoked for each matching request.
   * @param options - Optional local filter and handler priority.
   * @returns Unsubscribe function.
   */
  public onRequest<TReq = unknown, TRes = unknown>(
    subject: SubjectDefinition,
    handler: RequestHandler<TReq, TRes>,
    options?: HandlerOptions,
  ): () => void {
    return this.getBus().on(
      subject as never,
      (async (ctx: RequestContext<TReq, TRes>) => {
        const result = await handler(ctx);
        if (result !== undefined) {
          ctx.setResult(result);
        }
      }) as never,
      { ...options, handlerKind: 'request' },
    );
  }

  /**
   * Wait for a single event matching the subject and optional filter.
   * Resolves with the event context when the event fires.
   * @param subject - Event subject definition to wait for.
   * @param options - Optional declarative payload filter and timeout.
   * @returns Promise resolving to the event context.
   */
  public once<T = unknown>(subject: SubjectDefinition, options?: OnceOptions): Promise<EventContext<T>> {
    // Type boundary: the internal bus uses conditional types that require the full subject metadata.
    // We bridge via the typed IMakaioBus.once promise overload below.
    type BusOnce = (subject: never, options: OnceOptions | undefined) => Promise<EventContext<T>>;
    return (this.getBus().once as BusOnce)(subject as never, options);
  }

  /** Close the WebSocket connection and release resources. */
  public close(): void {
    if (this.bus) {
      this.bus.disconnect();
      this.bus = null;
    }
  }

  /**
   * Returns the underlying bus instance. Throws if not connected.
   * @returns The connected {@link IMakaioBus} instance.
   */
  public getBus(): IMakaioBus {
    if (!this.bus) throw new Error('BusClient is not connected. Call connect() first.');
    return this.bus;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async resolveAuth(): Promise<TransportAuth | undefined> {
    const health = await probeHealth(this.url);
    if (!health?.auth) return undefined;

    const secret = normalizeBusSecret(readEnv('MAKAIO_BUS_SECRET'));
    if (!secret) {
      throw new Error('Makaio bus requires authentication. Set MAKAIO_BUS_SECRET to connect.');
    }
    return new HmacAuth({ secret });
  }
}

// ---------------------------------------------------------------------------
// Health probe (exported for advanced use cases)
// ---------------------------------------------------------------------------

/**
 * Probe the server's `/health` endpoint to check availability and auth requirements.
 * @param busUrl - WebSocket bus URL (defaults to the standard local address).
 * @returns Health status, or `null` if the server is unreachable.
 */
export async function probeHealth(busUrl?: string): Promise<ServerHealth | null> {
  const url = busUrl ?? DEFAULT_BUS_URL;
  const httpUrl = url.replace(/^ws(s?)/, 'http$1');
  const healthUrl = /\/bus\/?$/.test(httpUrl)
    ? httpUrl.replace(/\/bus\/?$/, '/health')
    : httpUrl.replace(/\/?$/, '/health');
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.text();
    const trimmed = body.trim();
    if (trimmed.toLowerCase() === 'ok') return { auth: false };
    try {
      const parsed = JSON.parse(trimmed) as { ok?: boolean; auth?: boolean };
      return parsed.ok === true ? { auth: parsed.auth === true } : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize the `autoReconnect` option into a concrete transport config or `false`.
 * @param opt - Raw `autoReconnect` value from {@link BusClientOptions}.
 * @returns Resolved reconnect config or `false` to disable.
 */
function resolveReconnectConfig(
  opt: BusClientOptions['autoReconnect'],
): WebSocketClientTransportReconnectOptions | false {
  if (!opt) return false;
  if (opt === true) return {};
  return opt;
}

/**
 * Read an environment variable without assuming the `process` global exists.
 * @param key - Environment variable key.
 * @returns The value when available, otherwise `undefined`.
 */
function readEnv(key: string): string | undefined {
  return typeof process !== 'undefined' ? process.env[key] : undefined;
}
