/**
 * Dispatching authentication strategy for multi-protocol bus servers.
 *
 * Enables a single WebSocket server port to accept clients using different
 * authentication protocols by inspecting the first auth message type and
 * routing to the appropriate strategy.
 */

import type { TransportAuth } from './interface.js';
import type { WebSocketLike } from '../types.js';

/**
 * Options for creating a dispatching auth strategy.
 */
export interface DispatchingAuthOptions {
  /** Auth strategy for HMAC challenge/response clients. */
  hmac?: TransportAuth;
  /** Auth strategy for E2E key-exchange clients. */
  e2e?: TransportAuth;
}

/**
 * Per-socket pending server-auth state, awaiting the first client message
 * to determine which strategy to delegate to.
 */
interface PendingServerAuth {
  resolve: () => void;
  reject: (error: Error) => void;
  send: (message: unknown) => void;
}

/**
 * Auth dispatcher that routes to the appropriate strategy based on the first
 * auth message type received from the client.
 *
 * Enables a single bus server port to accept both HMAC-authenticated
 * connections (e.g., Electron) and E2E-authenticated connections (e.g., mobile).
 *
 * ### How it works
 *
 * HMAC auth is server-initiated (the server sends a challenge before any client
 * message arrives). E2E auth is client-initiated (the client sends `e2e-key-exchange`
 * as its first message). This creates a dispatch ordering problem: the dispatcher
 * cannot wait for the client's first message before deciding which strategy to use,
 * because HMAC requires the server to act first.
 *
 * The solution:
 *
 * **Single strategy**: If only one strategy is configured, `authenticateServer`
 * delegates immediately — no dispatch needed, no ordering constraint.
 *
 * **Both strategies**: `authenticateServer` calls `hmac.authenticateServer()`
 * eagerly so HMAC can send its challenge right away. It then waits for the
 * client's first message to determine the winner:
 * - `auth-response` → HMAC is already running; forward and let it complete.
 * - `e2e-key-exchange` → E2E wins; cancel HMAC (its pending promise is
 *   rejected via `cleanupSocket`), start `e2e.authenticateServer()`, and
 *   forward the message to E2E.
 *
 * A cancellation flag on the `send` wrapper given to HMAC prevents HMAC's
 * error path from sending spurious `auth-result: false` to E2E clients.
 * @example
 * ```typescript
 * const auth = new DispatchingAuth({
 *   hmac: new HmacAuth({ secret: process.env.BUS_SECRET! }),
 *   e2e: new E2EAuth({ ... }),
 * });
 *
 * const server = createBusServer({ websocket: wss, auth });
 * ```
 */
export class DispatchingAuth implements TransportAuth {
  private readonly hmac: TransportAuth | undefined;
  private e2e: TransportAuth | undefined;

  /** Maps each socket to its resolved auth strategy after the first message. */
  private readonly socketStrategy = new Map<WebSocketLike, TransportAuth>();

  /**
   * Maps each socket to its pending server-auth state while we wait for the
   * first client message to determine the appropriate strategy.
   */
  private readonly pendingServerAuth = new Map<WebSocketLike, PendingServerAuth>();

  /**
   * Per-socket cancellation flags for eagerly-started HMAC auth.
   *
   * When E2E wins the dispatch race, the flag is set to `true` so the `send`
   * wrapper passed to HMAC becomes a no-op, preventing spurious `auth-result`
   * failure messages from reaching the E2E client.
   */
  private readonly hmacCancelled = new Map<WebSocketLike, { cancelled: boolean }>();

  /**
   * @param options - Auth strategies to dispatch between
   */
  public constructor(options: DispatchingAuthOptions) {
    this.hmac = options.hmac;
    this.e2e = options.e2e;
  }

  /**
   * Set or replace the E2E authentication strategy after construction.
   *
   * Used in transport-first boot sequences where the bus server starts with
   * HMAC-only auth and E2E auth is wired in later, once machine identity
   * (e.g. LAN keypair) becomes available. Only affects new connection
   * handshakes — in-flight authentications are unaffected.
   * @param e2e - The E2E auth strategy to register
   */
  public setE2EAuth(e2e: TransportAuth): void {
    this.e2e = e2e;
  }

