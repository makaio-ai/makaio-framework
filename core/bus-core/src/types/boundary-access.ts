import type { CallContext, JsonValue, TransportReceiveContext } from '@makaio/core';

/** Subject operation at an external transport boundary. */
export type BoundaryAccessTarget =
  | {
      readonly operation: 'subscribe' | 'register-handler';
      readonly pattern: string;
      /** Allow deferral for unavailable subjects. Reconnect replay may also wait for startup. */
      readonly defer?: 'replay' | 'unavailable';
    }
  | {
      readonly operation: 'send' | 'deliver' | 'handle';
      readonly messageType: 'request' | 'event' | 'broadcast';
      readonly namespace: string;
      readonly subject: string;
      readonly payload?: JsonValue;
    };

/** Host policy for operations using the context minted by the transport. */
export interface BoundaryAccessCheck {
  /**
   * @param target - The actual subject or requested subscription pattern.
   * @param call - The sending call or the subscriber's bound call for delivery.
   * @param connection - Trusted connection identity, when available.
   * @returns A denial, `SUBSCRIPTION_DEFERRED` for a pattern awaiting availability, or undefined when allowed.
   */
  (
    target: BoundaryAccessTarget,
    call: CallContext,
    connection: TransportReceiveContext | undefined,
  ): Promise<Error | typeof SUBSCRIPTION_DEFERRED | undefined>;

  /**
   * Notify the transport when deferred patterns may now be available.
   * @param retry - Schedule another full boundary check.
   * @returns Remove the notification listener.
   */
  watchSubscriptionAvailability?(retry: () => Promise<void>): () => void;

  /**
   * Publish a local diagnostic for a reply the transport discarded.
   * @param call - Call minted from the reply socket, without frame metadata.
   * @param reason - Transport's reason for discarding the reply.
   */
  reportRejectedReply?(call: CallContext, reason: string): void;
}

/** The pattern can be rechecked when availability changes. It is not yet admitted. */
export const SUBSCRIPTION_DEFERRED: unique symbol = Symbol('SUBSCRIPTION_DEFERRED');

/** Explicitly run an external transport without a boundary access check. */
export const NO_BOUNDARY_ACCESS_CHECK = Symbol('NO_BOUNDARY_ACCESS_CHECK');

/** Required decision to enforce host policy or opt out of boundary checks. */
export type BoundaryAccessPolicy = BoundaryAccessCheck | typeof NO_BOUNDARY_ACCESS_CHECK;
