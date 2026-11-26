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
  type WorkerExchangeRequest,
} from '@makaio/contracts/boundary';
import { deepFreeze } from '@makaio/utils';
import { WebSocket } from 'ws';

const transientSocketCodes = new Set(['EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/** @returns The same terminal error for every exhausted bootstrap attempt. */
function deadlineElapsed(): WebSocketConnectionError {
  return new WebSocketConnectionError('WS_CONNECTION_TIMEOUT', 'Worker exchange deadline elapsed');
}

/** Client-only handshake on the transport's normal pre-routing auth path. */
class WorkerExchangeAuth implements TransportAuth {
  private request: WorkerExchangeRequest | undefined;
  private pending: PromiseWithResolvers<void> | undefined;
  public payload: JsonValue | undefined;
  public possiblyPresented = false;

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
    this.discardRequest();
    if (!reply.success || 'reject' in reply.data) {
      pending.reject(new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Worker exchange refused'));
    } else if (Date.now() >= this.deadline()) {
      pending.reject(deadlineElapsed());
    } else {
      this.payload = deepFreeze(reply.data.payload);
      pending.resolve();
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

  /** Release the cleartext presentation at terminal completion. */
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

/** Open one authenticated bus session, retrying the presentation only before the first reply. */
export class WorkerExchangeClient extends WebSocketClientTransport {
  private readonly exchange: WorkerExchangeAuth;
  private readonly bootstrapDeadline: number;
  private readonly replayDeadline: number;
  private armAttemptDeadline: (() => void) | undefined;
  private readonly lifetime = new AbortController();

  /**
   * @param busUrl - Direct or verified-ingress TLS bus endpoint.
   * @param config - Provider-supplied ephemeral admission material.
   */
  public constructor(busUrl: string | undefined, config: OrderedWorkerBootstrapAuth) {
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
      createWebSocket: (endpoint) =>
        new WebSocket(endpoint, { rejectUnauthorized: true, maxPayload: WORKER_EXCHANGE_MAX_BYTES }),
    });
    this.exchange = auth;
    this.bootstrapDeadline = Date.parse(config.bootstrapDeadlineAt);
    this.replayDeadline = Date.parse(config.replayDeadlineAt);
  }

  /** @returns The committed opaque order, once received. */
  public get bootstrapPayload(): JsonValue | undefined {
    return this.exchange.payload;
  }

  public override async connect(): Promise<void> {
    const signal = this.lifetime.signal;
    try {
      for (let attempt = 0; ; attempt += 1) {
        signal.throwIfAborted();
        if (!(this.deadline > Date.now())) throw deadlineElapsed();
        try {
          await this.connectBeforeDeadline();
          return;
        } catch (error) {
          if (this.bootstrapPayload !== undefined || signal.aborted || !isRetryable(error)) throw error;
        }
        const untilDeadline = this.deadline - Date.now();
        if (untilDeadline <= 0) throw deadlineElapsed();
        await delay(Math.min(defaultReconnectDelay(attempt), untilDeadline), undefined, { signal });
      }
    } finally {
      this.exchange.discardRequest();
    }
  }

  /** @returns The active deadline, which changes only after a presentation is sent. */
  private get deadline(): number {
    return this.exchange.possiblyPresented ? this.replayDeadline : this.bootstrapDeadline;
  }

  /** Bound the attempt while preserving the replay window when a presentation is sent. */
  private async connectBeforeDeadline(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let elapsed = false;
    const armDeadline = (): void => {
      clearTimeout(timer);
      const remaining = this.deadline - Date.now();
      if (this.bootstrapPayload !== undefined) return;
      if (remaining <= 0) {
        elapsed = true;
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
    } catch (error) {
      if (elapsed && !this.lifetime.signal.aborted) throw deadlineElapsed();
      throw error;
    } finally {
      this.armAttemptDeadline = undefined;
      clearTimeout(timer);
    }
  }

  public override async disconnect(): Promise<void> {
    this.lifetime.abort(new Error('Worker connection cancelled'));
    this.exchange.discardRequest();
    await super.disconnect();
  }
}
