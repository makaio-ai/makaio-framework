import type { OnOptions } from '../types/index.js';
import type {
  CallContext,
  SubjectDefinition,
  HandlerForSubjectDefinition,
  OptionalResult,
  WildcardSubject,
} from '@makaio/core';

/**
 * Encrypted point-to-point communication channel over the bus.
 *
 * Provides a bus-compatible interface (on, once, emit, request) where all
 * payloads are encrypted with a shared AES-256-GCM key derived via ECDH.
 * Observers, middleware, and transport loggers only see opaque `{ iv, data }` payloads.
 * Channel messages ride the normal bus transport layer unless the caller
 * explicitly constrains routing via the underlying bus configuration.
 *
 * A channel belongs to the carrier of the bus instance that opened it. Every send
 * (`emit`, `request`, `requestOptional`) has the two forms of the bus sends: with the
 * call context of a handled message first (principal and attestation of `call`), or
 * without one (the carrier sends for itself). The caller is always that carrier.
 */
export interface IDirectChannel {
  /** Unique channel identifier (used in channel-scoped subject namespaces). */
  readonly channelId: string;

  /**
   * Register an event or request handler on this channel.
   * The handler receives decrypted payloads — encryption is transparent.
   * @param subject - Subject definition (channel or non-channel subjects both accepted)
   * @param handler - Handler function matching the subject's schema
   * @param options - Handler options (priority, etc.)
   * @returns Unsubscribe function
   */
  on<Subject extends SubjectDefinition>(
    subject: Subject,
    handler: HandlerForSubjectDefinition<Subject>,
    options?: OnOptions,
  ): () => void;

  /**
   * Register a one-time handler that auto-unsubscribes after first invocation.
   * @param subject - Subject definition
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  once<Subject extends SubjectDefinition>(subject: Subject, handler: HandlerForSubjectDefinition<Subject>): () => void;

  /**
   * Fire-and-forget encrypted event to the peer.
   *
   * Takes no emit options, unlike the namespace-scoped bus wrappers. A channel
   * is not a view onto a subject a caller could otherwise emit itself: it
   * re-subjects the payload onto its own channel subject and routes it to the
   * transports the channel was opened over. Routing therefore belongs to the
   * channel, and an option bag that could override it would let a caller send a
   * peer-encrypted payload somewhere the peer is not.
   *
   * Accepts event subjects only (no request and no wildcard subjects). Channel subjects stay usable.
   *
   * Two forms: call form `(call, subject, payload)` for a handled message (principal and
   * attestation come from `call`, the caller is the channel's carrier), own form
   * `(subject, payload)` when the carrier sends for itself.
   * @param call - Call context of the send: the `ctx.call` of the message being handled
   * @param subject - Subject definition
   * @param payload - Event payload (will be encrypted before dispatch)
   */
  emit<
    Subject extends SubjectDefinition,
    IsRequest = Subject['$meta']['isRequest'],
    IsWildcard = Subject['subject'] extends WildcardSubject ? true : false,
  >(
    call: CallContext,
    subject: IsRequest extends false ? (IsWildcard extends false ? Subject : never) : never,
    payload: Subject['$meta']['payload'],
  ): Promise<void>;
  /**
   * Own form of {@link IDirectChannel.emit}: the carrier of the channel sends for itself.
   * @param subject - Subject definition
   * @param payload - Event payload (will be encrypted before dispatch)
   */
  emit<
    Subject extends SubjectDefinition,
    IsRequest = Subject['$meta']['isRequest'],
    IsWildcard = Subject['subject'] extends WildcardSubject ? true : false,
  >(
    subject: IsRequest extends false ? (IsWildcard extends false ? Subject : never) : never,
    payload: Subject['$meta']['payload'],
  ): Promise<void>;

  /**
   * Encrypted request-response to the peer.
   *
   * Two forms: call form `(call, subject, payload, options?)` for a handled message,
   * own form `(subject, payload, options?)` when the carrier sends for itself.
   * @param call - Call context of the send: the `ctx.call` of the message being handled
   * @param subject - Subject definition (must be a request subject)
   * @param payload - Request payload (will be encrypted before dispatch)
   * @param options - Request options (timeout, etc.)
   * @returns Decrypted response
   * @throws \{ChannelClosedError\} If the channel is closed
   * @throws \{NoHandlerError\} If the peer has no handler for this subject
   */
  request<Subject extends SubjectDefinition, IsRequest = Subject['$meta']['isRequest']>(
    call: CallContext,
    subject: IsRequest extends true ? Subject : never,
    payload: Subject['$meta']['payload']['request'],
    options?: { timeout?: number },
  ): Promise<IsRequest extends true ? Subject['$meta']['payload']['response'] : never>;
  /**
   * Own form of {@link IDirectChannel.request}: the carrier of the channel sends for itself.
   * @param subject - Subject definition (must be a request subject)
   * @param payload - Request payload (will be encrypted before dispatch)
   * @param options - Request options (timeout, etc.)
   * @returns Decrypted response
   * @throws \{ChannelClosedError\} If the channel is closed
   * @throws \{NoHandlerError\} If the peer has no handler for this subject
   */
  request<Subject extends SubjectDefinition, IsRequest = Subject['$meta']['isRequest']>(
    subject: IsRequest extends true ? Subject : never,
    payload: Subject['$meta']['payload']['request'],
    options?: { timeout?: number },
  ): Promise<IsRequest extends true ? Subject['$meta']['payload']['response'] : never>;

  /**
   * Encrypted request-response, returns `handled: false` instead of throwing NoHandlerError.
   *
   * Two forms, as {@link IDirectChannel.request}.
   * @param call - Call context of the send: the `ctx.call` of the message being handled
   * @param subject - Subject definition (must be a request subject)
   * @param payload - Request payload
   * @param options - Request options
   * @returns OptionalResult wrapping the response
   */
  requestOptional<Subject extends SubjectDefinition, IsRequest = Subject['$meta']['isRequest']>(
    call: CallContext,
    subject: IsRequest extends true ? Subject : never,
    payload: Subject['$meta']['payload']['request'],
    options?: { timeout?: number },
  ): Promise<OptionalResult<IsRequest extends true ? Subject['$meta']['payload']['response'] : never>>;
  /**
   * Own form of {@link IDirectChannel.requestOptional}: the carrier of the channel sends for itself.
   * @param subject - Subject definition (must be a request subject)
   * @param payload - Request payload
   * @param options - Request options
   * @returns OptionalResult wrapping the response
   */
  requestOptional<Subject extends SubjectDefinition, IsRequest = Subject['$meta']['isRequest']>(
    subject: IsRequest extends true ? Subject : never,
    payload: Subject['$meta']['payload']['request'],
    options?: { timeout?: number },
  ): Promise<OptionalResult<IsRequest extends true ? Subject['$meta']['payload']['response'] : never>>;

  /**
   * Close the channel. Notifies peer, rejects pending requests,
   * unsubscribes all handlers, and discards the shared encryption key.
   */
  close(): void;
}

/**
 * Options for creating a channel endpoint.
 */
export interface ChannelEndpointOptions {
  /** Capability token that clients must present to open this channel. */
  token: string;
}

/**
 * A registered channel endpoint that accepts incoming connections.
 */
export interface ChannelEndpoint {
  /** The endpoint name (e.g., 'credentials'). */
  readonly name: string;
  /** The capability token clients need to open this channel. */
  readonly token: string;
  /** Unregister the endpoint, preventing new connections. */
  close(): void;
}
