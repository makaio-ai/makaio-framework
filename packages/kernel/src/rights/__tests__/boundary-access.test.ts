import { createBusInstance, SUBSCRIPTION_DEFERRED, type BoundaryAccessTarget } from '@makaio/bus-core';
import { HOST_NAMESPACE_HOLDER, leaseNamespace, mintCallContext } from '@makaio/bus-core/kernel-api';
import { AccessDeniedError, CoreDenialPlace } from '@makaio/contracts/access';
import { SUBJECT_SEND_RIGHT, SUBJECT_SUBSCRIBE_RIGHT, type RightAnswer } from '@makaio/contracts/rights';
import { createBusNamespace } from '@makaio/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createCoordinatorRights } from '../coordinator-rights.js';
import { createAnswerSource } from './fixtures.js';

const query = { request: z.object({}), response: z.object({ handled: z.boolean() }) };
const observed = createBusNamespace('observed', { query }, { startupObservable: { readOnlyRequests: ['query'] } });
const regular = createBusNamespace('regular', { query });
const request = { operation: 'send', messageType: 'request', namespace: observed.name, subject: 'query' } as const;
const subscribe = { operation: 'subscribe', pattern: `${regular.name}.query`, defer: 'replay' } as const;

/** @returns A host boundary with a controllable answer from a registered rights source. */
function setup() {
  const bus = createBusInstance();
  leaseNamespace(bus, observed, HOST_NAMESPACE_HOLDER);
  leaseNamespace(bus, regular, HOST_NAMESPACE_HOLDER);
  const rights = createCoordinatorRights(bus, 'host');
  const started = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<RightAnswer>();
  const owner = 'test-policy';
  rights.activate(owner, {
    rightsSources: [
      createAnswerSource(`${owner}.boundary`, [SUBJECT_SEND_RIGHT, SUBJECT_SUBSCRIBE_RIGHT], {
        kind: 'fn',
        answer: () => {
          started.resolve();
          return answer.promise;
        },
      }),
    ],
  });
  const party = { kind: 'test.peer', id: 'caller' };
  const call = mintCallContext({ caller: party, principal: party });
  return { bus, rights, started, answer, call };
}

describe('boundary access phase transitions', () => {
  it.each([
    request,
    subscribe,
  ] satisfies BoundaryAccessTarget[])('denies a pending $operation grant when the boundary closes', async (target) => {
    const { bus, rights, started, answer, call } = setup();
    rights.openBoundary();
    const handler = vi.fn();
    bus.on(observed.subjects.query, ({ setResult }) => {
      handler();
      setResult({ handled: true });
    });
    const outcome = rights.checkBoundaryAccess(target, call, undefined).then(async (decision) => {
      if (decision === undefined && target.operation === 'send') return bus.request(observed.subjects.query, {});
      return decision;
    });
    await started.promise;
    rights.closeBoundary();
    answer.resolve({ granted: true });

    const denial = await outcome;
    expect(denial).toBeInstanceOf(AccessDeniedError);
    expect(denial).toMatchObject({ data: { at: CoreDenialPlace[target.operation], reason: 'host-not-ready' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves the observable request and replay deferral across readiness', async () => {
    const { rights, started, answer, call } = setup();
    const pending = rights.checkBoundaryAccess(request, call, undefined);
    await started.promise;
    const deferred = rights.checkBoundaryAccess(subscribe, call, undefined);
    rights.openBoundary();
    answer.resolve({ granted: true });

    await expect(pending).resolves.toBeUndefined();
    await expect(deferred).resolves.toBe(SUBSCRIPTION_DEFERRED);
    await expect(rights.checkBoundaryAccess(subscribe, call, undefined)).resolves.toBeUndefined();
  });
});
