/**
 * BunBusServerTransportProvider — native Bun WebSocket bus server transport.
 *
 * Exposes a {@link BunBusServerTransportProvider.createWebSocketHandler} method
 * that returns a raw Bun WebSocket handler object for use with
 * `Bun.serve({ websocket })`. This makes the bus transport independent of the
 * Hono app lifecycle: when the route graph builder rebuilds the Hono app (a
 * fresh `new Hono()`), the bus transport continues to function without
 * interruption because it is wired directly to `Bun.serve`.
 *
 * The composition root is responsible for creating the transport, extracting
 * the handler, passing it to `Bun.serve`, and then passing the transport to
 * {@link bootMakaioRuntime}:
 *
 * ```typescript
 * import {
 *   BunBusServerTransportProvider,
 *   bootMakaioRuntime,
 *   createBunRouteGraphFetch,
 * } from '@makaio/runtime-bun';
 *
 * const transport = new BunBusServerTransportProvider({ auth });
 * const websocket = transport.createWebSocketHandler();
 *
 * const bunServer = Bun.serve({ fetch: createBunRouteGraphFetch(routeGraph), websocket, port: 3000 });
 * await bootMakaioRuntime({ transport, bunServer });
 * ```
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { startBusServer, HonoWebSocketBridge, type BusServer } from '@makaio/bus-server';
import { createWebSocketCloseEvent, DispatchingAuth } from '@makaio/bus-transport-websocket';
import type { TransportAuth, WebSocketCloseEvent, WebSocketLike } from '@makaio/bus-transport-websocket';
import type { ServerTransportProvider } from '@makaio/runtime-node';

/**
 * Configuration options for {@link BunBusServerTransportProvider}.
 */
export interface BunBusServerTransportOptions {
  /**
   * Auth strategy.
   *
   * When `undefined` the server runs with no authentication. Pass a
   * {@link DispatchingAuth} to support hot-swapping E2E auth after machine
   * identity is loaded.
   */
  auth?: TransportAuth;

  /**
   * Loopback transport registry name for in-process cross-client relay.
   *
   * Defaults to `'bun'`.
   */
  loopbackName?: string;
}

const DEFAULT_LOOPBACK_NAME = 'bun';

// ── ServerWebSocket → WebSocketLike adapter ──────────────────────────────────

/**
 * Minimal contract for the raw Bun `ServerWebSocket` fields used by the adapter.
 *
 * Avoids importing Bun-specific types so this module compiles with standard
 * TypeScript (tests, CI).
 */
