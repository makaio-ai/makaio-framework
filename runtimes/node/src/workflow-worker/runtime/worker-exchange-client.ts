import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CONNECTION_EXCHANGE_PATH,
  defaultReconnectDelay,
  WebSocketClientTransport,
  WebSocketConnectionError,
  type TransportAuth,
} from '@makaio/bus-transport-websocket';
import type { JsonValue, OrderedWorkerBootstrapAuth } from '@makaio/contracts';
import {
  WORKER_EXCHANGE_MAX_BYTES,
  WORKER_REDEMPTION_EXCHANGE,
  WorkerExchangeReplySchema,
  WorkerRunIdentityReplySchema,
  type WorkerExchangeRequest,
  type WorkerRunIdentityRequest,
} from '@makaio/contracts/boundary';
import { abortableWait, deepFreeze } from '@makaio/utils';
import { WebSocket } from 'ws';

const transientSocketCodes = new Set(['EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/** Owner check bound to the synchronized worker bus. */
export interface WorkerExchangeSessionCheck {
  /**
   * Read the current standing and original deadline of the caller's run.
   * @param jobRunId - Expected authenticated run.
   * @param signal - Lifetime of this synchronized connection.
   * @returns The original expiry, or undefined when the run may no longer work.
   */
  readExpiry(jobRunId: string, signal: AbortSignal): Promise<string | undefined>;
}

/** @returns The same terminal error for every exhausted bootstrap attempt. */
function deadlineElapsed(): WebSocketConnectionError {
  return new WebSocketConnectionError('WS_CONNECTION_TIMEOUT', 'Worker exchange deadline elapsed');
}

/** Client-only handshake on the transport's normal pre-routing auth path. */
class WorkerExchangeAuth implements TransportAuth {
  private request: WorkerExchangeRequest | WorkerRunIdentityRequest | undefined;
  private pending: PromiseWithResolvers<void> | undefined;
  public payload: JsonValue | undefined;
  public possiblyPresented = false;
  public expiresAt: string | undefined;

  /**
   * @param config - Ephemeral start material supplied by the provider.
   * @param deadline - The active deadline for sending a presentation.
   * @param onPresentation - Switch the active attempt to the replay window.
   */
  public constructor(
    config: OrderedWorkerBootstrapAuth,
    private readonly deadline: () => number,
    private readonly onPresentation: () => void,
  ) {
    const { jobRunId, oneTimeToken, proof } = config;
    this.request = deepFreeze({
      type: 'connection-exchange',
      exchange: WORKER_REDEMPTION_EXCHANGE,
      presented: {
        jobRunId,
        oneTimeToken,
        proof: structuredClone(proof),
        runtimeSecret: randomBytes(32).toString('hex'),
      },
    });
  }

  public async authenticateClient(send: (message: unknown) => void): Promise<void> {
    if (this.request === undefined) throw new Error('Worker exchange has already ended');
    if (!(this.deadline() > Date.now())) throw deadlineElapsed();
    const pending = Promise.withResolvers<void>();
    this.pending = pending;
    try {
      send(this.request);
      if (!this.possiblyPresented) {
        this.possiblyPresented = true;
        this.onPresentation();
      }
      await pending.promise;
    } finally {
      this.pending = undefined;
    }
  }

  public handleAuthMessage(message: unknown): boolean {
    const resultFrame =
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'connection-exchange-result';
    if (!resultFrame) return this.pending !== undefined;
    const pending = this.pending;
    if (pending === undefined) return true;
    this.pending = undefined;
    const reply = WorkerExchangeReplySchema.safeParse(message);
    const request = this.request;
    const identity = WorkerRunIdentityReplySchema.safeParse(message);
    if (!reply.success || 'reject' in reply.data) {
      if (
        request !== undefined &&
        'kind' in request &&
        identity.success &&
        identity.data.identity.jobRunId === request.jobRunId &&
        this.recordExpiry(identity.data.identity.expiresAt)
      ) {
        pending.resolve();
      } else {
        pending.reject(new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Worker exchange refused'));
      }
    } else if (Date.now() >= this.deadline()) {
      pending.reject(deadlineElapsed());
    } else if (request !== undefined && 'presented' in request) {
      const { jobRunId, runtimeSecret } = request.presented;
      this.payload = deepFreeze(reply.data.payload);
      // This transition belongs to reply validation, before the peer's sync.
      this.request = Object.freeze({ kind: 'job-run', jobRunId, runtimeSecret });
      pending.resolve();
    } else {
      pending.reject(new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Unexpected bootstrap reply'));
    }
    return true;
  }

  public classifyClientSocketError(event: Event): WebSocketConnectionError {
    const error: unknown = 'error' in event ? event.error : undefined;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return typeof code === 'string' && transientSocketCodes.has(code)
      ? new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Worker connection interrupted')
      : new WebSocketConnectionError('WS_POLICY_REJECTED', 'Worker connection refused');
  }

  public async authenticateServer(): Promise<void> {
    throw new Error('Worker exchange authentication is client-only');
  }

  public cleanupSocket(): void {
    this.cleanup();
  }

  public cleanup(): void {
    this.pending?.reject(new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Worker connection interrupted'));
  }

  /**
   * Record the original deadline without ever extending it.
   * @param expiry - Deadline confirmed by the issuer or the synchronized owner.
   * @returns Whether this session can use the deadline.
   */
  public recordExpiry(expiry: string): boolean {
    if (Date.now() >= this.deadline() || !(Date.parse(expiry) > Date.now())) return false;
    if (this.expiresAt !== undefined && this.expiresAt !== expiry) return false;
    this.expiresAt = expiry;
    this.onPresentation();
    return true;
  }

  /** Release the cleartext presentation once no further attempt can use it. */
  public discardRequest(): void {
    this.request = undefined;
  }
}

/**
 * Select the explicit TLS setup endpoint without forwarding URL credentials.
 * @param value - Provider-supplied bus URL.
 * @returns Validated exchange endpoint.
 */
function exchangeUrl(value: string): string {
  const url = URL.parse(value);
  if (url?.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Worker exchange requires a secure bus URL');
  }
  return new URL(CONNECTION_EXCHANGE_PATH, url).href;
}

/**
 * Check the setup-specific subset of transient connection failures.
 * @param error - Failure from one transport attempt.
 * @returns Whether the original presentation may be repeated.
 */
function isRetryable(error: unknown): boolean {
  return (
    error instanceof WebSocketConnectionError &&
    error.code === 'WS_CONNECTION_UNAVAILABLE' &&
    (error.closeCode === undefined || error.closeCode === 1006 || error.closeCode === 1011)
  );
}

/** Own the bounded bootstrap and subsequent identity sessions of one worker. */
export class WorkerExchangeClient extends WebSocketClientTransport {
  private readonly exchange: WorkerExchangeAuth;
  private readonly jobRunId: string;
  private readonly bootstrapDeadline: number;
  private readonly replayDeadline: number;
  private armAttemptDeadline: (() => void) | undefined;
  private readonly lifetime = new AbortController();
  private socketLifetime: AbortSignal | undefined;

  /**
   * @param busUrl - Direct or verified-ingress TLS bus endpoint.
   * @param config - Provider-supplied ephemeral admission material.
   * @param check - Owner status check bound by the test composition.
   * @param onTerminal - End the worker when an established identity cannot continue.
   */
  public constructor(
    busUrl: string | undefined,
    config: OrderedWorkerBootstrapAuth,
    private readonly check?: WorkerExchangeSessionCheck,
    private readonly onTerminal?: (error: unknown) => void,
  ) {
    const url = exchangeUrl(busUrl ?? '');
    const auth = new WorkerExchangeAuth(
      config,
      () => this.deadline,
      () => this.armAttemptDeadline?.(),
    );
    super({
      url,
      attestingRole: 'core-uplink',
      auth,
      autoReconnect: false,
      createWebSocket: (endpoint) => this.openSocket(endpoint),
    });
    this.exchange = auth;
    this.jobRunId = config.jobRunId;
    this.bootstrapDeadline = Date.parse(config.bootstrapDeadlineAt);
    this.replayDeadline = Date.parse(config.replayDeadlineAt);
  }

  /** @returns The committed opaque order, once received. */
  public get bootstrapPayload(): JsonValue | undefined {
    return this.exchange.payload;
  }

  public override async connect(): Promise<void> {
    try {
      const session = await this.connectWithinWindow();
      if (this.check === undefined) {
        this.exchange.discardRequest();
      } else {
        void this.followIdentity(session).catch((error: unknown) => {
          if (!this.lifetime.signal.aborted) {
            void this.disconnect();
            this.onTerminal?.(error);
          }
        });
      }
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  /** @returns The lifetime of a synchronized connection that passed its check. */
  private async connectWithinWindow(): Promise<AbortSignal> {
    const signal = this.lifetime.signal;
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      if (!(this.deadline > Date.now())) throw deadlineElapsed();
      try {
        return await this.connectBeforeDeadline();
      } catch (error) {
        if (signal.aborted || !isRetryable(error)) throw error;
      }
      const untilDeadline = this.deadline - Date.now();
      if (untilDeadline <= 0) throw deadlineElapsed();
      await delay(Math.min(defaultReconnectDelay(attempt), untilDeadline), undefined, { signal });
    }
  }

  /**
   * Watch only a status-authorized composition and retry only classified socket loss.
   * @param session - Lifetime of the first synchronized and checked connection.
   */
  private async followIdentity(session: AbortSignal): Promise<void> {
    const stopped = this.lifetime.signal;
    while (!stopped.aborted) {
      const remaining = this.deadline - Date.now();
      if (remaining <= 0) throw deadlineElapsed();
      try {
        await delay(Math.min(remaining, 2 ** 31 - 1), undefined, { signal: AbortSignal.any([session, stopped]) });
      } catch {
        stopped.throwIfAborted();
        if (!isRetryable(session.reason)) throw session.reason;
        session = await this.connectWithinWindow();
      }
    }
  }

  /**
   * Capture the native close disposition before subscription readiness begins.
   * @param endpoint - Validated TLS exchange endpoint.
   * @returns Socket owned by this attempt.
   */
  private openSocket(endpoint: string): WebSocket {
    const socket = new WebSocket(endpoint, { rejectUnauthorized: true, maxPayload: WORKER_EXCHANGE_MAX_BYTES });
    const closed = new AbortController();
    this.socketLifetime = closed.signal;
    socket.once('close', (code) => {
      closed.abort(
        new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Worker connection closed', undefined, code),
      );
    });
    return socket;
  }

  /** @returns The deadline for the current stage of admission. */
  private get deadline(): number {
    if (this.exchange.expiresAt !== undefined) return Date.parse(this.exchange.expiresAt);
    return this.exchange.possiblyPresented ? this.replayDeadline : this.bootstrapDeadline;
  }

  /** @returns The lifetime of this connection once sync and the owner check have completed. */
  private async connectBeforeDeadline(): Promise<AbortSignal> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new AbortController();
    const armDeadline = (): void => {
      clearTimeout(timer);
      const remaining = this.deadline - Date.now();
      if (remaining <= 0) {
        timeout.abort(deadlineElapsed());
        void super.disconnect();
      } else {
        timer = setTimeout(armDeadline, Math.min(remaining, 2 ** 31 - 1));
      }
    };
    this.armAttemptDeadline = armDeadline;
    try {
      const connected = super.connect();
      armDeadline();
      await connected;
      const session = this.socketLifetime;
      if (session === undefined) throw new Error('Worker connection did not acquire a socket');
      const signal = AbortSignal.any([session, timeout.signal, this.lifetime.signal]);
      await abortableWait(this.ready, signal);
      signal.throwIfAborted();
      if (this.check !== undefined) {
        const expiry = await abortableWait(this.check.readExpiry(this.jobRunId, signal), signal);
        if (expiry === undefined || !this.exchange.recordExpiry(expiry)) {
          throw new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Worker status refused');
        }
      }
      signal.throwIfAborted();
      return session;
    } catch (error) {
      if (timeout.signal.aborted && !this.lifetime.signal.aborted) throw deadlineElapsed();
      throw error;
    } finally {
      this.armAttemptDeadline = undefined;
      clearTimeout(timer);
    }
  }

  public override async disconnect(): Promise<void> {
    this.lifetime.abort(new Error('Worker connection cancelled'));
    this.exchange.discardRequest();
    this.exchange.payload = undefined;
    await super.disconnect();
  }
}
