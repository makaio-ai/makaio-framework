import { DEFAULT_READINESS_TIMEOUT_MS } from '@makaio/bus-core';
import type { TransportReceiveContext } from '@makaio/core';
import { abortableWait } from '@makaio/utils';
import { WebSocketConnectionError } from '../connection-error.js';
import type { WebSocketLike } from '../types.js';
import { DEFAULT_AUTH_CHALLENGE_TIMEOUT_MS } from './auth-deadline.js';
import type { TransportAuth } from './interface.js';

/** Explicit WebSocket upgrade path reserved for the connection exchange. */
export const CONNECTION_EXCHANGE_PATH = '/bus/exchange';

/** Host-owned facts for one exchange upgrade. */
export interface ConnectionExchangeUpgrade {
  readonly encrypted: boolean;
}

/**
 * Check a composition-owned ingress verifier without letting an exception
 * escape the host upgrade handler.
 * @param request - Native upgrade request delivered by the host.
 * @param verify - Host verification policy for the protected ingress.
 * @returns Whether the verifier established encrypted connection evidence.
 */
export function verifyConnectionExchangeIngress<Request>(
  request: Request,
  verify: ((request: Request) => boolean) | undefined,
): boolean {
  try {
    return verify?.(request) === true;
  } catch {
    return false;
  }
}

/** A committed reply and private receive context used to admit one connection. */
export interface ConnectionExchangeAdmission {
  readonly reply: string;
  readonly caller: NonNullable<TransportReceiveContext['caller']>;
  readonly expiresAt: string;
  readonly revocationKey: string;
  /** Host lifetime checked again at route registration. */
  readonly hostSignal: AbortSignal;
}

/** Trusted metadata for one presentation attempt. */
export interface ConnectionExchangeSetupContext {
  readonly connectionId: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
  /** Allow interruptions to be classified as retryable once the credentials and proof passed. */
  markProofVerified(): void;
}

/** Server-side exchange policy. Configure only on hosts with a verified setup handler. */
export interface ConnectionExchangeSetup {
  /** Host-selected upper bound for simultaneous unconfirmed connections. */
  readonly maxPendingExchanges: number;
  readonly maxBytes: number;
  readonly refusal: string;
  /**
   * Resolve the presentation and finish the durable exchange.
   * @param frame - Size-bounded setup message.
   * @param context - Host connection ID, deadline and cancellation signal.
   * @returns A committed admission, or undefined for a business refusal.
   */
  admit(frame: string, context: ConnectionExchangeSetupContext): Promise<ConnectionExchangeAdmission | undefined>;
}

interface ExchangeState {
  readonly upgrade: ConnectionExchangeUpgrade;
  readonly lifetime: AbortController;
  readonly terminate: () => void;
  input?: PromiseWithResolvers<string | Buffer>;
  admission?: ConnectionExchangeAdmission & { connectionId: string };
  session?: Omit<ConnectionExchangeAdmission, 'reply' | 'hostSignal'> & { connectionId: string };
}

/** The exchange was enabled without valid host configuration. */
export class ConnectionExchangeConfigurationError extends Error {
  /**
   * @param code - Invalid part of the exchange configuration.
   */
  public constructor(
    public readonly code:
      | 'WS_INVALID_EXCHANGE_CAPACITY'
      | 'WS_INVALID_EXCHANGE_HOST_SIGNAL' = 'WS_INVALID_EXCHANGE_CAPACITY',
  ) {
    super(
      code === 'WS_INVALID_EXCHANGE_CAPACITY'
        ? 'Connection exchange requires a positive integer maxPendingExchanges'
        : 'Connection exchange requires a host abort signal',
    );
    this.name = 'ConnectionExchangeConfigurationError';
  }
}

/**
 * Release business refusals on the same schedule and cancel the timer on close.
 * @param releaseAt - Deadline on the monotonic clock.
 * @param signal - Lifetime of the socket.
 */
