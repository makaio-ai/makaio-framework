import { describe, expect, it } from 'vitest';
import {
  SessionOwnershipReserveStartServiceRequestSchema,
  SessionOwnershipServiceMovementSchema,
} from '../ownership.js';

const PRINCIPAL = {
  sessionId: 'session-1',
  agentId: 'agent-1',
  adapterId: 'adapter-instance-1',
  adapterName: 'test-adapter',
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
