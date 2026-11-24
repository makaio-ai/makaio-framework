import type { IMakaioBus } from '@makaio/bus-core';
import type { TransportReceiveContext } from '@makaio/core';
import { RightsResolveRequestSchema, RightsSubjects } from '@makaio/contracts/rights';
import type { RightsHub } from './rights-hub.js';
import type { ResolveRightConnection } from './resolve-right.js';

/**
 * Builds the connection a question travelling over the bus is keyed by: the transport
 * name and, when the transport supplies one, its own connection/session id.
 * @param transport - The handler context's trusted transport info, when the message arrived over one.
 * @returns The structured connection, or `undefined` when `transport` is absent (an in-process call).
 * A transport that supplies no `connectionId` still returns a value (with `id` absent): `resolveRight`
 * is the one place that decides such a connection is not cacheable.
 */
export function connectionOf(transport: TransportReceiveContext | undefined): ResolveRightConnection | undefined {
  if (transport === undefined) return undefined;
  return transport.connectionId === undefined
    ? { transport: transport.transportName }
    : { transport: transport.transportName, id: transport.connectionId };
}

/**
 * Registers the bus handlers of the rights hub: `makaio:rights.resolve` and
 * `makaio:rights.list`, in the style of `coordinator-rpc-handlers.ts`.
 *
 * `resolve` always asks for the RECEIVED call of the request (`ctx.call`): the
 * request payload carries only `right` and `context`, never a call context of
 * its own, so a caller cannot name another context to be resolved for. The
 * handler parses the request with `RightsResolveRequestSchema` itself, because the
 * bus does not validate payloads against the subject schema in production.
 *
 * Asks only: like {@link RightsHub.resolve}, this handler never denies or announces a "no"
 * on `makaio:access.denied`; it only answers the question asked of it. A handler serving a
 * message that needs its own caller's "no" announced uses
 * `ctx.rights.handlerContext(call).hasRight` instead, never this
 * bus subject.
 * @param bus - Bus to register the handlers on.
 * @param hub - Hub the handlers delegate to.
 * @returns Cleanup functions that unregister the handlers.
 */
export function registerRightsHandlers(bus: IMakaioBus, hub: RightsHub): Array<() => void> {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    bus.on(RightsSubjects.resolve, async (ctx) => {
      const { right, context } = RightsResolveRequestSchema.parse(ctx.payload);
      ctx.setResult(await hub.resolve({ call: ctx.call, right, context }, { connection: connectionOf(ctx.transport) }));
    }),
  );

  cleanups.push(
    bus.on(RightsSubjects.list, (ctx) => {
      ctx.setResult({ rights: hub.list() });
    }),
  );

  return cleanups;
}