  /**
   * Authenticate a client connection.
   *
   * The dispatcher is a server-side concern; clients always know which strategy
   * they are using. This method delegates to the first configured strategy as a
   * fallback, or throws if no strategy is configured.
   * @param send - Function to send auth messages to the server
   * @returns Promise that resolves when client authentication is complete
   * @throws Error if no auth strategy is configured
   */
  public async authenticateClient(send: (message: unknown) => void): Promise<void> {
    const strategy = this.hmac ?? this.e2e;
    if (!strategy) {
      throw new Error('DispatchingAuth: no auth strategy configured');
    }
    return strategy.authenticateClient(send);
  }

  /**
   * Authenticate a server connection with a specific client socket.
   *
   * **Single strategy**: delegates immediately to the configured strategy.
   *
   * **Both strategies**: starts HMAC eagerly (so it can send its challenge),
   * then parks a pending promise that resolves or rejects once
   * `handleAuthMessage` receives the first client message and determines the
   * winner. If E2E wins, HMAC is cancelled via `cleanupSocket`.
   * @param socket - The client WebSocket connection to authenticate
   * @param send - Function to send auth messages to the client
   * @returns Promise that resolves when server authentication is complete
   * @throws Error if no strategy matches the client's auth type, or if the
   *   delegated strategy rejects authentication
   */
  public async authenticateServer(socket: WebSocketLike, send: (message: unknown) => void): Promise<void> {
    // Fast path: single strategy — delegate immediately, no dispatch needed.
    const single = this.resolveSingleStrategy();
    if (single) {
      return single.authenticateServer(socket, send);
    }
    if (!this.hmac || !this.e2e) {
      throw new Error('DispatchingAuth: no auth strategy configured');
    }

    // Both strategies configured. HMAC must send its challenge before the
    // client's first message arrives, so start it eagerly with a cancellable
    // send wrapper. The result of this call will be wired up once we know
    // which strategy the client intends to use.
    const hmacFlag = { cancelled: false };
    this.hmacCancelled.set(socket, hmacFlag);
    const hmacSend = (msg: unknown): void => {
      if (!hmacFlag.cancelled) send(msg);
    };

    // Fire-and-forget; outcome is resolved in handleAuthMessage via pendingServerAuth.
    // Errors are swallowed here because the pending promise already handles them:
    // - HMAC wins → HMAC promise outcome is wired to pendingServerAuth.
    // - E2E wins → HMAC is cancelled; its rejection is intentionally discarded.
    const hmacPromise = this.hmac.authenticateServer(socket, hmacSend);

    return new Promise<void>((resolve, reject) => {
      this.pendingServerAuth.set(socket, { resolve, reject, send });

      // If HMAC is already running and E2E hasn't been chosen yet, wire HMAC's
      // outcome to the pending promise. This reference is replaced by
      // handleAuthMessage when the strategy is determined.
      hmacPromise.then(resolve).catch((err: unknown) => {
        // Only propagate if HMAC was not cancelled (i.e., HMAC actually won).
        if (!hmacFlag.cancelled) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  /**
   * Handle incoming message during authentication phase.
   *
   * On the first message for an unknown socket, peeks at `message.type` to
   * select a strategy, then delegates `authenticateServer` and this message
   * to the selected strategy. Subsequent messages for the same socket are
   * forwarded directly.
   * @param message - Parsed message object
   * @param socket - Optional socket identifier for server-side multi-client scenarios
   * @returns true if the message was handled as an auth message, false otherwise
   */
  public handleAuthMessage(message: unknown, socket?: WebSocketLike): boolean {
    if (!socket) {
      // Client-side: delegate to the resolved (only) strategy
      const strategy = this.hmac ?? this.e2e;
      return strategy?.handleAuthMessage(message) ?? false;
    }

    const resolved = this.socketStrategy.get(socket);
    if (resolved) {
      return resolved.handleAuthMessage(message, socket);
    }

    // First message for this socket — peek the type to select a strategy
    const strategy = this.resolveStrategy(message);
    const pending = this.pendingServerAuth.get(socket);

    if (!strategy) {
      // Unknown auth type: cancel HMAC if it was started, then reject pending
      this.cancelHmac(socket);
      if (pending) {
        this.pendingServerAuth.delete(socket);
        pending.reject(
          new Error(
            `DispatchingAuth: unrecognised auth message type "${this.peekType(message)}" — no matching strategy`,
          ),
        );
      }
      return false;
    }

    this.socketStrategy.set(socket, strategy);
    this.pendingServerAuth.delete(socket);

    if (strategy === this.hmac) {
      // HMAC won. It is already running (started eagerly in authenticateServer).
      // Its outcome is already wired to the pending promise via the hmacPromise
      // .then/.catch handlers. Nothing more to do here except forward the message.
      this.hmacCancelled.delete(socket);
    } else {
      // E2E won. Cancel the eagerly-started HMAC auth.
      this.cancelHmac(socket);

      if (pending) {
        // Start E2E auth and wire its outcome to the pending promise.
        strategy
          .authenticateServer(socket, pending.send)
          .then(pending.resolve)
          .catch((err: unknown) => {
            pending.reject(err instanceof Error ? err : new Error(String(err)));
          });
      }
    }

    // Forward this first message to the selected strategy's handler
    return strategy.handleAuthMessage(message, socket);
  }

  /**
   * Clean up authentication resources for a specific socket.
   *
   * Delegates to the resolved strategy if one was selected, then removes
   * all per-socket state held by the dispatcher itself.
   * @param socket - The socket to clean up auth resources for
   */
  public cleanupSocket(socket: WebSocketLike): void {
    const resolved = this.socketStrategy.get(socket);
    if (resolved) {
      resolved.cleanupSocket(socket);
      this.socketStrategy.delete(socket);
    }

    // Cancel any eagerly-started HMAC auth
    this.cancelHmac(socket);

    // If the pending auth was never resolved, reject and remove it
    const pending = this.pendingServerAuth.get(socket);
    if (pending) {
      this.pendingServerAuth.delete(socket);
      pending.reject(new Error('DispatchingAuth: socket disconnected before auth type was determined'));
    }
  }

  /**
   * Clean up all authentication resources.
   *
   * Calls `cleanup` on both configured strategies (if present) and clears
   * all internal maps.
   */
  public cleanup(): void {
    this.hmac?.cleanup();
    this.e2e?.cleanup();
    this.socketStrategy.clear();
    for (const pending of this.pendingServerAuth.values()) {
      pending.reject(new Error('DispatchingAuth: cleanup called before authentication completed'));
    }
    this.pendingServerAuth.clear();
    this.hmacCancelled.clear();
  }

  /**
   * Peek at the `type` field of an unknown message without a full parse.
   * @param message - Raw parsed message object
   * @returns The string value of `message.type`, or `undefined`
   */
  private peekType(message: unknown): string | undefined {
    if (typeof message !== 'object' || !message || !('type' in message)) {
      return undefined;
    }
    const { type } = message as Record<string, unknown>;
    return typeof type === 'string' ? type : undefined;
  }

  /**
   * Returns the single configured strategy, or `undefined` if both or neither
   * are configured.
   *
   * Used by `authenticateServer` to short-circuit dispatch when only one
   * strategy is present.
   * @returns The sole configured strategy, or `undefined`
   */
  private resolveSingleStrategy(): TransportAuth | undefined {
    if (this.hmac && !this.e2e) return this.hmac;
    if (this.e2e && !this.hmac) return this.e2e;
    return undefined;
  }

  /**
   * Select the appropriate strategy based on the first auth message type.
   *
   * HMAC clients send `auth-response` as their first message (the server
   * already sent `auth-challenge` eagerly). E2E clients send `e2e-key-exchange`.
   * @param message - The first auth message received from the client
   * @returns The matching strategy, or `undefined` if none matches
   */
  private resolveStrategy(message: unknown): TransportAuth | undefined {
    const type = this.peekType(message);
    if (!type) return undefined;

    if (type === 'e2e-key-exchange' && this.e2e) return this.e2e;
    if (type === 'auth-response' && this.hmac) return this.hmac;

    return undefined;
  }

  /**
   * Cancel the eagerly-started HMAC authentication for a socket.
   *
   * Sets the cancellation flag (preventing spurious `send` calls from HMAC's
   * error path) and calls `hmac.cleanupSocket` to reject HMAC's pending
   * response promise and release its resources.
   * @param socket - The socket whose HMAC auth should be cancelled
   */
  private cancelHmac(socket: WebSocketLike): void {
    const flag = this.hmacCancelled.get(socket);
    if (flag) {
      flag.cancelled = true;
      this.hmacCancelled.delete(socket);
      this.hmac?.cleanupSocket(socket);
    }
  }
}
