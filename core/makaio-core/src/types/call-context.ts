import { z } from 'zod';

import type { Party, PartyRef } from './party.js';
import { PartyRefSchema, PartySchema } from './party.js';

/**
 * Nominal stamp that blocks an object literal or a spread of a `CallContext`
 * at the type level.
 *
 * The private field gives the class a nominal identity: an object literal or a
 * spread of a `CallContext` lacks the private member and is rejected by the
 * compiler. The class is only declared, never emitted, so it has no runtime
 * constructor and nothing can instantiate it.
 *
 * The stamp is a compile-time property only: `Object.assign({}, ctx, { principal: other })`
 * and `structuredClone(ctx)` both produce a value whose shape still matches
 * `CallContext` and pass `tsc --strict` without a cast. The stamp does not
 * defend against either path; only the runtime check (the minted-context
 * `WeakSet` in `@makaio/bus-core`'s `call-context/mint.ts`, consulted by
 * `isMintedCallContext` / `assertCallCarrier`) rejects a value that was not
 * returned by `mintCallContext`.
 */
declare class CallContextStamp {
  private readonly stamped: true;
}

/**
 * Who is calling, on whose behalf, and who vouches for it.
 *
 * - `caller`: the party that sent the message.
 * - `principal`: the party the work is done for.
 * - `attestedBy`: the party that vouches for the claim, when someone does.
 *
 * Created by the core only: minting copies the fields, deep-freezes the result
 * and registers it in a `WeakSet`. The type rejects a literal or a spread, but
 * only that `WeakSet` membership (checked at the carrier boundary, not by the
 * type) rejects a value assembled another way, such as `Object.assign` or
 * `structuredClone` over a real context. Obtain one from `bus.own(purpose)` or
 * from the context of a handled message (`ctx.call`).
 */
export type CallContext = CallContextStamp & {
  readonly caller: Party;
  readonly principal: Party;
  readonly attestedBy?: Party;
};

/**
 * Purpose for which the bus hands out its own context via `bus.own(purpose)`.
 */
export type OwnWorkPurpose = 'start' | 'stop' | 'schedule' | 'observer' | 'shared-work' | 'root';

/**
 * Metadata that travels with a message between hosts.
 *
 * Carries only the declared principal as a `PartyRef`; claims never cross a
 * host boundary.
 */
export interface CrossHostMetadata {
  readonly principal?: PartyRef;
}

/**
 * Schema for `CrossHostMetadata`. Unknown keys are rejected; the receiver then
 * sets the verified caller as principal.
 */
export const CrossHostMetadataSchema = z.object({ principal: PartyRefSchema.optional() }).strict();

/**
 * Serialisable record of a call context, for outputs on the bus and stored rows.
 *
 * A `CallContext` is nominal and does not travel over the bus. Where a context
 * has to be shown in an output or a stored row, this plain record takes its
 * place. It is data only and proves nothing: no operation accepts a record in
 * place of a `CallContext`.
 */
export interface CallContextRecord {
  readonly caller: Party;
  readonly principal: Party;
  readonly attestedBy?: Party;
}

/**
 * Schema for `CallContextRecord`. Unknown keys are rejected.
 */
export const CallContextRecordSchema = z
  .object({ caller: PartySchema, principal: PartySchema, attestedBy: PartySchema.optional() })
  .strict();
