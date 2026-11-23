/**
 * Kernel entry of `@makaio/bus-core`.
 *
 * This file names the functions that mint, carry, and check call contexts and that
 * build bus instances around a shared context. It is for the kernel and composition
 * code of the framework only: `bus-core` itself, the kernel package, transports,
 * runtime boot code, test utilities, and the composition roots of an application.
 * Extension code must not import it. A lint rule added later in this package enforces
 * that boundary; until then the boundary is convention. The public index
 * (`./index.ts`) deliberately carries none of these names.
 *
 * The groups below are the one fixed list of kernel names. A name belongs here when
 * calling it can create or change who a message is attributed to, or when it hands out
 * a bus that bypasses the carrier binding of the public API.
 *
 * Note on `createBusInstance({ context })`: the `context` option of the public
 * `createBusInstance` is a kernel capability too. It cannot be exported under a name of
 * its own, so extension code must not pass it either; the same lint rule covers it.
 * The context itself comes from `createBusContext` below.
 *
 * Internal to `bus-core` and intentionally not listed: `buildBusInstance`, `enterSend`,
 * `deriveSent`, `own` (carrier-level), and the `methods/*` entry points.
 */

/**
 * Minting and inspecting call contexts.
 *
 * - `mintCallContext` is the only way to create a call context from a caller and a
 *   principal; everything the kernel accepts as a call must come from it.
 * - `ownCarrierOf` reads the carrier an own context was minted for, so the kernel can
 *   reject an own context that is passed along by a foreign carrier.
 */
export { mintCallContext, ownCarrierOf } from './call-context/mint.js';

/**
 * Carrier binding.
 *
 * - `hostPartyOf` yields the party that stands for the host of a bus context, the
 *   carrier of the root bus.
 * - `assertCallCarrier` checks that a call may be sent by a given carrier: it must be
 *   minted, and an own context must belong to that carrier.
 */
export { assertCallCarrier, hostPartyOf } from './call-context/carrier.js';

/**
 * Receiving from the wire.
 *
 * - `callFromReceive` builds the call context of an incoming message from the
 *   transport's receive context, its declared caller, and the wire metadata. It is the
 *   single place where a remote claim of identity is accepted or downgraded.
 */
export { callFromReceive } from './call-context/wire.js';

/**
 * Bus instances bound to a carrier.
 *
 * - `createCarrierBus` derives a bus for another carrier that shares context and
 *   transport state with its host bus.
 * - `busContextOf` and `busCarrierOf` read the context and the carrier of a bus; they
 *   replace the former public `getContext()` and throw for objects that are not buses
 *   built by the kernel.
 */
export { busCarrierOf, busContextOf, createCarrierBus } from './bus-instance.js';

/**
 * Bus contexts and unscoped views.
 *
 * - `createBusContext` builds the shared state (registries, transports) that several
 *   bus instances run on.
 * - `createFilteredBus` builds a payload-filtered view on a namespace for a carrier
 *   without going through the public bus surface.
 */
export { createBusContext } from './bus.js';
export { createFilteredBus } from './filtered-bus.js';
