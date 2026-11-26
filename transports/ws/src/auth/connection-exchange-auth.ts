import { DEFAULT_READINESS_TIMEOUT_MS } from '@makaio/bus-core';
import { CorePartyKind, type TransportReceiveContext, type TransportRequestOrigin } from '@makaio/core';
import { abortableWait } from '@makaio/utils';
import { WebSocketConnectionError } from '../connection-error.js';
import type { WebSocketLike } from '../types.js';
import { DEFAULT_AUTH_CHALLENGE_TIMEOUT_MS, waitForRefusalRelease } from './auth-deadline.js';
import { retireVerifiedExchange, verifyRunMessageOrDeny, withForcedRetirement } from './exchange-session-retirement.js';
import type { TransportAuth } from './interface.js';

/** Explicit WebSocket upgrade path reserved for the connection exchange. */
export const CONNECTION_EXCHANGE_PATH = '/bus/exchange';

/** Host-owned facts for one exchange upgrade. */
export interface ConnectionExchangeUpgrade {
  readonly encrypted: boolean;
}

/** A committed reply and private receive context used to admit one connection. */
export interface ConnectionExchangeAdmission {
  readonly reply: string;
  readonly caller: NonNullable<TransportReceiveContext['caller']>;
  readonly expiresAt: string;
  readonly revocationKey: string;
  /** Host lifetime checked again at route registration. */
  readonly hostSignal: AbortSignal;
  /**
   * Recheck owner authority and call `publish` synchronously under the same
   * host-local ordering boundary as terminal commit and invalidation.
   * Resolve without calling it to refuse promotion. Do not publish inside a SQL
   * transaction. The first completed publication settles the transport setup.
   * The host releases its ordering boundary once publication returns.
   * Required for `CorePartyKind.jobRun` admissions and optional for other parties.
   */
  readonly withPromotion?: (publish: () => void) => Promise<void>;
}

type VerifiedExchangeIdentity = Pick<ConnectionExchangeAdmission, 'caller' | 'revocationKey'>;

/** Trusted metadata for one presentation attempt. */
export interface ConnectionExchangeSetupContext {
  readonly connectionId: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
  /** Allow interruptions to be classified as retryable once the credentials and proof passed. */
  markProofVerified(): void;
  /**
   * Record the issuer key and its verified caller under the authoritative owner lock.
   * @param identity - Verified caller and its issuer key.
   */
  markVerifiedRevocationKey?(identity: VerifiedExchangeIdentity): void;
}

/** Server-side exchange policy. Configure only on hosts with a verified setup handler. */
export interface ConnectionExchangeSetup {
  /** Host-selected upper bound for simultaneous unconfirmed connections. */
  readonly maxPendingExchanges: number;
  readonly maxBytes: number;
  readonly refusal: string;
  /**
   * Optional host-owned exchange generation. An aborted signal makes its
   * pending and live exchanges temporarily unavailable. Return a fresh signal
   * only after the host has reconciled durable authority.
   */
  readonly availability?: () => AbortSignal;
  /**
   * Recheck a worker's authoritative acceptance before dispatching a message.
   * Resolve false to retire the connection. Release storage locks before returning.
   */
  verifyRunSession?(
    session: { readonly jobRunId: string; readonly revocationKey: string; readonly expiresAt: string },
    signal: AbortSignal,
  ): Promise<boolean>;
  /**
   * Resolve the presentation and finish the durable exchange.
   * @param frame - Size-bounded setup message.
   * @param context - Host connection ID, deadline and cancellation signal.
   * @returns A committed admission, or undefined for a business refusal.
   */
  admit(frame: string, context: ConnectionExchangeSetupContext): Promise<ConnectionExchangeAdmission | undefined>;
}

interface PendingAdmission extends ConnectionExchangeAdmission {
  readonly connectionId: string;
  readonly deadline: number;
  readonly setupSignal: AbortSignal;
}

