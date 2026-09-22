/**
 * Unit tests for the readiness gate's deadline clamping.
 *
 * The shared wait helper treats a timeout of `0` as "no automatic timeout". The
 * budget resolver must therefore never express an expired deadline as `0` — doing so
 * would remove the cap and let a never-settling `ready` promise hang the wait. That
 * is fatal on the inbound relay hop, which has no outer timeout wrapper to rescue it.
 */

import { describe, it, expect } from 'vitest';
import type { SubjectDefinition } from '@makaio/core';
import { createBusInstance, createBusContext } from '../bus.js';
import { TimeoutError } from '../errors/index.js';
import { dispatch, type DispatchOptions } from '../methods/request/dispatch.js';
import { resolveReadinessBudget } from '../methods/request/readiness-gate.js';
import { anchorRequestDeadline } from '../registries/transport-registry.js';
import type { BusMessage, BusTransport, BusTransportKeys } from '../index.js';

/**
 * Build dispatch options carrying only what the budget resolver reads.
 * @param readinessTimeout - Configured readiness budget, or `undefined` for the default
 * @returns Dispatch options suitable for `resolveReadinessBudget`
 */
function budgetOptions(readinessTimeout?: number): DispatchOptions {
  return {
    correlationId: 'budget-correlation',
    messageId: 'budget-message',
    timeout: 60_000,
    ...(readinessTimeout !== undefined && { readinessTimeout }),
  };
}

describe('resolveReadinessBudget', () => {
  it('reports an expired deadline distinctly instead of as a zero budget', () => {
    // `0` is the no-cap sentinel of the shared wait helper, so an expired deadline
    // must never be encoded with it.
    expect(resolveReadinessBudget(budgetOptions(5000), Date.now() - 50)).toBe('expired');
    // Exactly at the deadline is already expired — this is the boundary that a
    // separate "is there time left?" check could straddle.
    expect(resolveReadinessBudget(budgetOptions(5000), Date.now())).toBe('expired');
  });

  it('never returns a non-positive number for a finite deadline', () => {
    for (const offset of [1, 5, 50, 500]) {
      const budget = resolveReadinessBudget(budgetOptions(5000), Date.now() + offset);
      expect(typeof budget).toBe('number');
      expect(budget as number).toBeGreaterThan(0);
    }
  });

  it('clamps a configured budget to the remaining deadline', () => {
    const budget = resolveReadinessBudget(budgetOptions(5000), Date.now() + 100);
    expect(budget).toBeLessThanOrEqual(100);
  });

  it('lets the deadline alone bound an uncapped budget', () => {
    const budget = resolveReadinessBudget(budgetOptions(0), Date.now() + 100);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(100);
  });

  it('preserves the no-cap sentinel only when there is no deadline at all', () => {
    expect(resolveReadinessBudget(budgetOptions(0), undefined)).toBe(0);
  });
});

describe('dispatch with an already-expired deadline', () => {
  it('refuses to run anything once the deadline has passed', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const transport: BusTransport = {
      name: 'expired-deadline',
      ready: new Promise<void>(() => {}), // never settles
      send: (async (_message: BusMessage) => true) as BusTransport['send'],
      onReceive: () => () => undefined,
      connect: async () => undefined,
      disconnect: async () => undefined,
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
    };
    const registration = bus
      .getContext()
      .transportRegistry.registerTransport('expired-deadline' as BusTransportKeys, transport);

    const definition: SubjectDefinition = {
      subject: 'expiredDeadline',
      $meta: { namespace: 'budget', isRequest: true, payload: {} as never, local: false, channel: false },
    };

    try {
      const started = Date.now();
      // An inbound relay hop can arrive with a past wire deadline and has no outer
      // wrapper. "Nothing runs after the deadline" is literal: the chain is not walked,
      // and the caller is told the request timed out rather than that it had no handler.
      await expect(
        dispatch(
          bus.getContext(),
          definition,
          {},
          {
            correlationId: 'expired-correlation',
            messageId: 'expired-message',
            // `timeout: 0` would disable the caller's cap entirely; only the already-past
            // deadline can stop this, which is exactly the hang scenario.
            timeout: 0,
            deadline: Date.now() - 1_000,
          },
        ),
      ).rejects.toThrow(TimeoutError);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      registration.unregister();
      bus.disconnect();
    }
  });
});

