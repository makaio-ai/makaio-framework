import type { CallContext, PartyRef } from '@makaio/core';
import { deriveSent } from './carrier.js';
import { ownCarrierOf, ownPurposeOf } from './mint.js';
import { noteOwnContextSend } from './own-work.js';

/**
 * The single entry every application send passes on its way into the kernel.
 *
 * Turns the context the sender passed into the context the message carries
 * (`deriveSent`: the carrier is the caller, principal and attestation come from
 * `call`) and, when `call` is an own context (with or without purpose), reports
 * the send to the own-work report. A rejected call is never reported.
 *
 * Send surfaces (`request`, `emit`, `broadcast` and anything that sends on
 * behalf of a carrier) must call this instead of deriving themselves, so that
 * derivation and the report exist exactly once. The receive path does not call
 * it: a context of a message that was already received is minted by its
 * transport and is not a send.
 * @param call - Call context the sender passed
 * @param context - Shared bus context of the sending instance
 * @param carrier - Carrier of the sending bus instance
 * @param subject - Fully-qualified subject of the send
 * @returns The context the message carries, with `caller` set to the carrier
 * @throws InvalidCallContextError When `call` was not minted by the core
 * @throws ForeignOwnContextError When `call` belongs to another carrier or bus context
 */
export function enterSend(call: CallContext, context: object, carrier: PartyRef, subject: string): CallContext {
  const sent = deriveSent(call, context, carrier);
  if (ownCarrierOf(call) !== undefined) {
    noteOwnContextSend(carrier, ownPurposeOf(call), subject);
  }
  return sent;
}
