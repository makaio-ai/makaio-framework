import { SessionSubjects } from '@makaio/contracts';
import type { OwnershipAuthorityContext } from './context.js';
import { runContinuation } from './continuation.js';
import { runReconcile } from './reconcile.js';
import { runRelease } from './release.js';
import { runReserveStart } from './reserve-start.js';
import { runSettleMovement } from './settle-movement.js';

/**
 * What the session-ownership authority is composed with.
 *
 * The same shape the operations receive, deliberately: what a caller composes
 * the authority with *is* what every operation decides under, so there is no
 * second declaration for the two to drift apart in.
 */
export type SessionOwnershipAuthorityDeps = OwnershipAuthorityContext;

/**
 * Register the session-ownership authority.
 *
 * These five subjects are the service surface of the ownership aggregate, and
 * each one is exactly one durable ownership act. That is the point: composed by
 * a caller out of storage RPCs, a reservation or a movement is three
 * transactions with windows in which a crash strands an ownership key or
 * publishes a currency no generation owns.
 * @param context - Bus, machine identity and topology to compose the authority with.
 * @returns Cleanup function unregistering every handler.
 */
export function registerSessionOwnershipAuthority(context: SessionOwnershipAuthorityDeps): () => void {
  const { bus } = context;

  const unsubscribes = [
    bus.on(SessionSubjects.ownership.reserveStart, async (ctx) => {
      ctx.setResult(await runReserveStart(context, ctx.payload));
    }),
    bus.on(SessionSubjects.ownership.settleMovement, async (ctx) => {
      ctx.setResult(await runSettleMovement(context, ctx.payload));
    }),
    bus.on(SessionSubjects.ownership.release, async (ctx) => {
      ctx.setResult(await runRelease(context, ctx.payload));
    }),
    bus.on(SessionSubjects.ownership.reconcile, async (ctx) => {
      ctx.setResult(await runReconcile(context));
    }),
    bus.on(SessionSubjects.ownership.continuation, async (ctx) => {
      ctx.setResult(await runContinuation(context, ctx.payload));
    }),
  ];

  return () => {
    for (let index = unsubscribes.length - 1; index >= 0; index -= 1) unsubscribes[index]?.();
  };
}