describe('deadline expiry precedence over a provisional transport error', () => {
  it('reports a timeout when the propagated deadline expires during the readiness wait', async () => {
    // The inbound relay hop carries a deadline but has no outer timeout wrapper, so
    // this is the only place the precedence is observable: a caller-side p-timeout
    // would otherwise race dispatch and mask which error was chosen.
    const bus = createBusInstance({ context: createBusContext() });
    const transportFailure = new Error('advertised peer exploded');

    const failing: BusTransport = {
      name: 'deadline-failing',
      send: (async () => {
        throw transportFailure;
      }) as BusTransport['send'],
      onReceive: () => () => undefined,
      connect: async () => undefined,
      disconnect: async () => undefined,
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
    };
    const stillPending: BusTransport = {
      name: 'deadline-pending',
      ready: new Promise<void>(() => {}), // never settles
      send: (async () => true) as BusTransport['send'],
      onReceive: () => () => undefined,
      connect: async () => undefined,
      disconnect: async () => undefined,
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
    };

    const registry = bus.getContext().transportRegistry;
    const a = registry.registerTransport('deadline-failing' as BusTransportKeys, failing);
    const b = registry.registerTransport('deadline-pending' as BusTransportKeys, stillPending);
    bus
      .getContext()
      .remoteRequestHandlers.set('budget.deadlinePrecedence', [{ transport: 'deadline-failing', priority: 0 }]);

    const definition: SubjectDefinition = {
      subject: 'deadlinePrecedence',
      $meta: { namespace: 'budget', isRequest: true, payload: {} as never, local: false, channel: false },
    };

    try {
      // The caller's budget is what ended the request; the advertised peer's unrelated
      // failure must not be reported in its place.
      await expect(
        dispatch(
          bus.getContext(),
          definition,
          {},
          {
            correlationId: 'precedence-correlation',
            messageId: 'precedence-message',
            timeout: 0,
            readinessTimeout: 5_000,
            deadline: Date.now() + 40,
          },
        ),
      ).rejects.toThrow(TimeoutError);
    } finally {
      a.unregister();
      b.unregister();
      bus.disconnect();
    }
  });
});

describe('anchorRequestDeadline', () => {
  // A receiving hop anchors from the relative `timeout` only. The wire `deadline` is an
  // instant on the SENDER's clock; comparing it against ours would let a sender whose
  // clock trails by more than the timeout expire a request that still has full budget.
  it('anchors from the relative timeout against the local clock', () => {
    const anchored = anchorRequestDeadline(100);
    expect(anchored).toBeDefined();
    expect(anchored!).toBeGreaterThan(Date.now());
    expect(anchored!).toBeLessThanOrEqual(Date.now() + 100);
  });

  it('leaves the request unbounded when the timeout is unlimited', () => {
    expect(anchorRequestDeadline(0)).toBeUndefined();
  });

  it('gives a fresh budget even when the sender minted a deadline already in the past', async () => {
    // The scenario the earlier cap-based rule broke: a skewed sender's `deadline` is
    // long past, but `timeout` still carries the real remaining budget.
    const bus = createBusInstance({ context: createBusContext() });
    const definition: SubjectDefinition = {
      subject: 'skewedSender',
      $meta: { namespace: 'budget', isRequest: true, payload: {} as never, local: false, channel: false },
    };
    try {
      const anchored = anchorRequestDeadline(5_000);
      expect(anchored).toBeDefined();
      // Dispatching with that anchor runs normally rather than expiring on entry.
      const outcome = await dispatch(
        bus.getContext(),
        definition,
        {},
        {
          correlationId: 'skew-correlation',
          messageId: 'skew-message',
          timeout: 5_000,
          deadline: anchored,
        },
      );
      expect(outcome.handled).toBe(false);
    } finally {
      bus.disconnect();
    }
  });
});
