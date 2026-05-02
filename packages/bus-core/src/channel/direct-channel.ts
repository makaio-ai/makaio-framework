import type { IDirectChannel } from './types.js';
import type { MakaioBusContext } from '../types/bus.js';
import type { BusTransportKeys } from '../registries/transport-registry.js';
import type {
  SubjectDefinition,
  HandlerForSubjectDefinition,
  OptionalResult,
  EventMessagePayload,
  RequestMessagePayload,
  EventHandler,
} from '@makaio/core';
import type { OnOptions } from '../types/index.js';
import { encrypt, decrypt } from './crypto.js';
import { ChannelClosedError } from '../errors/channel-closed-error.js';
import { NoHandlerError } from '../errors/no-handler-error.js';
import { on as internalOn } from '../methods/on.js';
import { emit as internalEmit } from '../methods/emit.js';
import { request as internalRequest } from '../methods/request.js';

/**
 * Encrypted payload shape transmitted over the bus for all channel messages.
 * Bus observers and transports see only this opaque structure.
 *
 * The index signature is required to satisfy the `UnknownRecord` constraint of
 * `EventMessagePayload` and `RequestMessagePayload`. The `iv` and `data`
 * properties are the only fields written or read at runtime.
 */
type EncryptedPayload = Record<string, unknown> & {
  iv: string;
  data: string;
};

/**
 * Typed SubjectDefinition for channel event subjects.
 * The actual on-wire payload is always `EncryptedPayload`.
 */
type ChannelEventSubjectDef = {
  subject: string;
  $meta: {
    namespace: string;
    isRequest: false;
    payload: EventMessagePayload<EncryptedPayload>;
    local: false;
    channel: false;
  };
};

/**
 * Typed SubjectDefinition for channel request subjects.
 * Both the request and response on the wire are `EncryptedPayload`.
 */
type ChannelRequestSubjectDef = {
  subject: string;
  $meta: {
    namespace: string;
    isRequest: true;
    payload: RequestMessagePayload<EncryptedPayload, EncryptedPayload>;
    local: false;
    channel: false;
  };
};

/**
 * Build a channel-scoped event SubjectDefinition.
 *
 * The channelId becomes the namespace (`channel:<channelId>`), keeping colons
 * inside the namespace segment where they are first-class citizens and away from
 * the subject key where colons act as wildcard delimiters.
 *
 * Channel-scoped subjects are intentionally unregistered in the namespace
 * registry: they carry encrypted `{ iv, data }` blobs on the wire, not typed
 * payloads. When `getSchema()` returns `undefined` for these ephemeral subjects,
 * bus-layer Zod validation is correctly skipped. The channel layer itself does not
 * perform schema validation of decrypted payloads — handlers receive the raw parsed
 * JSON and are responsible for safe handling. They remain transport-capable so channels
 * can ride the normal bus infrastructure across process boundaries.
 * @param channelId - Unique channel identifier
 * @param subject - Subject key within the channel (e.g., '$close', 'credential.store')
 * @returns Ad-hoc SubjectDefinition for a channel-scoped event
 */
function makeChannelEventDef(channelId: string, subject: string): ChannelEventSubjectDef {
  // Subject keys within a channel are scoped under namespace "channel:<channelId>",
  // making them globally unique. Different channels using the same short subject key
  // (e.g., "get") cannot collide because each channel's namespace is distinct.
  return {
    subject,
    $meta: {
      namespace: `channel:${channelId}`,
      isRequest: false,
      payload: {} as EventMessagePayload<EncryptedPayload>,
      local: false,
      channel: false,
    },
  };
}

/**
 * Build a channel-scoped request SubjectDefinition.
 *
 * Channel-scoped subjects are intentionally unregistered in the namespace
 * registry: they carry encrypted `{ iv, data }` blobs on the wire, not typed
 * payloads. When `getSchema()` returns `undefined` for these ephemeral subjects,
 * bus-layer Zod validation is correctly skipped. The channel layer itself does not
 * perform schema validation of decrypted payloads — handlers receive the raw parsed
 * JSON and are responsible for safe handling. They remain transport-capable so channels
 * can ride the normal bus infrastructure across process boundaries.
 * @param channelId - Unique channel identifier
 * @param subject - Subject key within the channel
 * @returns Ad-hoc SubjectDefinition for a channel-scoped request
 */
function makeChannelRequestDef(channelId: string, subject: string): ChannelRequestSubjectDef {
  return {
    subject,
    $meta: {
      namespace: `channel:${channelId}`,
      isRequest: true,
      payload: {} as RequestMessagePayload<EncryptedPayload, EncryptedPayload>,
      local: false,
      channel: false,
    },
  };
}

