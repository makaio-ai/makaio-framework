/** Runtime validation for reserveStart when namespace validation is disabled. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type SessionOwnershipReserveStartServiceRequest,
} from '@makaio/contracts';
import { registerSessionOwnershipAuthority } from '../authority.js';

const OWNER_INSTANCE_ID = 'owner-1';

/** Base service request accepted by the reserve schema. */
function request(): SessionOwnershipReserveStartServiceRequest {
  return {
    sessionId: 'session-1',
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'test-adapter',
    ownerInstanceId: OWNER_INSTANCE_ID,
    role: 'member',
    resumeProviderSessionId: null,
    claimToken: 'claim-1',
  };
}

/** Valid recovery guard used to isolate service-level cross-field failures. */
function recoveryGuard() {
  return {
    expectedStatus: 'idle' as const,
    expectedPreimage: { status: 'idle' as const, adapterId: 'adapter-1' },
    expectedRevision: 0,
    expectedCurrencyFence: 0,
    expectedCurrency: {
      adapterSessionId: null,
      currentAdapterSessionId: null,
      currentAdapterSessionIdState: 'inherited' as const,
    },
    ownerGeneration: null,
  };
}

describe('reserveStart runtime normalization', () => {
  let bus: IMakaioBus;
  let cleanups: Array<() => void>;
  let storageCalls: number;
  let previousNodeEnv: string | undefined;

  beforeEach(() => {
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    bus = createBusInstance();
    storageCalls = 0;
    const authority = registerSessionOwnershipAuthority({
      bus,
      machineId: 'machine-1',
      topology: 'shared-machine',
      instanceId: OWNER_INSTANCE_ID,
    });
    cleanups = [
      ...authority.cleanups,
      bus.on(SessionOwnershipStorageSubjects.claim, (ctx) => {
        storageCalls += 1;
        ctx.setResult({ outcome: 'not-found', missing: 'agent' });
      }),
    ];
  });

  afterEach(() => {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it.each([
    ['lead without expected lead', (): SessionOwnershipReserveStartServiceRequest => ({ ...request(), role: 'lead' })],
    [
      'guard on a lead reservation',
      (): SessionOwnershipReserveStartServiceRequest => ({
        ...request(),
        role: 'lead',
        expectedLeadAgentId: null,
        recoveryGuard: recoveryGuard(),
        recoveryAttemptId: 'attempt-1',
      }),
    ],
    [
      'guard without attempt',
      (): SessionOwnershipReserveStartServiceRequest => ({ ...request(), recoveryGuard: recoveryGuard() }),
    ],
    [
      'attempt without guard',
      (): SessionOwnershipReserveStartServiceRequest => ({ ...request(), recoveryAttemptId: 'attempt-1' }),
    ],
  ] as const)('rejects %s before calling storage', async (_name, buildInvalid) => {
    await expect(bus.request(SessionSubjects.ownership.reserveStart, buildInvalid())).rejects.toThrow();
    expect(storageCalls).toBe(0);
  });
});
