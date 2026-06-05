import type { UnknownRecord } from 'type-fest';

/**
 * Host-agnostic principal attached by a trusted local transport.
 *
 * The framework treats this as opaque metadata. Host code decides what
 * principal kinds and claims mean.
 */
export interface PrincipalContext {
  /** Principal kind, such as `user`, `device`, `machine`, or host-defined values. */
  readonly kind: string;
  /** Optional stable principal identifier in the principal namespace. */
  readonly id?: string;
  /** Optional opaque claims supplied by the authenticating transport or host policy. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * Authenticated peer metadata supplied by a transport connection.
 */
export interface TransportPeerContext {
  /** Peer kind, such as `browser`, `machine`, `worker`, or host-defined values. */
  readonly kind: string;
  /** Optional transport-level peer identifier. */
  readonly id?: string;
  /** Whether the receiving transport authenticated the peer. */
  readonly authenticated?: boolean;
  /** Whether the receiving transport established encrypted payload transport. */
  readonly encrypted?: boolean;
  /** Optional opaque peer claims. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * Trusted context derived locally by the receiving transport.
 *
 * This context is never serialized into `BusMessage`; each receiving node must
 * derive its own context from its own transport/session state.
 */
export interface TransportReceiveContext {
  /** Registered bus transport name that received the message. */
  readonly transportName: string;
  /** Optional connection/session identifier local to the transport. */
  readonly connectionId?: string;
  /** Optional authenticated transport peer. */
  readonly peer?: TransportPeerContext;
  /** Optional host-agnostic principal resolved for this connection. */
  readonly principal?: PrincipalContext;
}

/**
 * Describes the call origin of a bus message.
 *
 * Set on every context before handlers run; never serialized to wire.
 * Derivation: `local` is `true` when no transport received the message
 * (the call originated in this process), `false` when it arrived over
 * a transport from a remote peer.
 */
export interface MessageOrigin {
  /** Whether the message originated locally (not from a remote transport). */
  readonly local: boolean;
}

/**
 * Base message context interface for both events and requests.
 *
 * Provides common metadata for tracking and correlation:
 * - `messageId`: Unique identifier for this specific message
 * - `correlationId`: Optional identifier linking related operations
 */
export interface BaseMessageContext {
  /**
   * Unique identifier for this specific message.
   * Auto-generated if not provided.
   *
   * Used for:
   * - Message deduplication
   * - Idempotency checks
   * - Tracking individual messages in logs
   */
  messageId: string;

  /**
   * Optional identifier linking related operations.
   * Propagated through chains of requests/events.
   *
   * Used for:
   * - Distributed tracing
   * - Causality tracking
   * - Following a workflow through the system
   * @example
   * ```typescript
   * // Initial request generates correlationId
   * const result = await request(
   *   UserSubjects.getUser,
   *   { userId: '42' },
   *   { correlationId: 'user-action-123' }
   * );
   *
   * // Handler propagates correlationId to downstream operations
   * await emit(
   *   UserSubjects.userLoaded,
   *   { user: result },
   *   { correlationId: context.correlationId }
   * );
   * ```
   */
  correlationId?: string;

  /**
   * Trusted context supplied by the local receiving transport.
   *
   * Undefined for local calls and for transports that do not supply connection
   * context. Never trust similarly named fields in payloads or wire messages.
   */
  transport?: TransportReceiveContext;

  /**
   * Where this message originated.
   *
   * `local: true` — emitted in this process.
   * `local: false` — arrived via a transport from a remote caller.
   *
   * Always present; never serialized to the wire. Location-sensitive handlers
   * check this before executing local side-effects.
   */
  origin: MessageOrigin;

  isRequest: boolean;
}

export type EventMessagePayload<Payload extends UnknownRecord = UnknownRecord> = Payload & {
  request?: never;
  response?: never;
};

export type RequestMessagePayload<
  Request extends UnknownRecord = UnknownRecord,
  Response extends UnknownRecord = UnknownRecord,
> = {
  request: Request;
  response: Response;
};

export type MessagePayload = RequestMessagePayload | EventMessagePayload;
