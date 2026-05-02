/**
 * Relay control envelope helpers.
 *
 * Control envelopes carry relay-owned bus events before or alongside
 * the E2E session handshake. They are authenticated by the transport
 * channel but are not encrypted.
 *
 * Use {@link createRelayControlHelpers} to obtain the three helper functions
 * with a specific {@link RelayControlRegistry} captured in their closure.
 * The registry determines which namespace/subject pairs are classified as
 * control-plane (plaintext) traffic.
 */

import type { BusEventMessage, BusRequestMessage } from '@makaio/bus-core';
import type { RelayControlRegistry } from './relay-control-registry.js';

/**
 * Relay control envelope message shape used on the wire.
 */
export interface RelayControlEnvelopeMessage {
  type: 'relay-control';
  payload: RelayControlBusMessage;
  v: 1;
}

/** Bus message type that may be wrapped in a relay control envelope. */
export type RelayControlBusMessage = BusEventMessage | BusRequestMessage;

/**
 * Return value of {@link createRelayControlHelpers}.
 *
 * All three helpers share the same {@link RelayControlRegistry} captured in
 * their common closure.
 */
export interface RelayControlHelpers {
  /**
   * Create a relay control envelope for a relay-owned bus message.
   *
   * Throws when the message is not classified as a control message by the
   * registry (i.e. would not pass {@link isRelayControlBusMessage}).
   * @param message - Relay bus message to wrap
   * @returns Relay control envelope message
   */
  createRelayControlEnvelope(message: RelayControlBusMessage): RelayControlEnvelopeMessage;

  /**
   * Check whether a parsed wire value is a relay control envelope.
   * @param message - Parsed message candidate
   * @returns `true` if the value is a relay control envelope
   */
  isRelayControlEnvelopeMessage(message: unknown): message is RelayControlEnvelopeMessage;

  /**
   * Check whether a bus message is a relay control event or request.
   * @param message - Bus message candidate
   * @returns `true` when the message is classified as a relay control message
   */
  isRelayControlBusMessage(message: unknown): message is RelayControlBusMessage;
}

interface BusMessageCandidate {
  type?: unknown;
  subject?: unknown;
  namespace?: unknown;
  payload?: unknown;
  messageId?: unknown;
  correlationId?: unknown;
}

/**
 * Create relay control envelope helpers bound to a specific registry.
 *
 * The registry must be {@link RelayControlRegistry.freeze | frozen} before
 * calling this function — or at minimum before the transport begins
 * processing messages — so the security invariant (no post-handshake
 * plaintext injection) is upheld.
 * @param registry - Frozen relay control registry
 * @returns Helper functions with the registry captured in their closure
 */
export function createRelayControlHelpers(registry: RelayControlRegistry): RelayControlHelpers {
  const assertFrozen = (): void => {
    if (!registry.isFrozen()) {
      throw new Error('RelayControlRegistry must be frozen before processing relay control messages');
    }
  };

  /**
   * Check whether a bus message candidate is a valid relay control event.
   * @param candidate - Untyped message candidate
   * @returns `true` when the candidate is a relay control event
   */
  function isControlEventMessage(candidate: BusMessageCandidate): boolean {
    if (typeof candidate.namespace !== 'string' || typeof candidate.subject !== 'string') {
      return false;
    }
    if (!registry.isControlEvent(candidate.namespace, candidate.subject)) {
      return false;
    }
    if (typeof candidate.messageId !== 'string') {
      return false;
    }
    return candidate.payload !== undefined;
  }

  /**
   * Check whether a bus message candidate is a valid relay control request.
   * @param candidate - Untyped message candidate
   * @returns `true` when the candidate is a relay control request
   */
  function isControlRequestMessage(candidate: BusMessageCandidate): boolean {
    if (typeof candidate.namespace !== 'string' || typeof candidate.subject !== 'string') {
      return false;
    }
    if (!registry.isControlRequest(candidate.namespace, candidate.subject)) {
      return false;
    }
    if (typeof candidate.messageId !== 'string') {
      return false;
    }
    if (typeof candidate.correlationId !== 'string') {
      return false;
    }
    return candidate.payload !== undefined;
  }

  /**
   * Check whether a parsed value is a relay control bus message (event or request).
   * @param message - Parsed message candidate
   * @returns `true` when the value is a relay control event or request
   */
  function isRelayControlBusMessage(message: unknown): message is RelayControlBusMessage {
    assertFrozen();
    if (!message || typeof message !== 'object') {
      return false;
    }

    const candidate = message as BusMessageCandidate;

    if (candidate.type === 'event') {
      return isControlEventMessage(candidate);
    }

    if (candidate.type === 'request') {
      return isControlRequestMessage(candidate);
    }

    return false;
  }

  /**
   * Check whether a parsed wire value is a relay control envelope.
   * @param message - Parsed message candidate
   * @returns `true` when the value is a relay control envelope message
   */
  function isRelayControlEnvelopeMessage(message: unknown): message is RelayControlEnvelopeMessage {
    assertFrozen();
    if (!message || typeof message !== 'object') {
      return false;
    }

    const candidate = message as { type?: unknown; payload?: unknown; v?: unknown };
    if (
      candidate.type !== 'relay-control' ||
      candidate.v !== 1 ||
      !candidate.payload ||
      typeof candidate.payload !== 'object'
    ) {
      return false;
    }

    return isRelayControlBusMessage(candidate.payload);
  }

  /**
   * Create a relay control envelope for a relay-owned bus message.
   * @param message - Relay bus message to wrap
   * @returns Relay control envelope message
   */
  function createRelayControlEnvelope(message: RelayControlBusMessage): RelayControlEnvelopeMessage {
    assertFrozen();
    if (!isRelayControlBusMessage(message)) {
      throw new Error('Invalid relay control message');
    }

    return {
      type: 'relay-control',
      v: 1,
      payload: message,
    };
  }

  return {
    createRelayControlEnvelope,
    isRelayControlEnvelopeMessage,
    isRelayControlBusMessage,
  };
}