export interface RawServerWebSocket {
  send(data: string | ArrayBufferView | ArrayBufferLike, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

/**
 * Native Bun WebSocket handler shape for use with `Bun.serve({ websocket })`.
 *
 * The composition root passes an instance of this (obtained from
 * {@link BunBusServerTransportProvider.createWebSocketHandler}) directly to
 * `Bun.serve` so the bus transport operates independently of the Hono app.
 *
 * Setting `binaryType: 'arraybuffer'` ensures binary frames are delivered as
 * `ArrayBuffer`, which matches the {@link BunServerWebSocketAdapter.dispatchMessage}
 * signature and avoids a Node `Buffer` conversion step.
 */
export interface BunWebSocketHandler {
  /**
   * Instructs Bun to deliver binary frames as `ArrayBuffer` objects.
   *
   * Without this, Bun's default `binaryType` is `'nodebuffer'` which delivers
   * binary frames as Node `Buffer` instances. Setting `'arraybuffer'` keeps the
   * message type consistent with `dispatchMessage`'s `string | ArrayBuffer`
   * signature.
   */
  binaryType: 'arraybuffer';
  /**
   * Called when a new WebSocket connection is opened.
   * @param ws - The raw Bun server-side WebSocket.
   */
  open(ws: RawServerWebSocket): void;
  /**
   * Called when a message is received from the client.
   * @param ws - The raw Bun server-side WebSocket.
   * @param message - The message payload (string or ArrayBuffer when binaryType is arraybuffer).
   */
  message(ws: RawServerWebSocket, message: string | ArrayBuffer): void;
  /**
   * Called when the WebSocket connection is closed.
   * @param ws - The raw Bun server-side WebSocket.
   * @param code - WebSocket close code.
   * @param reason - WebSocket close reason string.
   */
  close(ws: RawServerWebSocket, code: number, reason: string): void;
}

/**
 * Adapts Bun's `ServerWebSocket` to the {@link WebSocketLike} interface
 * expected by {@link ServerTransport}.
 *
 * Bun's server-side WebSocket dispatches events via handler callbacks on the
 * `Bun.serve({ websocket })` configuration, not via per-socket
 * `addEventListener`. This adapter bridges that gap: the native handler
 * callbacks in {@link BunBusServerTransportProvider.createWebSocketHandler}
 * call the `dispatch*` methods, which forward to listeners registered by
 * `ServerTransport`.
 */
class BunServerWebSocketAdapter implements WebSocketLike {
  /** Registered event listeners keyed by event type. */
  private readonly eventListeners = {
    message: new Set<(event: MessageEvent) => void>(),
    close: new Set<(event: WebSocketCloseEvent) => void>(),
    error: new Set<(event: Event) => void>(),
    open: new Set<(event: Event) => void>(),
  };

  /**
   * @param raw - The raw Bun `ServerWebSocket`.
   */
  public constructor(private readonly raw: RawServerWebSocket) {}

  /**
   * {@inheritDoc WebSocketLike}
   * @returns Current WebSocket ready state from the raw Bun socket.
   */
  public get readyState(): number {
    return this.raw.readyState;
  }

  /**
   * {@inheritDoc WebSocketLike}
   * @param data - Encoded message payload to send to the client.
   */
  public send(data: string | BufferSource | Blob): void {
    if (typeof data === 'string') {
      this.raw.send(data);
      return;
    }

    if (data instanceof Blob) {
      void data
        .arrayBuffer()
        .then((buffer) => {
          if (this.raw.readyState === 1) {
            this.raw.send(new Uint8Array(buffer));
          }
        })
        .catch(() => {
          this.dispatchError();
        });
      return;
    }

    if (data instanceof ArrayBuffer) {
      this.raw.send(new Uint8Array(data));
      return;
    }

    if (ArrayBuffer.isView(data)) {
      this.raw.send(data);
    }
  }

  /**
   * {@inheritDoc WebSocketLike}
   * @param code - Optional WebSocket close code.
   * @param reason - Optional human-readable close reason.
   */
  public close(code?: number, reason?: string): void {
    this.raw.close(code, reason);
  }

  public addEventListener(event: 'message', listener: (event: MessageEvent) => void): void;
  public addEventListener(event: 'error', listener: (event: Event) => void): void;
  public addEventListener(event: 'close', listener: (event: WebSocketCloseEvent) => void): void;
  public addEventListener(event: 'open', listener: (event: Event) => void): void;
  /**
   * {@inheritDoc WebSocketLike}
   * @param event - Event name to subscribe to.
   * @param listener - Callback registered for the given event type.
   */
  public addEventListener(event: string, listener: (event: never) => void): void {
    const set = this.eventListeners[event as keyof typeof this.eventListeners] as
      | Set<(event: never) => void>
      | undefined;
    set?.add(listener);
  }

  public removeEventListener(event: 'message', listener: (event: MessageEvent) => void): void;
  public removeEventListener(event: 'error', listener: (event: Event) => void): void;
  public removeEventListener(event: 'close', listener: (event: WebSocketCloseEvent) => void): void;
  public removeEventListener(event: 'open', listener: (event: Event) => void): void;
  /**
   * {@inheritDoc WebSocketLike}
   * @param event - Event name to unsubscribe from.
   * @param listener - Previously registered callback to remove.
   */
  public removeEventListener(event: string, listener: (event: never) => void): void {
    const set = this.eventListeners[event as keyof typeof this.eventListeners] as
      | Set<(event: never) => void>
      | undefined;
    set?.delete(listener);
  }

  /**
   * Dispatch a message event from the native Bun WebSocket handler's `message` callback.
   * @param data - Message payload from the WebSocket frame.
   */
  public dispatchMessage(data: string | ArrayBuffer): void {
    const event = new MessageEvent('message', { data });
    for (const listener of this.eventListeners.message) {
      listener(event);
    }
  }

  /**
   * Dispatch a close event from the native Bun WebSocket handler's `close` callback.
   * @param code - WebSocket close code.
   * @param reason - WebSocket close reason.
   */
  public dispatchClose(code?: number, reason?: string): void {
    const event = createWebSocketCloseEvent(code, reason);
    for (const listener of this.eventListeners.close) {
      listener(event);
    }
  }

  /**
   * Dispatch an error event.
   */
  public dispatchError(): void {
    const event = new Event('error');
    for (const listener of this.eventListeners.error) {
      listener(event);
    }
  }
}

// ── BunBusServerTransportProvider ─────────────────────────────────────────────

/**
 * Platform-specific bus server transport provider for Bun.
 *
 * Uses a native Bun WebSocket handler (obtained from
 * {@link createWebSocketHandler}) and {@link HonoWebSocketBridge} to accept
 * WebSocket connections and feed them into the framework bus server. The
 * handler is wired directly to `Bun.serve({ websocket })`, making the bus
 * transport independent of the Hono app lifecycle — route graph rebuilds
 * (which create a fresh `new Hono()`) do not affect the bus.
 */
export class BunBusServerTransportProvider implements ServerTransportProvider {
  private readonly options: BunBusServerTransportOptions;

  /** WebSocket bridge between the native handler and ServerTransport. */
  private readonly bridge: HonoWebSocketBridge;

  /** Active bus server instance. Set during connect, cleared on disconnect. */
  private busServer: BusServer | null = null;

  /**
   * Whether the bus server has completed startup and is accepting connections.
   * Guards against WebSocket upgrade requests racing with bus startup.
   */
  private busReady = false;

  /**
   * Set synchronously at the top of {@link connect} to close the TOCTOU window
   * between the guard check and the first `await`.
   */
  private connecting = false;

  /**
   * @param options - Transport configuration.
   */
  public constructor(options: BunBusServerTransportOptions) {
    this.options = options;
    this.bridge = new HonoWebSocketBridge();
  }

  /**
   * The {@link DispatchingAuth} instance if the caller passed one.
   *
   * Exposed so composition roots that need to hot-swap E2E auth after machine
   * identity becomes available can call `dispatchingAuth.setE2EAuth(e2eAuth)`.
   * @returns The {@link DispatchingAuth} instance, or `undefined` when auth was
   *   not provided or is not a `DispatchingAuth`.
   */
  public get dispatchingAuth(): DispatchingAuth | undefined {
    return this.options.auth instanceof DispatchingAuth ? this.options.auth : undefined;
  }

  /**
   * Create a native Bun WebSocket handler for `Bun.serve({ websocket })`.
   *
   * The returned handler replaces the former Hono `upgradeWebSocket` route.
   * The composition root passes this to `Bun.serve()` directly, making the
   * bus transport independent of Hono app lifecycle (and route graph rebuilds).
   *
   * A `WeakMap` keyed on the raw `ServerWebSocket` object stores the
   * per-connection {@link BunServerWebSocketAdapter} so there is no mutation
   * of the Bun socket and no memory leak when connections close.
   * @returns Bun-native WebSocket handler with `open`, `message`, and `close`
   *   callbacks, plus `binaryType: 'arraybuffer'` to ensure binary frames
   *   arrive as `ArrayBuffer` rather than Node `Buffer`.
   */
  public createWebSocketHandler(): BunWebSocketHandler {
    const bridge = this.bridge;
    const isBusReady = (): boolean => this.busReady;
    const adapters = new WeakMap<RawServerWebSocket, BunServerWebSocketAdapter>();

    return {
      binaryType: 'arraybuffer',
      open(ws: RawServerWebSocket): void {
        if (!isBusReady()) {
          ws.close(1013, 'Bus server not ready');
          return;
        }
        const adapter = new BunServerWebSocketAdapter(ws);
        adapters.set(ws, adapter);
        bridge.accept(adapter);
      },
      message(ws: RawServerWebSocket, message: string | ArrayBuffer): void {
        adapters.get(ws)?.dispatchMessage(message);
      },
      close(ws: RawServerWebSocket, code: number, reason: string): void {
        adapters.get(ws)?.dispatchClose(code, reason);
        adapters.delete(ws);
      },
    };
  }

  /**
   * Start the bus server and mark the transport as ready to accept connections.
   * @param bus - Bus instance to attach the transport to.
   * @param _machineId - Machine identifier (unused; callers provide auth externally).
   */
  public async connect(bus: IMakaioBus, _machineId: string): Promise<void> {
    if (this.connecting || this.busServer) {
      throw new Error('[BunBusServerTransport] connect() called while transport is already connected or connecting');
    }
    this.connecting = true;

    try {
      this.busServer = await startBusServer({
        websocket: this.bridge,
        bus,
        auth: this.options.auth,
        loopbackName: this.options.loopbackName ?? DEFAULT_LOOPBACK_NAME,
      });
      this.busReady = true;
    } catch (error) {
      await this.stopBusServer('startup error');
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Stop the bus server and close the bridge.
   *
   * The Bun server is owned by the composition root and is not closed here.
   */
  public async disconnect(): Promise<void> {
    await this.stopBusServer('shutdown');
    this.bridge.close();
  }

  /**
   * Stop the bus server and mark the transport as not ready.
   * @param reason - Context string used in error log messages.
   */
  private async stopBusServer(reason: string): Promise<void> {
    this.busReady = false;
    if (this.busServer) {
      await this.busServer.stop().catch((err: unknown) => {
        console.error(`[BunBusServerTransport] Failed to stop bus server during ${reason}:`, err);
      });
      this.busServer = null;
    }
  }
}
