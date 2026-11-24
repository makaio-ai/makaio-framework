/**
 * Kernel entry of `@makaio/bus-core`.
 *
 * This file names the functions that mint, carry, and check call contexts and that
 * build bus instances around a shared context. It also provides namespace ownership operations.
 * It is for the kernel and composition code of the framework only: `bus-core` itself, the kernel package, transports,
 * runtime boot code, test utilities, and the composition roots of an application.
 * Extension code must not import it. A lint rule added later in this package enforces
 * that boundary; until then the boundary is convention. The public index
 * (`./index.ts`) deliberately carries none of these names.
 *
 * The groups below are the one fixed list of kernel names. A name belongs here when
 * it controls message attribution, exposes a bus outside the public carrier binding,
 * or manages namespace ownership.
 *
 * Note on `createBusInstance({ context })`: the `context` option of the public
 * `createBusInstance` is a kernel capability too. It cannot be exported under a name of
 * its own, so extension code must not pass it either; the same lint rule covers it.
 * The context itself comes from `createBusContext` below.
 *
 * Internal to `bus-core` and intentionally not listed: `buildBusInstance`, `enterSend`,
 * `deriveSent`, `own` (carrier-level), and the `methods/*` entry points.
 */

import type { NamespaceLease } from '@makaio/contracts/extension';
import type { BusNamespaceDefinition, RegistrableBusNamespaceDefinition, SubjectSchema } from '@makaio/core';
import { busContextOf } from './bus-instance.js';
import type { NamespaceHolder, TypedNamespace } from './registries/namespace-registry.js';
import type { IMakaioBus } from './types/bus.js';

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
 *   transport state with its host bus. The kernel can give its subscriptions an
 *   abort signal to remove them before releasing the carrier's namespace claims.
 * - `busContextOf` and `busCarrierOf` read the context and the carrier of a bus; they
 *   replace the former public `getContext()` and throw for objects that are not buses
 *   built by the kernel.
 */
export { busCarrierOf, busContextOf, createCarrierBus, type CarrierNamespaceRegistration } from './bus-instance.js';

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

export {
  CORE_NAMESPACE_PREFIXES,
  HOST_NAMESPACE_HOLDER,
  NamespaceOwnershipError,
  type NamespaceHolder,
} from './registries/namespace-registry.js';
export type { NamespaceLease } from '@makaio/contracts/extension';

/**
 * Claim a bus namespace for a named holder.
 *
 * `leaseNamespace` and `HOST_NAMESPACE_HOLDER` are for trusted code in the host process, and extensions claim through `ctx.namespaces`.
 * @param bus - Bus whose registry will hold the claim.
 * @param definition - Namespace definition to register.
 * @param holder - Host or extension claiming the namespace.
 * @returns An independent release handle with the registered namespace.
 */
export function leaseNamespace<Domain extends string, Schemas extends Record<string, SubjectSchema>>(
  bus: IMakaioBus,
  definition: BusNamespaceDefinition<Domain, Schemas>,
  holder: NamespaceHolder,
): NamespaceLease & { namespace: TypedNamespace<Domain, Schemas> };
export function leaseNamespace(
  bus: IMakaioBus,
  definition: RegistrableBusNamespaceDefinition,
  holder: NamespaceHolder,
): NamespaceLease;
export function leaseNamespace(
  bus: IMakaioBus,
  definition: RegistrableBusNamespaceDefinition,
  holder: NamespaceHolder,
): NamespaceLease {
  return busContextOf(bus).namespaceRegistry.leaseNamespace(definition as BusNamespaceDefinition, holder);
}

/**
 * Look up the holder of a namespace, including reserved host namespaces.
 * @param bus - Bus whose registry to query.
 * @param namespace - Domain to look up.
 * @returns The current holder, if any.
 */
export function ownerOf(bus: IMakaioBus, namespace: string): NamespaceHolder | undefined {
  return busContextOf(bus).namespaceRegistry.ownerOf(namespace);
}

/**
 * List the registered namespaces and their holders in namespace order.
 * @param bus - Bus whose registry to query.
 * @returns Registered namespace owners in namespace order.
 */
export function listOwners(bus: IMakaioBus): readonly { namespace: string; owner: NamespaceHolder }[] {
  return busContextOf(bus).namespaceRegistry.listOwners();
}

/**
 * Check if a namespace has been registered.
 * @param bus - Bus whose registry to query.
 * @param name - Domain to look up.
 * @returns True if the domain is registered.
 */
export function hasNamespace(bus: IMakaioBus, name: string): boolean {
  return busContextOf(bus).namespaceRegistry.hasNamespace(name);
}

/**
 * Resolve a subject's registered namespace by exact match or longest registered prefix.
 * @param bus - Bus whose registry to query.
 * @param subject - Fully qualified subject.
 * @returns The registered namespace, if any.
 */
export function namespaceOf(bus: IMakaioBus, subject: string): string | undefined {
  return busContextOf(bus).namespaceRegistry.namespaceOf(subject);
}

export { AccessDeniedError, CoreDenialPlace } from '@makaio/contracts/access';
