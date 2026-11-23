import type { PartyRef, TransportReceiveContext } from '@makaio/core';

/**
 * Production-capable observation record for local bus API entrypoints.
 *
 * Unlike `AnyMessageContext`, this is not debug-only and is safe for runtime
 * services that need to derive sanitized telemetry.
 */
export interface ObservedBusMessage {
  readonly type: 'event' | 'request' | 'broadcast';
  readonly subject: string;
  readonly namespace: string;
  readonly payload: unknown;
  readonly messageId: string;
  readonly correlationId?: string;
  readonly transport?: TransportReceiveContext;
  /** Sender of the observed message (the call context's caller, identity only). */
  readonly caller: PartyRef;
  /** Party on whose behalf the message was sent (the call context's principal, identity only). */
  readonly principal: PartyRef;
  /** True when the originating bus call was explicitly or inherently local-only. */
  readonly localOnly?: boolean;
}

/**
 * Observer callback invoked for each local bus API message after validation
 * has succeeded. Observers must not mutate the payload.
 */
export type BusMessageObserver = (message: ObservedBusMessage) => void | Promise<void>;
