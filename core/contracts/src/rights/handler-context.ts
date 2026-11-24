import type { CallContext, JsonValue } from '@makaio/core';
import type { RightAnswer, RightName } from './right.js';

/**
 * Context a handler serving one message gets to ask about rights of its own
 * caller, bound to the `call` the handler received: "may the caller of this
 * message do X with this object".
 *
 * Built from a message's own `context.call` (never minted fresh), so
 * `hasRight` resolves through the exact same call the handler is serving,
 * never a second path over the bus.
 */
export interface HandlerContext {
  /** Context of the call the handler received; the call `hasRight` resolves with. */
  readonly call: CallContext;

  /**
   * Resolves whether the caller of `call` holds `right` in `context`, through
   * the one place that resolves a right.
   * @param right - The right that is asked about.
   * @param context - Context of the question; it follows the JSON schema of the right.
   * @returns The combined answer.
   */
  hasRight(right: RightName, context: JsonValue): Promise<RightAnswer>;
}
