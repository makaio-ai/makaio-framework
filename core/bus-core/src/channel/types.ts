import type { OnOptions } from '../types/index.js';
import type { SubjectDefinition, HandlerForSubjectDefinition, OptionalResult } from '@makaio/core';

/**
 * Encrypted point-to-point communication channel over the bus.
 *
 * Provides a bus-compatible interface (on, once, emit, request) where all
 * payloads are encrypted with a shared AES-256-GCM key derived via ECDH.
 * Observers, middleware, and transport loggers only see opaque `{ iv, data }` payloads.
 * Channel messages ride the normal bus transport layer unless the caller
 * explicitly constrains routing via the underlying bus configuration.
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
   * @param subject - Subject definition
   * @param payload - Event payload (will be encrypted before dispatch)
   */
  emit<Subject extends SubjectDefinition>(subject: Subject, payload: Subject['$meta']['payload']): Promise<void>;

  /**
   * Encrypted request-response to the peer.
   * @param subject - Subject definition (must be a request subject)
   * @param payload - Request payload (will be encrypted before dispatch)
   * @param options - Request options (timeout, etc.)
   * @returns Decrypted response
   * @throws \{ChannelClosedError\} If the channel is closed
   * @throws \{NoHandlerError\} If the peer has no handler for this subject
   */
  request<Subject extends SubjectDefinition>(
    subject: Subject,
    payload: Subject['$meta']['payload']['request'],
    options?: { timeout?: number },
  ): Promise<Subject['$meta']['payload']['response']>;

  /**
   * Encrypted request-response, returns `handled: false` instead of throwing NoHandlerError.
   * @param subject - Subject definition (must be a request subject)
   * @param payload - Request payload
   * @param options - Request options
   * @returns OptionalResult wrapping the response
   */
  requestOptional<Subject extends SubjectDefinition>(
    subject: Subject,
    payload: Subject['$meta']['payload']['request'],
    options?: { timeout?: number },
  ): Promise<OptionalResult<Subject['$meta']['payload']['response']>>;

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