/**
 * Encrypted point-to-point communication channel over the bus.
 *
 * Implements `IDirectChannel`: all payloads are transparently encrypted
 * with a shared AES-256-GCM key derived via ECDH before being dispatched on
 * the bus, and decrypted before being delivered to user handlers.
 *
 * The channel uses a dedicated namespace (`channel:<channelId>`) so its subjects
 * are isolated from the regular bus and cannot leak to transport observers.
 *
 * Lifecycle: call {@link DirectChannel.close} to notify the peer, unsubscribe all
 * handlers, and zeroize the shared key reference. Once closed, all public methods
 * throw {@link ChannelClosedError}.
 */
export class DirectChannel implements IDirectChannel {
  public readonly channelId: string;

  private sharedKey: CryptoKey | null;
  private readonly context: MakaioBusContext;
  private readonly transportNames?: ReadonlyArray<BusTransportKeys>;
  private readonly cleanups: Array<() => void> = [];
  private readonly pendingRequests = new Set<AbortController>();
  private closed = false;

  /**
   * Create a new DirectChannel.
   *
   * Immediately registers a handler for the peer's `$close` event so that
   * either side can initiate shutdown.
   * @param channelId - Unique channel identifier
   * @param sharedKey - AES-256-GCM key derived from the ECDH handshake
   * @param context - Bus context for registering internal handlers
   * @param transportNames - Explicit transport targets for this channel when known
   */
  public constructor(
    channelId: string,
    sharedKey: CryptoKey,
    context: MakaioBusContext,
    transportNames?: ReadonlyArray<BusTransportKeys>,
  ) {
    this.channelId = channelId;
    this.sharedKey = sharedKey;
    this.context = context;
    this.transportNames = transportNames;

    // Listen for peer-initiated close events. Routed through registerEventHandler
    // so GCM authentication is verified before acting on the close signal.
    const closeSubject = makeChannelEventDef(channelId, '$close');
    const closeHandler: EventHandler<unknown> = (_ctx) => {
      this.handlePeerClose();
    };
    this.cleanups.push(
      this.registerEventHandler(
        closeSubject as SubjectDefinition,
        sharedKey,
        closeHandler as HandlerForSubjectDefinition<SubjectDefinition>,
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Public API — IDirectChannel
  // ---------------------------------------------------------------------------

  /**
   * Register an event or request handler on this channel.
   *
   * Encryption is transparent: the handler receives decrypted payloads and
   * (for requests) its `setResult()` call is intercepted so the response is
   * encrypted before leaving the channel.
   * @param subject - Subject definition (channel-scoped via this channel's namespace)
   * @param handler - Handler function matching the subject's schema
   * @param options - Handler options (priority, filter, etc.)
   * @returns Unsubscribe function
   */
  public on<Subject extends SubjectDefinition>(
    subject: Subject,
    handler: HandlerForSubjectDefinition<Subject>,
    options?: OnOptions,
  ): () => void {
    this.assertOpen();
    const key = this.requireKey();

    const isRequest = subject.$meta.isRequest;
    const unsub = isRequest
      ? this.registerRequestHandler(subject, key, handler as HandlerForSubjectDefinition<SubjectDefinition>, options)
      : this.registerEventHandler(subject, key, handler as HandlerForSubjectDefinition<SubjectDefinition>, options);

    this.cleanups.push(unsub);

    return (): void => {
      unsub();
      const idx = this.cleanups.indexOf(unsub);
      if (idx !== -1) this.cleanups.splice(idx, 1);
    };
  }

  /**
   * Register a one-time handler that auto-unsubscribes after the first invocation.
   *
   * The handler unsubscribes itself BEFORE being invoked to prevent re-entrance
   * issues if the handler triggers the same subject.
   * @param subject - Subject definition
   * @param handler - Handler function
   * @returns Unsubscribe function for manual cleanup before the first fire
   */
  public once<Subject extends SubjectDefinition>(
    subject: Subject,
    handler: HandlerForSubjectDefinition<Subject>,
  ): () => void {
    this.assertOpen();
    const key = this.requireKey();

    // Wrap with auto-unsubscribe semantics. The wrapper unsubscribes itself before
    // invoking the user's handler to prevent re-entrance issues.
    let unsub: (() => void) | null = null;

    const onceHandler = ((ctx: unknown) => {
      const u = unsub;
      unsub = null;
      if (u) {
        const idx = this.cleanups.indexOf(u);
        if (idx !== -1) this.cleanups.splice(idx, 1);
      }
      u?.();
      return (handler as (ctx: unknown) => void | Promise<void>)(ctx);
    }) as HandlerForSubjectDefinition<SubjectDefinition>;

    unsub = subject.$meta.isRequest
      ? this.registerRequestHandler(subject, key, onceHandler)
      : this.registerEventHandler(subject, key, onceHandler);

    this.cleanups.push(unsub);

    return (): void => {
      if (unsub) {
        const u = unsub;
        unsub = null;
        const idx = this.cleanups.indexOf(u);
        if (idx !== -1) this.cleanups.splice(idx, 1);
        u();
      }
    };
  }

  /**
   * Fire-and-forget encrypted event to the peer.
   * @param subject - Subject definition
   * @param payload - Event payload (will be encrypted before dispatch)
   */
  public async emit<Subject extends SubjectDefinition>(
    subject: Subject,
    payload: Subject['$meta']['payload'],
  ): Promise<void> {
    this.assertOpen();
    const key = this.requireKey();

    const channelSubject = makeChannelEventDef(this.channelId, subject.subject);
    const encrypted = await encrypt(key, JSON.stringify(payload), `${this.channelId}:${subject.subject}:evt`);

    await internalEmit(this.context, channelSubject, encrypted, {
      ...(this.transportNames ? { transports: [...this.transportNames] } : {}),
    });
  }

  /**
   * Encrypted request-response to the peer.
   * @param subject - Subject definition (must be a request subject)
   * @param payload - Request payload (will be encrypted before dispatch)
   * @param options - Request options (timeout, etc.)
   * @returns Decrypted response
   */
  public async request<Subject extends SubjectDefinition>(
    subject: Subject,
    payload: Subject['$meta']['payload']['request'],
    options?: { timeout?: number },
  ): Promise<Subject['$meta']['payload']['response']> {
    this.assertOpen();
    const key = this.requireKey();
    const controller = new AbortController();
    this.pendingRequests.add(controller);

    try {
      const channelSubject = makeChannelRequestDef(this.channelId, subject.subject);
      const encryptedRequest = await encrypt(key, JSON.stringify(payload), `${this.channelId}:${subject.subject}:req`);

      const encryptedResponse = await internalRequest(this.context, channelSubject, encryptedRequest, {
        signal: controller.signal,
        ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(this.transportNames ? { transports: [...this.transportNames] } : {}),
      });

      const decryptedJson = await decrypt(key, encryptedResponse, `${this.channelId}:${subject.subject}:res`);
      return JSON.parse(decryptedJson) as Subject['$meta']['payload']['response'];
    } finally {
      this.pendingRequests.delete(controller);
    }
  }

  /**
   * Encrypted request-response, returns `handled: false` instead of throwing `NoHandlerError`.
   * @param subject - Subject definition (must be a request subject)
   * @param payload - Request payload
   * @param options - Request options
   * @returns `OptionalResult` wrapping the response
   */
  public async requestOptional<Subject extends SubjectDefinition>(
    subject: Subject,
    payload: Subject['$meta']['payload']['request'],
    options?: { timeout?: number },
  ): Promise<OptionalResult<Subject['$meta']['payload']['response']>> {
    try {
      const data = await this.request(subject, payload, options);
      return { handled: true, data };
    } catch (e) {
      if (e instanceof NoHandlerError) {
        return { handled: false };
      }
      throw e;
    }
  }

  /** {@inheritDoc IDirectChannel.close} */
  public close(): void {
    if (this.closed) return;
    this.closed = true;

    // Best-effort: notify the peer. Errors are silently swallowed because the
    // channel is already being torn down — there is no meaningful recovery.
    const key = this.sharedKey;
    if (key) {
      const closeSubject = makeChannelEventDef(this.channelId, '$close');
      void encrypt(key, JSON.stringify({}), `${this.channelId}:$close:evt`)
        .then((encrypted) =>
          internalEmit(this.context, closeSubject, encrypted, {
            ...(this.transportNames ? { transports: [...this.transportNames] } : {}),
          }),
        )
        .catch(() => {
          // Best-effort — peer may already be gone.
        });
    }

    this.abortPendingRequests();
    this.runCleanups();
    this.sharedKey = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Assert the channel is open, throwing `ChannelClosedError` if not.
   */
  private assertOpen(): void {
    if (this.closed) {
      throw new ChannelClosedError(this.channelId);
    }
  }

  /**
   * Return the shared key.
   *
   * Safe to call only after `assertOpen()`, which guarantees the channel is not
   * closed. The key is nulled only after `this.closed` is set to `true`.
   * @returns The active shared CryptoKey
   */
  private requireKey(): CryptoKey {
    return this.sharedKey!;
  }

  /**
   * Register an encrypted event handler on the bus.
   *
   * The proxy handler decrypts the incoming `EncryptedPayload` before invoking
   * the user's handler with the plaintext payload.
   * @param subject - Original subject definition (used only for the subject key)
   * @param key - Shared AES-256-GCM key
   * @param handler - User-supplied event handler
   * @param options - On options forwarded to `internalOn`
   * @returns Unsubscribe function
   */
  private registerEventHandler(
    subject: SubjectDefinition,
    key: CryptoKey,
    handler: HandlerForSubjectDefinition<SubjectDefinition>,
    options?: OnOptions,
  ): () => void {
    const channelSubject = makeChannelEventDef(this.channelId, subject.subject);

    const aad = `${this.channelId}:${subject.subject}:evt`;
    const proxyHandler: HandlerForSubjectDefinition<typeof channelSubject> = async (ctx) => {
      const decryptedJson = await decrypt(key, ctx.payload, aad);
      const decryptedPayload = JSON.parse(decryptedJson) as unknown;
      return (handler as (ctx: { payload: unknown }) => void | Promise<void>)({
        ...ctx,
        payload: decryptedPayload,
      });
    };

    return internalOn(this.context, channelSubject, proxyHandler, options);
  }

  /**
   * Register an encrypted request handler on the bus.
   *
   * The proxy handler:
   * 1. Decrypts the incoming `EncryptedPayload` request.
   * 2. Invokes the user's handler with a capturing `setResult`.
   * 3. After the handler completes, encrypts the captured result and calls the
   *    original `setResult` so dispatch receives the encrypted response.
   *
   * Deferring encryption until after `await handler(ctx)` is safe because
   * `dispatch.ts` reads `hasResult` only after awaiting the proxy handler.
   * @param subject - Original subject definition (used only for the subject key)
   * @param key - Shared AES-256-GCM key
   * @param handler - User-supplied request handler
   * @param options - On options forwarded to `internalOn`
   * @returns Unsubscribe function
   */
  private registerRequestHandler(
    subject: SubjectDefinition,
    key: CryptoKey,
    handler: HandlerForSubjectDefinition<SubjectDefinition>,
    options?: OnOptions,
  ): () => void {
    const channelSubject = makeChannelRequestDef(this.channelId, subject.subject);

    const reqAad = `${this.channelId}:${subject.subject}:req`;
    const resAad = `${this.channelId}:${subject.subject}:res`;
    const proxyHandler: HandlerForSubjectDefinition<typeof channelSubject> = async (ctx) => {
      const decryptedJson = await decrypt(key, ctx.payload, reqAad);
      const decryptedPayload = JSON.parse(decryptedJson) as unknown;

      // Capture the plaintext result so we can encrypt it after the handler returns.
      let capturedResult: { value: unknown } | undefined;
      const capturingSetResult = (value: unknown): void => {
        capturedResult = { value };
      };
      const capturingExtendResult = (extension: unknown): void => {
        const base = capturedResult?.value ?? {};
        capturedResult = { value: { ...(base as Record<string, unknown>), ...(extension as Record<string, unknown>) } };
      };

      const wrappedNext = async (): Promise<void> => {
        const preNextCaptured = capturedResult;
        await ctx.next();
        // If the handler already set a result before next(), it stays
        // authoritative — matching normal dispatch semantics.
        if (preNextCaptured !== undefined) {
          capturedResult = preNextCaptured;
          return;
        }
        // Otherwise, decrypt the downstream encrypted response so the
        // handler sees plaintext via ctx.result and can extendResult on it.
        const downstream = ctx.result;
        if (downstream !== undefined) {
          const json = await decrypt(key, downstream as { iv: string; data: string }, resAad);
          capturedResult = { value: JSON.parse(json) as unknown };
        }
      };

      await (
        handler as (ctx: {
          payload: unknown;
          readonly result: unknown;
          setResult: (v: unknown) => void;
          extendResult: (v: unknown) => void;
          next: () => Promise<void>;
        }) => void | Promise<void>
      )({
        ...ctx,
        payload: decryptedPayload,
        get result() {
          return capturedResult?.value;
        },
        setResult: capturingSetResult,
        extendResult: capturingExtendResult,
        next: wrappedNext,
      });

      // After the handler completes, encrypt the captured result and forward it.
      // dispatch.ts reads hasResult/resultValue only after awaiting this proxy.
      if (capturedResult !== undefined) {
        const encryptedResult = await encrypt(key, JSON.stringify(capturedResult.value), resAad);
        ctx.setResult(encryptedResult);
      }
    };

    return internalOn(this.context, channelSubject, proxyHandler, options);
  }

  /**
   * Handle a peer-initiated close: tear down this side without sending
   * another `$close` (the peer already sent one).
   */
  private handlePeerClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortPendingRequests();
    this.runCleanups();
    this.sharedKey = null;
  }

  /**
   * Reject all in-flight requests with `ChannelClosedError`.
   */
  private abortPendingRequests(): void {
    const error = new ChannelClosedError(this.channelId);
    for (const controller of this.pendingRequests) {
      controller.abort(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Invoke all registered cleanup functions and clear the array.
   */
  private runCleanups(): void {
    for (const cleanup of this.cleanups) {
      try {
        cleanup();
      } catch {
        // Best-effort — teardown should not throw.
      }
    }
    this.cleanups.length = 0;
  }
}
