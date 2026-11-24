import type { CallContext, OwnWorkPurpose, Party, PartyRef } from '@makaio/core';
import { BusError } from '../errors/bus-error.js';
import { assertMintedCallContext, mintCallContext, ownBusContextOf, ownCarrierOf } from './mint.js';

/**
 * Thrown when an own context (`bus.own`) is used through a bus instance, or
 * handed to a process-local operation, whose bus context or carrier differs
 * from the one it was minted for.
 *
 * The message names both carriers (kind and id), never claims.
 */
export class ForeignOwnContextError extends BusError {}

/** Host party of each bus context; one party per context, minted on first use. */
const hostParties = new WeakMap<object, PartyRef>();

/** Own contexts by bus context, then carrier and purpose. */
const ownContexts = new WeakMap<object, Map<string, CallContext>>();

/**
 * The host party a bus context belongs to.
 *
 * Minted once per context with a fresh id, so a freshly built bus context is a
 * carrier of its own and never shares the party of the running host.
 * @param context - The shared bus context (the key of the party).
 * @returns The party of kind `makaio.host` for `context`; it never carries claims.
 */
export function hostPartyOf(context: object): PartyRef {
  const known = hostParties.get(context);
  if (known !== undefined) return known;
  const party: PartyRef = Object.freeze({ kind: 'makaio.host', id: crypto.randomUUID() });
  hostParties.set(context, party);
  return party;
}

/**
 * Whether two carriers are the same party.
 * @param a - First carrier.
 * @param b - Second carrier.
 * @returns `true` for equal kind and id.
 */
function sameCarrier(a: PartyRef, b: PartyRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Describe a carrier for an error message.
 * @param carrier - The carrier.
 * @returns `kind:id`.
 */
function describeCarrier(carrier: PartyRef): string {
  return `${carrier.kind}:${carrier.id}`;
}

/**
 * The own context of a carrier for a purpose (`bus.own(purpose)`).
 *
 * Caller and principal are the carrier itself. Only that carrier on the same
 * bus context can send it.
 * @param context - The shared bus context of the sending instance.
 * @param carrier - The carrier of the bus instance.
 * @param purpose - Why the carrier acts on its own, omitted for implicit work.
 * @returns The registered own context.
 */
export function own(context: object, carrier: PartyRef, purpose?: OwnWorkPurpose): CallContext {
  let cache = ownContexts.get(context);
  if (cache === undefined) {
    cache = new Map();
    ownContexts.set(context, cache);
  }
  const key = JSON.stringify([carrier.kind, carrier.id, purpose]);
  const known = cache.get(key);
  if (known !== undefined) return known;
  const party: Party = { kind: carrier.kind, id: carrier.id };
  const minted = mintCallContext({ caller: party, principal: party }, { carrier, context, purpose });
  cache.set(key, minted);
  return minted;
}

/**
 * The own context a send without a call context carries.
 *
 * Caller and principal are the carrier itself, like {@link own}. The absent
 * purpose has its own cache entry, separate from every explicit purpose.
 * @param context - The shared bus context of the sending instance.
 * @param carrier - The carrier of the sending bus instance.
 * @returns The registered own context of the carrier without a purpose.
 */
export function implicitOwn(context: object, carrier: PartyRef): CallContext {
  return own(context, carrier);
}

/**
 * Check that `call` may be used by `carrier`.
 *
 * An own context belongs to its carrier and bus context; a received
 * `ctx.call` has no such record and may be passed on by anyone.
 * @param call - The context about to be used.
 * @param carrier - The carrier that uses it.
 * @param context - The shared bus context of that carrier.
 * @throws InvalidCallContextError When `call` was not minted by the core.
 * @throws ForeignOwnContextError When `call` belongs to another carrier or bus context.
 */
export function assertCallCarrier(call: CallContext, carrier: PartyRef, context: object): void {
  assertMintedCallContext(call);
  const owner = ownCarrierOf(call);
  if (owner !== undefined && (!sameCarrier(owner, carrier) || ownBusContextOf(call) !== context)) {
    throw new ForeignOwnContextError(
      `Own call context of ${describeCarrier(owner)} used by ${describeCarrier(carrier)}`,
    );
  }
}

/**
 * Derive the context a send carries: the carrier is the caller, principal and
 * attestation come from `call`. The caller of `call` is never read.
 * @param call - The context the sender passed.
 * @param context - The shared bus context of the sending instance.
 * @param carrier - The carrier of the sending bus instance.
 * @returns A newly minted context with `caller` set to the carrier.
 * @throws InvalidCallContextError When `call` was not minted by the core.
 * @throws ForeignOwnContextError When `call` belongs to another carrier or bus context.
 */
export function deriveSent(call: CallContext, context: object, carrier: PartyRef): CallContext {
  assertCallCarrier(call, carrier, context);
  return mintCallContext({
    caller: { kind: carrier.kind, id: carrier.id },
    principal: call.principal,
    ...(call.attestedBy === undefined ? {} : { attestedBy: call.attestedBy }),
  });
}
