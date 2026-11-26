import type { UnknownRecord } from 'type-fest';

import type { CallContext } from './call-context.js';
import type { Party } from './party.js';

/**
 * Connection facts of a received message, without any identity.
 *
 * Who sent the message is carried by {@link TransportReceiveContext.caller}
 * and, once the core has stamped it, by `BaseMessageContext.call`.
 */
export interface TransportConnectionInfo {
  /** Registered bus transport name that received the message. */
  readonly transportName: string;
  /** Optional connection/session identifier local to the transport. */
  readonly connectionId?: string;
  /** Whether the receiving transport authenticated the connection. */
  readonly authenticated?: boolean;
  /** Whether the receiving transport established encrypted payload transport. */
  readonly encrypted?: boolean;
}

/** Direction, relative to this host, of a connection trusted to attest principal claims. */
export type ConnectionAttestation = 'inbound' | 'outbound';

/** Connection roles authorized to attest principal claims, with their receive direction. */
export const ATTESTING_CONNECTION_ROLES = {
  /** Trusted client uplink to the core host. */
  'core-uplink': 'outbound',
  /** Authenticated workflow job run connected to the core host. */
  'job-run': 'inbound',
  /** Authenticated local CLI connected to the core host. */
  'local-cli': 'inbound',
} as const satisfies Record<string, ConnectionAttestation>;

/** Role of a connection authorized to attest principal claims. */
export type AttestingConnectionRole = keyof typeof ATTESTING_CONNECTION_ROLES;

/**
 * Look up the attestation granted to a configured connection role.
 * @param role - The configured connection role.
 * @returns The attestation direction, or undefined for an unrecognized role.
 */
export function attestationForRole(role: string): ConnectionAttestation | undefined {
  return Object.hasOwn(ATTESTING_CONNECTION_ROLES, role)
    ? ATTESTING_CONNECTION_ROLES[role as AttestingConnectionRole]
    : undefined;
}

type AttestingRoleIn<Direction extends ConnectionAttestation> = {
  [Role in AttestingConnectionRole]: (typeof ATTESTING_CONNECTION_ROLES)[Role] extends Direction ? Role : never;
}[AttestingConnectionRole];

/** Attesting roles for connections accepted by the core host. */
export type InboundAttestingConnectionRole = AttestingRoleIn<'inbound'>;

/** Attesting roles for connections to the core host. */
export type OutboundAttestingConnectionRole = AttestingRoleIn<'outbound'>;

/** A locally issued handle for the response route of one inbound request. */
export interface TransportRequestOrigin {
  readonly correlationId: string;
}

/**
 * Trusted context derived locally by the receiving transport.
 *
 * This context is never serialized into `BusMessage`; each receiving node must
 * derive its own context from its own transport/session state.
 */
export interface TransportReceiveContext extends TransportConnectionInfo {
  /** Response route owned by this request, when the transport provides one. */
  readonly requestOrigin?: TransportRequestOrigin;
  /**
   * Caller verified or declared by the transport.
   *
   * When absent, the core uses the transport's declared caller or assigns the anonymous caller.
   */
  readonly caller?: Party;
  /** Direction of an attesting connection. Omit when the connection cannot attest principal claims. */
  readonly attests?: ConnectionAttestation;
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
   * Undefined for an in-process send. Read the stamped sender identity from
   * `call`. Ignore similarly named fields in payloads and wire messages.
   */
  transport?: TransportReceiveContext;

  /**
   * Call context of the handled message: `caller` is the sender, plus
   * `principal` and `attestedBy`.
   */
  readonly call: CallContext;

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