async function waitForRefusalRelease(releaseAt: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const wait = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, releaseAt - performance.now()));
    });
    await abortableWait(wait, signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Selects an explicitly upgraded exchange socket or the independent legacy auth path. */
export class ConnectionExchangeAuth implements TransportAuth {
  private readonly states = new WeakMap<WebSocketLike, ExchangeState>();
  private readonly pending = new Set<WebSocketLike>();
  private readonly maxPendingExchanges: number;

  /**
   * @param legacy - Explicit authentication policy for ordinary bus upgrades.
   * @param setup - Host policy for exchange upgrades.
   */
  public constructor(
    private readonly legacy: TransportAuth,
    private readonly setup: ConnectionExchangeSetup,
  ) {
    this.maxPendingExchanges = setup.maxPendingExchanges;
    if (!Number.isSafeInteger(this.maxPendingExchanges) || this.maxPendingExchanges <= 0) {
      throw new ConnectionExchangeConfigurationError();
    }
  }

  /** @returns Whether the native adapter can accept another unconfirmed upgrade. */
  public get hasPendingCapacity(): boolean {
    return this.pending.size < this.maxPendingExchanges;
  }

  /**
   * Assign upgrade facts before emitting the connection event.
   * @param socket - Newly upgraded socket.
   * @param upgrade - Facts established by the server adapter.
   * @param terminate - Abort the native socket without waiting for a close handshake.
   * @returns Whether there was capacity to register the connection.
   */
  public register(socket: WebSocketLike, upgrade: ConnectionExchangeUpgrade, terminate: () => void): boolean {
    if (!this.hasPendingCapacity) return false;
    this.pending.add(socket);
    this.states.set(socket, {
      upgrade: Object.freeze({ ...upgrade }),
      lifetime: new AbortController(),
      terminate,
      input: Promise.withResolvers(),
    });
    return true;
  }

  /**
   * Release the admission slot after confirmation or socket cleanup.
   * @param socket - Connection that no longer needs an admission slot.
   */
  private releasePending(socket: WebSocketLike): void {
    this.pending.delete(socket);
  }

  /**
   * Read exactly one presentation within the existing input window.
   * @param state - State owned by the unconfirmed socket.
   * @returns The raw presentation frame.
   */
  private async readPendingInput(state: ExchangeState): Promise<string | Buffer> {
    const input = state.input;
    if (input === undefined) throw new Error('Missing exchange setup input');
    const timeout = AbortSignal.timeout(DEFAULT_AUTH_CHALLENGE_TIMEOUT_MS);
    try {
      return await abortableWait(input.promise, AbortSignal.any([state.lifetime.signal, timeout]));
    } catch (error) {
      // A silent peer receives an abnormal close (1006) without a close handshake.
      if (timeout.aborted && !state.lifetime.signal.aborted) state.terminate();
      throw error;
    }
  }

  public authenticateClient(send: (message: unknown) => void): Promise<void> {
    return this.legacy.authenticateClient(send);
  }

  public async authenticateServer(socket: WebSocketLike, send: (message: unknown) => void): Promise<void> {
    const state = this.states.get(socket);
    if (state === undefined) return this.legacy.authenticateServer(socket, send);

    const admission = await this.authenticateExchange(socket, state);
    state.lifetime.signal.throwIfAborted();
    state.admission = admission;
  }

  /**
   * Resolve one size-bounded presentation before the existing readiness deadline.
   * @param socket - Exchange connection.
   * @param state - Pending handshake for this connection.
   * @returns Committed admission, ready for synchronous route registration.
   */
  private async authenticateExchange(socket: WebSocketLike, state: ExchangeState) {
    const { signal } = state.lifetime;
    const frame = await this.readPendingInput(state);
    // The readiness boundary conceals failures before independent proof.
    const window = DEFAULT_READINESS_TIMEOUT_MS;
    const releaseAt = performance.now() + window;
    const setupSignal = AbortSignal.any([signal, AbortSignal.timeout(window)]);
    const connectionId = crypto.randomUUID();
    let proofVerified = false;
    const context = Object.freeze({
      connectionId,
      deadline: Date.now() + window,
      signal: setupSignal,
      markProofVerified() {
        proofVerified = true;
      },
    });
    if (state.upgrade.encrypted && typeof frame === 'string' && Buffer.byteLength(frame) <= this.setup.maxBytes) {
      try {
        const admission = await abortableWait(this.setup.admit(frame, context), setupSignal);
        if (admission !== undefined) return { ...admission, connectionId };
      } catch (error) {
        if (proofVerified) throw error;
      }
    }
    await waitForRefusalRelease(releaseAt, signal);
    if (socket.readyState === 1) socket.send(this.setup.refusal);
    throw new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Connection exchange refused');
  }

  public completeServerAuthentication(socket: WebSocketLike): void {
    const state = this.states.get(socket);
    if (state === undefined) {
      this.legacy.completeServerAuthentication?.(socket);
      return;
    }
    const admission = state.admission;
    state.admission = undefined;
    if (admission === undefined) throw new Error('Missing committed exchange admission');
    const { reply, hostSignal, ...session } = admission;
    hostSignal.throwIfAborted();
    state.lifetime.signal.throwIfAborted();
    socket.send(reply);
    state.session = session;
    this.releasePending(socket);
  }

  public hasSensitiveFrames(socket: WebSocketLike): boolean {
    return this.states.has(socket) || (this.legacy.hasSensitiveFrames?.(socket) ?? false);
  }

  public handleSetupFrame(data: string | Buffer, socket: WebSocketLike): boolean {
    const state = this.states.get(socket);
    if (state === undefined) return this.legacy.handleSetupFrame?.(data, socket) ?? false;
    if (state.session !== undefined) return false;
    const input = state.input;
    state.input = undefined;
    input?.resolve(data);
    return true;
  }

  public handleAuthMessage(message: unknown, socket?: WebSocketLike): boolean {
    if (socket !== undefined && this.states.has(socket)) return false;
    return this.legacy.handleAuthMessage(message, socket);
  }

  public getReceiveContext(socket?: WebSocketLike): TransportReceiveContext | undefined {
    const state = socket === undefined ? undefined : this.states.get(socket);
    if (state === undefined) return this.legacy.getReceiveContext?.(socket);
    const { session } = state;
    if (session === undefined) return undefined;
    return {
      transportName: '',
      connectionId: session.connectionId,
      authenticated: true,
      encrypted: true,
      caller: session.caller,
    };
  }

  public isSocketAuthenticated(socket: WebSocketLike): boolean {
    const state = this.states.get(socket);
    if (state === undefined) return this.legacy.isSocketAuthenticated?.(socket) ?? true;
    return state.session !== undefined && Date.parse(state.session.expiresAt) > Date.now();
  }

  public getAuthenticatedIdentityId(socket: WebSocketLike): string | undefined {
    return this.states.has(socket) ? undefined : this.legacy.getAuthenticatedIdentityId?.(socket);
  }

  public cleanupSocket(socket: WebSocketLike): void {
    const state = this.states.get(socket);
    if (state === undefined) this.legacy.cleanupSocket(socket);
    else {
      this.releasePending(socket);
      state.lifetime.abort();
      state.input = undefined;
      state.admission = undefined;
      state.session = undefined;
    }
  }

  /** Cancel unconfirmed exchanges before the transport waits for native sockets to close. */
  public abortPendingExchanges(): void {
    for (const socket of this.pending) this.cleanupSocket(socket);
  }

  public cleanup(): void {
    this.abortPendingExchanges();
    this.legacy.cleanup();
  }
}
