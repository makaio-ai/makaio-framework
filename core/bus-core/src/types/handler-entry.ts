import type { PartyRef } from '@makaio/core';

/**
 * Handler entry with priority for middleware-style ordering.
 * Higher priority values run earlier in the handler chain.
 */
export interface HandlerEntry<H> {
  handler: H;
  priority: number;
  /** Party that registered the handler: the carrier of the bus instance `on` was called on. */
  owner: PartyRef;
}
