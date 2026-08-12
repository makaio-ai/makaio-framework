/**
 * Tests for the `agent.adapterSession.moved` wire contract.
 *
 * The `confirmed` flag and `adapterSessionId` are one value: a confirmed
 * movement names its successor, an unconfirmed one has none.
 */
import { describe, expect, it } from 'vitest';
import { AdapterSessionMovedSchema } from '../adapter-session-moved.js';

const IDENTITY = {
  agentId: 'agent-1',
  adapterId: 'adapter-1',
  adapterName: 'claude-code',
  machineId: 'test-machine',
  ownerInstanceId: 'test-owner',
  sessionId: 'session-1',
};

describe('AdapterSessionMovedSchema', () => {
  it('accepts a confirmed movement that names its successor', () => {
    const result = AdapterSessionMovedSchema.safeParse({
      ...IDENTITY,
      adapterSessionId: 'provider-1',
      confirmed: true,
    });

    expect(result.success).toBe(true);
  });

  it('accepts an unconfirmed movement without a successor', () => {
    const result = AdapterSessionMovedSchema.safeParse({ ...IDENTITY, confirmed: false });

    expect(result.success).toBe(true);
  });

  it('rejects a confirmed movement without a successor', () => {
    const result = AdapterSessionMovedSchema.safeParse({ ...IDENTITY, confirmed: true });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['adapterSessionId']);
  });

  it('rejects an unconfirmed movement that names a successor', () => {
    const result = AdapterSessionMovedSchema.safeParse({
      ...IDENTITY,
      adapterSessionId: 'provider-1',
      confirmed: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['adapterSessionId']);
  });

  it('allows a session-less agent to announce a movement', () => {
    const result = AdapterSessionMovedSchema.safeParse({
      agentId: IDENTITY.agentId,
      adapterId: IDENTITY.adapterId,
      adapterName: IDENTITY.adapterName,
      machineId: IDENTITY.machineId,
      ownerInstanceId: IDENTITY.ownerInstanceId,
      adapterSessionId: 'provider-1',
      confirmed: true,
    });

    expect(result.success).toBe(true);
  });
});
