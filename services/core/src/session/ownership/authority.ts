import { SessionOwnershipStorageSubjects, SessionSubjects, teardownWasObserved } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
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
export interface SessionOwnershipAuthorityDeps extends Omit<OwnershipAuthorityContext, 'instanceId'> {
  /** Runtime-incarnation identity, or a freshly minted identity in isolated compositions. */
  readonly instanceId?: string;
}

/** A request reached an authority whose terminal close has begun. */
export class OwnershipAuthorityClosedError extends Error {
  /** Create the stable closed-authority failure returned by all five operations. */
  public constructor() {
    super('The session ownership authority is closed');
    this.name = 'OwnershipAuthorityClosedError';
  }
}

/** Private lifecycle control for the locally composed ownership authority. */
export interface OwnershipAuthorityHandle {
  /** Identity stamped onto generations allocated by this authority. */
  readonly instanceId: string;
  /** Close admission, drain admitted operations, and retire on observed teardown. */
  close(): Promise<void>;
}

/** Authority handlers and the private lifecycle control that owns them. */
export interface RegisteredSessionOwnershipAuthority {
  /** Idempotent handler cleanups for the containing service. */
  readonly cleanups: readonly (() => void)[];
  /** Private shutdown capability; deliberately not exposed as a bus subject. */
  readonly ownership: OwnershipAuthorityHandle;
}

/**
 * Synchronous admission plus an exact drain of operations admitted before close.
 *
 * A handler can already have been selected by the bus when its subscription is
 * removed. The flag therefore lives inside the selected handler's first
 * synchronous step; subscription cleanup narrows future dispatch, while this
 * gate closes the captured-handler window.
 */
class OwnershipOperationAdmission {
  private closed = false;
  private readonly active = new Set<symbol>();
  private drainWaiters: Array<() => void> = [];

  /**
   * Admit and track one operation through settlement.
   * @param operation - Durable authority act to run after synchronous admission.
   * @returns The operation result.
   */
  public async run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    if (this.closed) throw new OwnershipAuthorityClosedError();
    const admission = Symbol('ownership-operation');
    this.active.add(admission);
    try {
      return await operation();
    } finally {
      this.active.delete(admission);
      if (this.closed && this.active.size === 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  /** Close admission synchronously. */
  public close(): void {
    this.closed = true;
  }

  /** @returns A promise resolving once every admitted operation has settled. */
  public drain(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }
}

/**
 * Register the session-ownership authority.
 *
 * These five subjects are the service surface of the ownership aggregate, and
 * each one is exactly one durable ownership act. That is the point: composed by
 * a caller out of storage RPCs, a reservation or a movement is three
 * transactions with windows in which a crash strands an ownership key or
 * publishes a currency no generation owns.
 * @param deps - Bus, machine identity, topology and optional test identity.
 * @returns Registered cleanups and the private retirement handle.
 */
export function registerSessionOwnershipAuthority(
  deps: SessionOwnershipAuthorityDeps,
): RegisteredSessionOwnershipAuthority {
  const { bus } = deps;
  const context: OwnershipAuthorityContext = {
    ...deps,
    instanceId: deps.instanceId ?? crypto.randomUUID(),
  };
  const admission = new OwnershipOperationAdmission();
  let teardownEvidence: Parameters<typeof teardownWasObserved>[0] | undefined;
  let closePromise: Promise<void> | undefined;

  const operationUnsubscribes = [
    bus.on(
      SessionSubjects.ownership.reserveStart,
      async (ctx) => {
        ctx.setResult(await admission.run(() => runReserveStart(context, ctx.payload)));
      },
      { filter: { ownerInstanceId: context.instanceId } },
    ),
    bus.on(
      SessionSubjects.ownership.settleMovement,
      async (ctx) => {
        ctx.setResult(await admission.run(() => runSettleMovement(context, ctx.payload)));
      },
      { filter: { ownerInstanceId: context.instanceId } },
    ),
    bus.on(SessionSubjects.ownership.release, async (ctx) => {
      ctx.setResult(await admission.run(() => runRelease(context, ctx.payload)));
    }),
    bus.on(SessionSubjects.ownership.reconcile, async (ctx) => {
      ctx.setResult(await admission.run(() => runReconcile(context)));
    }),
    bus.on(SessionSubjects.ownership.continuation, async (ctx) => {
      ctx.setResult(await admission.run(() => runContinuation(context, ctx.payload)));
    }),
  ];

  const unsubscribeTeardown = bus.on(
    AdapterRuntimeSubjects.teardownCompleted,
    (ctx) => {
      teardownEvidence = ctx.payload.evidence;
    },
    { filter: { ownerInstanceId: context.instanceId } },
  );

  let operationsUnsubscribed = false;
  const unsubscribeOperations = (): void => {
    if (operationsUnsubscribed) return;
    operationsUnsubscribed = true;
    for (let index = operationUnsubscribes.length - 1; index >= 0; index -= 1) operationUnsubscribes[index]?.();
  };

  const ownership: OwnershipAuthorityHandle = {
    instanceId: context.instanceId,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      admission.close();
      unsubscribeOperations();
      closePromise = (async () => {
        await admission.drain();
        if (teardownEvidence === undefined || !teardownWasObserved(teardownEvidence)) return;
        await bus.requestOptional(SessionOwnershipStorageSubjects.retireInstance, {
          instanceId: context.instanceId,
        });
      })();
      return closePromise;
    },
  };

  return {
    cleanups: [unsubscribeOperations, unsubscribeTeardown],
    ownership,
  };
}