interface ExchangeState {
  readonly upgrade: ConnectionExchangeUpgrade;
  readonly lifetime: AbortController;
  readonly terminate: () => void;
  input?: PromiseWithResolvers<string | Buffer>;
  admission?: PendingAdmission;
  pendingIdentity?: VerifiedExchangeIdentity;
  session?: Pick<PendingAdmission, 'caller' | 'expiresAt' | 'revocationKey' | 'connectionId'>;
  availability?: AbortSignal;
  retire?: (code?: 1008 | 1011, reply?: TransportRequestOrigin) => void;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

/** The exchange was enabled without valid host configuration. */
export class ConnectionExchangeConfigurationError extends Error {
  /**
   * @param code - Invalid part of the exchange configuration.
   */
  public constructor(
    public readonly code:
      | 'WS_INVALID_EXCHANGE_CAPACITY'
      | 'WS_INVALID_EXCHANGE_HOST_SIGNAL'
      | 'WS_MISSING_WORKER_PROMOTION' = 'WS_INVALID_EXCHANGE_CAPACITY',
  ) {
    super(
      {
        WS_INVALID_EXCHANGE_CAPACITY: 'Connection exchange requires a positive integer maxPendingExchanges',
        WS_INVALID_EXCHANGE_HOST_SIGNAL: 'Connection exchange requires a host abort signal',
        WS_MISSING_WORKER_PROMOTION: 'Worker connection exchange requires an owner promotion boundary',
      }[code],
    );
    this.name = 'ConnectionExchangeConfigurationError';
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
      markVerifiedRevocationKey({ caller, revocationKey }: VerifiedExchangeIdentity) {
        if (!setupSignal.aborted) state.pendingIdentity = { caller, revocationKey };
      },
    });
    if (state.upgrade.encrypted && typeof frame === 'string' && Buffer.byteLength(frame) <= this.setup.maxBytes) {
      try {
        const admission = await abortableWait(this.setup.admit(frame, context), setupSignal);
        if (
          admission !== undefined &&
          (admission.caller.kind !== CorePartyKind.jobRun || typeof admission.withPromotion === 'function')
        ) {
          context.markVerifiedRevocationKey(admission);
          return { ...admission, connectionId, deadline: context.deadline, setupSignal };
        }
      } catch (error) {
        if (proofVerified) throw error;
      }
    }
    await waitForRefusalRelease(releaseAt, signal);
    if (socket.readyState === 1) socket.send(this.setup.refusal);
    throw new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Connection exchange refused');
  }

  /**
   * Publish the reply and route in one synchronous continuation after the
   * host's final authority check, if this admission has one.
   * @param socket - Pending socket.
   * @param publish - Transport finalization and route registration.
   * @param localSockets - Existing socket registry snapshot on this host.
   */
  public async promoteServerConnection(
    socket: WebSocketLike,
    publish: () => void,
    localSockets?: () => Iterable<WebSocketLike>,
  ): Promise<void> {
    const state = this.states.get(socket);
    const admission = state?.admission;
    const withPromotion = admission?.withPromotion;
    if (state === undefined || admission === undefined || withPromotion === undefined) {
      publish();
      return;
    }

    this.assertPromotion(socket, state, admission);
    const signal = AbortSignal.any([admission.setupSignal, admission.hostSignal]);
    const publication = Promise.withResolvers<void>();
    let mayPublish = true;
    const refuse = (error: unknown): void => {
      mayPublish = false;
      publication.reject(error);
    };

    // Attach the wait before invoking host code. The callback is single-use
    // even if native send reenters it, and hook settlement cannot revoke success.
    const finished = abortableWait(publication.promise, signal);
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return withPromotion.call(admission, () => {
          if (!mayPublish) return;
          mayPublish = false;
          try {
            this.assertPromotion(socket, state, admission);
            if (localSockets !== undefined && admission.caller.kind === CorePartyKind.jobRun) {
              this.retireRunPredecessors(admission, localSockets());
            }
            this.assertPromotion(socket, state, admission);
            publish();
            publication.resolve();
          } catch (error) {
            refuse(error);
          }
        });
      })
      .then(() => {
        if (mayPublish) {
          refuse(new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Connection exchange refused'));
        }
      }, refuse);

    try {
      await finished;
    } finally {
      mayPublish = false;
    }
  }

  /**
   * Detach routes of the same verified run before publishing its replacement.
   * @param admission - Incoming admission under the host's promotion boundary.
   * @param localSockets - Existing sockets tracked by this transport.
   */
  private retireRunPredecessors(admission: PendingAdmission, localSockets: Iterable<WebSocketLike>): void {
    for (const socket of localSockets) {
      const existing = this.states.get(socket);
      const session = existing?.session;
      if (session?.caller.kind === CorePartyKind.jobRun && session.caller.id === admission.caller.id) {
        existing?.retire?.();
      }
    }
  }

  public completeServerAuthentication(socket: WebSocketLike): void {
    const state = this.states.get(socket);
    if (state === undefined) {
      this.legacy.completeServerAuthentication?.(socket);
      return;
    }
    const admission = state.admission;
    if (admission === undefined) throw new Error('Missing committed exchange admission');
    this.assertPromotion(socket, state, admission);
    socket.send(admission.reply);
    this.assertPromotion(socket, state, admission);
    const { caller, expiresAt, revocationKey, connectionId } = admission;
    state.session = { caller, expiresAt, revocationKey, connectionId };
    state.admission = undefined;
    state.pendingIdentity = undefined;
    this.releasePending(socket);
  }

  /**
   * Confirm eligibility before publication and after potentially reentrant native send.
   * @param socket - Connection being promoted.
   * @param state - State owned by the socket.
   * @param admission - Exact acceptance authorized for promotion.
   */
  private assertPromotion(socket: WebSocketLike, state: ExchangeState, admission: PendingAdmission): void {
    state.availability?.throwIfAborted();
    admission.hostSignal.throwIfAborted();
    admission.setupSignal.throwIfAborted();
    state.lifetime.signal.throwIfAborted();
    const now = Date.now();
    if (state.admission !== admission || socket.readyState !== 1 || now >= admission.deadline) {
      throw new Error('Connection exchange promotion interrupted');
    }
    if (!(Date.parse(admission.expiresAt) > now)) {
      throw new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Connection exchange expired');
    }
  }

  /**
   * Bind shared cleanup before reading exchange credentials.
   * @param socket - Upgraded client socket.
   * @param retire - Remove local state and initiate a bounded close using native termination.
   * @param forceDetach - Remove local routes without retaining a response handoff.
   */
  public bindExchangeRetirement(
    socket: WebSocketLike,
    retire: (terminate: () => void, code?: 1008 | 1011, reply?: TransportRequestOrigin) => void,
    forceDetach: () => void,
  ): void {
    const state = this.states.get(socket);
    if (state === undefined) return;
    const retireSocket = withForcedRetirement({
      retire: (code, reply) => retire(state.terminate, code, reply),
      forceDetach,
      clearAuthentication: () => this.cleanupSocket(socket),
      terminate: state.terminate,
    });
    state.retire = retireSocket;
    const generation = this.setup.availability?.();
    if (generation === undefined) return;
    // Each socket owns its listener without growing the host signal's listener list.
    const availability = AbortSignal.any([generation]);
    state.availability = generation;
    const retireUnavailable = () => retireSocket(1011);
    if (availability.aborted) retireUnavailable();
    else availability.addEventListener('abort', retireUnavailable, { once: true, signal: state.lifetime.signal });
  }

  /**
   * Retire an accepted identity when its original deadline elapses.
   * @param socket - Socket that has just joined the route registry.
   */
  public scheduleSessionExpiry(socket: WebSocketLike): void {
    const state = this.states.get(socket);
    if (state?.session === undefined) return;
    const deadline = Date.parse(state.session.expiresAt);
    const checkExpiry = (): void => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) state.retire?.();
      else state.expiryTimer = setTimeout(checkExpiry, Math.min(remaining, 2 ** 31 - 1));
    };
    checkExpiry();
  }

  /**
   * Retire a live exchange socket or fence a verified pending admission.
   * @param socket - Candidate from the local client registry.
   * @param key - Committed revocation key.
   * @param jobRunId - Scope retirement to one run when the owner provides it.
   * @param reply - The initiating request’s response route, if any.
   */
  public invalidateSession(
    socket: WebSocketLike,
    key: string,
    jobRunId?: string,
    reply?: TransportRequestOrigin,
  ): void {
    const state = this.states.get(socket);
    const identity = state?.session ?? state?.pendingIdentity;
    if (state === undefined || identity?.revocationKey !== key) return;
    const { caller } = identity;
    if (jobRunId !== undefined && (caller.kind !== CorePartyKind.jobRun || caller.id !== jobRunId)) return;
    if (state.session !== undefined) {
      retireVerifiedExchange(state, () => this.cleanupSocket(socket), reply);
    } else {
      state.lifetime.abort(new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Connection exchange refused'));
    }
  }

  /**
   * Capture owner verification and retirement for a queued run message.
   * @param socket - Sending connection.
   * @returns The admission operations, when the session needs an owner check.
   * @internal
   */
  public getRunMessageAdmission(socket: WebSocketLike) {
    const state = this.states.get(socket);
    const session = state?.session;
    const verify = this.setup.verifyRunSession;
    if (state === undefined || session?.caller.kind !== CorePartyKind.jobRun || verify === undefined) return;
    const { caller, revocationKey, expiresAt } = session;
    const retire = (): void => {
      if (state.session === session) retireVerifiedExchange(state, () => this.cleanupSocket(socket));
    };
    return {
      maxQueuedBytes: this.setup.maxBytes,
      retire,
      verify: async () => {
        const verified = await verifyRunMessageOrDeny(() =>
          verify.call(this.setup, { jobRunId: caller.id, revocationKey, expiresAt }, state.lifetime.signal),
        );
        if (state.session !== session) return false;
        if (verified) return this.isSocketAuthenticated(socket);
        retire();
        return false;
      },
    };
  }

  /**
   * Identify an authenticated exchange socket before tracking a request.
   * @param socket - Socket that presented the request.
   * @returns Whether this socket has an exchange session.
   */
  public hasExchangeSession(socket: WebSocketLike): boolean {
    return this.states.get(socket)?.session !== undefined;
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

  /**
   * Recheck exchange authentication at a final routing boundary.
   * @param socket - Candidate socket for local delivery.
   * @returns Whether an exchange session may still receive frames. Legacy sockets are unaffected.
   */
  public isExchangeAvailable(socket: WebSocketLike): boolean {
    return !this.states.has(socket) || this.isSocketAuthenticated(socket);
  }

  public isSocketAuthenticated(socket: WebSocketLike): boolean {
    const state = this.states.get(socket);
    if (state === undefined) return this.legacy.isSocketAuthenticated?.(socket) ?? true;
    if (state.availability?.aborted) {
      state.retire?.(1011);
      return false;
    }
    if (state.session === undefined) return false;
    if (Date.parse(state.session.expiresAt) > Date.now()) return true;
    state.retire?.();
    return false;
  }

  public getAuthenticatedIdentityId(socket: WebSocketLike): string | undefined {
    return this.states.has(socket) ? undefined : this.legacy.getAuthenticatedIdentityId?.(socket);
  }

  public cleanupSocket(socket: WebSocketLike): void {
    const state = this.states.get(socket);
    if (state === undefined) this.legacy.cleanupSocket(socket);
    else {
      this.releasePending(socket);
      clearTimeout(state.expiryTimer);
      state.retire = undefined;
      state.input = undefined;
      state.admission = undefined;
      state.pendingIdentity = undefined;
      state.session = undefined;
      state.lifetime.abort();
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
