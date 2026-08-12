import { describe, expect, it } from 'vitest';
import {
  normalizeSessionOwnershipReserveStartServiceRequest,
  SessionOwnershipReserveStartServiceRequestSchema,
  SessionOwnershipSettleMovementServiceRequestSchema,
  SessionOwnershipServiceMovementSchema,
} from '../ownership.js';
import {
  normalizeSessionOwnershipClaimRequest,
  SessionOwnershipClaimRequestSchema,
  SessionOwnershipSettleMovementRequestSchema,
} from '../../session-ownership-storage-namespace.js';
import { isInactiveSafeLeadDesignationMutation } from '../../session-ownership-designation-mutation.js';

const PRINCIPAL = {
  sessionId: 'session-1',
  agentId: 'agent-1',
  adapterId: 'adapter-instance-1',
  adapterName: 'test-adapter',
  ownerInstanceId: 'owner-1',
  claimToken: 'claim-token-1',
} as const;

describe('SessionOwnershipReserveStartServiceRequestSchema', () => {
  it("rejects role 'lead' without an observed lead", () => {
    // There is no "designate whatever is there" mode: it is not a
    // compare-and-swap, and would let two concurrent starts both believe they
    // lead. The refinement is what makes the omission impossible to express.
    const result = SessionOwnershipReserveStartServiceRequestSchema.safeParse({
      ...PRINCIPAL,
      role: 'lead',
      resumeProviderSessionId: null,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['expectedLeadAgentId']);
  });

  it("accepts role 'lead' with an explicit null expectation", () => {
    // `null` is a statement, not an omission: "I read this session and it had
    // no lead". A start that observed a lead and still means to replace it has
    // to name that lead.
    const result = SessionOwnershipReserveStartServiceRequestSchema.safeParse({
      ...PRINCIPAL,
      role: 'lead',
      resumeProviderSessionId: null,
      expectedLeadAgentId: null,
    });

    expect(result.success).toBe(true);
  });

  it("accepts role 'member' without an expectation", () => {
    // A member never designates, so it has nothing to compare and swap.
    const result = SessionOwnershipReserveStartServiceRequestSchema.safeParse({
      ...PRINCIPAL,
      role: 'member',
      resumeProviderSessionId: 'provider-1',
    });

    expect(result.success).toBe(true);
  });

  it('requires the exact runtime owner for keyed and keyless reservations', () => {
    const keyed = SessionOwnershipReserveStartServiceRequestSchema.safeParse({
      ...PRINCIPAL,
      role: 'member',
      resumeProviderSessionId: 'provider-1',
    });
    const keyless = SessionOwnershipReserveStartServiceRequestSchema.safeParse({
      ...PRINCIPAL,
      role: 'member',
      resumeProviderSessionId: null,
    });

    expect(keyed.success).toBe(true);
    expect(keyless.success).toBe(true);
  });

  it('normalizes service requests through every cross-field refinement', () => {
    expect(() =>
      normalizeSessionOwnershipReserveStartServiceRequest({
        ...PRINCIPAL,
        role: 'lead',
        resumeProviderSessionId: null,
      }),
    ).toThrow();
  });
});

describe('ownership allocation request schemas', () => {
  const CLAIM = {
    machineId: 'machine-1',
    adapterId: 'adapter-1',
    providerSessionId: 'provider-1',
    adapterName: 'test-adapter',
    sessionId: 'session-1',
    agentId: 'agent-1',
    claimToken: 'token-1',
  } as const;

  it('defaults topology and requires an owner for a keyed storage claim', () => {
    const missingOwner = SessionOwnershipClaimRequestSchema.safeParse(CLAIM);
    const claimed = SessionOwnershipClaimRequestSchema.parse({
      ...CLAIM,
      ownerInstance: { instanceId: 'instance-1' },
    });

    expect(missingOwner.success).toBe(false);
    expect(missingOwner.error?.issues[0]?.path).toEqual(['ownerInstance']);
    expect(claimed.topology).toBe('shared-machine');
    expect(normalizeSessionOwnershipClaimRequest({ ...CLAIM, ownerInstance: { instanceId: 'instance-1' } })).toEqual(
      claimed,
    );
  });

  it('requires guarded recovery to pair its attempt fence with one exact preimage', () => {
    const guard = {
      expectedStatus: 'idle',
      expectedPreimage: {
        status: 'idle',
        adapterId: 'adapter-1',
        binding: { adapterId: 'adapter-1', ownerMachineId: 'machine-1', ownerInstanceId: 'owner-1' },
      },
      expectedRevision: 0,
      expectedCurrencyFence: 0,
      expectedCurrency: {
        adapterSessionId: null,
        currentAdapterSessionId: null,
        currentAdapterSessionIdState: 'inherited',
      },
      ownerGeneration: null,
    } as const;
    const mismatchedStatus = SessionOwnershipClaimRequestSchema.safeParse({
      ...CLAIM,
      ownerInstance: { instanceId: 'instance-1' },
      recoveryAttemptId: 'attempt-1',
      recoveryGuard: { ...guard, expectedPreimage: { ...guard.expectedPreimage, status: 'dead' } },
    });
    const mismatchedBinding = SessionOwnershipClaimRequestSchema.safeParse({
      ...CLAIM,
      ownerInstance: { instanceId: 'instance-1' },
      recoveryAttemptId: 'attempt-1',
      recoveryGuard: {
        ...guard,
        expectedPreimage: {
          ...guard.expectedPreimage,
          binding: { ...guard.expectedPreimage.binding, adapterId: 'other-adapter' },
        },
      },
    });
    const missingAttempt = SessionOwnershipClaimRequestSchema.safeParse({
      ...CLAIM,
      ownerInstance: { instanceId: 'instance-1' },
      recoveryGuard: guard,
    });
    const missingGuard = SessionOwnershipClaimRequestSchema.safeParse({
      ...CLAIM,
      ownerInstance: { instanceId: 'instance-1' },
      recoveryAttemptId: 'attempt-1',
    });

    expect(mismatchedStatus.success).toBe(false);
    expect(mismatchedBinding.success).toBe(false);
    expect(missingAttempt.error?.issues.some((issue) => issue.path[0] === 'recoveryAttemptId')).toBe(true);
    expect(missingGuard.error?.issues.some((issue) => issue.path[0] === 'recoveryGuard')).toBe(true);
  });

  it('requires an owner for both storage and targeted service settlement', () => {
    const storage = SessionOwnershipSettleMovementRequestSchema.safeParse({
      machineId: 'machine-1',
      adapterId: 'adapter-1',
      adapterName: 'test-adapter',
      sessionId: 'session-1',
      agentId: 'agent-1',
      expectedRevision: 0,
      movement: { kind: 'demote', claimToken: 'token-1' },
    });
    const service = SessionOwnershipSettleMovementServiceRequestSchema.safeParse({
      ...PRINCIPAL,
      movement: { confirmed: false },
    });

    expect(storage.success).toBe(false);
    expect(service.success).toBe(true);
  });

  it('keeps guarded recovery member-only at the storage seam', () => {
    const guardedDesignation = SessionOwnershipClaimRequestSchema.safeParse({
      ...CLAIM,
      ownerInstance: { instanceId: 'instance-1' },
      recoveryAttemptId: 'attempt-1',
      recoveryGuard: {
        expectedStatus: 'idle',
        expectedPreimage: { status: 'idle', adapterId: 'adapter-1' },
        expectedRevision: 0,
        expectedCurrencyFence: 0,
        expectedCurrency: {
          adapterSessionId: null,
          currentAdapterSessionId: null,
          currentAdapterSessionIdState: 'inherited',
        },
        ownerGeneration: null,
      },
      designateLead: { expectedLeadAgentId: null },
    });

    expect(guardedDesignation.success).toBe(false);
    expect(guardedDesignation.error?.issues.some((issue) => issue.path[0] === 'designateLead')).toBe(true);
  });

  it('recognizes only marked pure clear and restore mutations as inactive-safe', () => {
    const base = {
      agentId: 'agent-1',
      providerSessionId: null,
      ownerInstance: undefined,
      recoveryGuard: undefined,
      recoveryAttemptId: undefined,
      supersedes: undefined,
    } as const;

    expect(
      isInactiveSafeLeadDesignationMutation({
        ...base,
        designateLead: { expectedLeadAgentId: 'agent-1', clear: true },
      }),
    ).toBe(true);
    expect(
      isInactiveSafeLeadDesignationMutation({
        ...base,
        designateLead: { expectedLeadAgentId: 'failed-agent', restore: true },
      }),
    ).toBe(true);
    expect(isInactiveSafeLeadDesignationMutation({ ...base, designateLead: { expectedLeadAgentId: null } })).toBe(
      false,
    );
    expect(
      SessionOwnershipClaimRequestSchema.safeParse({
        ...CLAIM,
        providerSessionId: null,
        designateLead: { expectedLeadAgentId: null, clear: true, restore: true },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['clear with a null expectation', { expectedLeadAgentId: null, clear: true }],
    ['clear naming another agent', { expectedLeadAgentId: 'other-agent', clear: true }],
    ['restore with a null expectation', { expectedLeadAgentId: null, restore: true }],
    ['restore targeting the expected failed lead', { expectedLeadAgentId: 'agent-1', restore: true }],
  ] as const)('rejects %s', (_name, designateLead) => {
    expect(
      SessionOwnershipClaimRequestSchema.safeParse({
        ...CLAIM,
        providerSessionId: null,
        designateLead,
      }).success,
    ).toBe(false);
  });
});

describe('SessionOwnershipServiceMovementSchema', () => {
  it('requires a provider session exactly on a confirmed movement', () => {
    expect(SessionOwnershipServiceMovementSchema.safeParse({ confirmed: true }).success).toBe(false);
    expect(
      SessionOwnershipServiceMovementSchema.safeParse({ confirmed: true, providerSessionId: 'provider-1' }).success,
    ).toBe(true);
    expect(SessionOwnershipServiceMovementSchema.safeParse({ confirmed: false }).success).toBe(true);
  });
});
