/**
 * Schema tests for the `locality.degraded` payload discriminated union.
 *
 * Verifies that the cross-field invariant is enforced at both layers:
 * - Core event schema (persisted row): `MakaioSessionEventSchema`
 * - Bus subject schema (live event): `EventSchemas['locality.degraded']`
 *
 * Four illegal combinations are tested:
 * 1. `verdictKind: 'degrade'` without `reason`
 * 2. `verdictKind: 'degrade'` with `foreignMachineId`
 * 3. `verdictKind: 'foreign'` without `foreignMachineId`
 * 4. `verdictKind: 'foreign'` with `reason`
 */

import { describe, expect, it } from 'vitest';
import { MakaioSessionEventSchema } from '../event.js';
import { EventSchemas } from '../events.js';

/** Shared envelope fields for persisted event tests. */
const envelope = {
  sessionId: 'sess-1',
  eventId: 'evt-1',
  timestamp: 1000,
};

describe('locality.degraded payload — core event schema', () => {
  const validDegrade = {
    ...envelope,
    type: 'locality.degraded',
    payload: {
      intent: 'resume',
      verdictKind: 'degrade',
      reason: 'adapter-unsupported',
    },
  };

  const validForeign = {
    ...envelope,
    type: 'locality.degraded',
    payload: {
      intent: 'fork',
      verdictKind: 'foreign',
      foreignMachineId: 'machine-42',
    },
  };

  it('accepts a valid degrade payload with reason', () => {
    expect(() => MakaioSessionEventSchema.parse(validDegrade)).not.toThrow();
  });

  it('accepts a valid foreign payload with foreignMachineId', () => {
    expect(() => MakaioSessionEventSchema.parse(validForeign)).not.toThrow();
  });

  it('rejects degrade without reason', () => {
    const invalid = {
      ...envelope,
      type: 'locality.degraded',
      payload: {
        intent: 'resume',
        verdictKind: 'degrade',
        // reason missing
      },
    };
    expect(() => MakaioSessionEventSchema.parse(invalid)).toThrow();
  });

  it('rejects degrade with foreignMachineId (cross-field violation)', () => {
    const parsed = MakaioSessionEventSchema.parse({
      ...envelope,
      type: 'locality.degraded',
      payload: {
        intent: 'resume',
        verdictKind: 'degrade',
        reason: 'adapter-unsupported',
        foreignMachineId: 'should-be-stripped',
      },
    });
    // The discriminated union strips unknown fields — foreignMachineId
    // does not exist on the 'degrade' variant and must not appear.
    expect((parsed.payload as Record<string, unknown>).foreignMachineId).toBeUndefined();
  });

  it('rejects foreign without foreignMachineId', () => {
    const invalid = {
      ...envelope,
      type: 'locality.degraded',
      payload: {
        intent: 'fork',
        verdictKind: 'foreign',
        // foreignMachineId missing
      },
    };
    expect(() => MakaioSessionEventSchema.parse(invalid)).toThrow();
  });

  it('rejects foreign with reason (cross-field violation)', () => {
    const parsed = MakaioSessionEventSchema.parse({
      ...envelope,
      type: 'locality.degraded',
      payload: {
        intent: 'fork',
        verdictKind: 'foreign',
        foreignMachineId: 'machine-42',
        reason: 'should-be-stripped',
      },
    });
    // The discriminated union strips unknown fields — reason
    // does not exist on the 'foreign' variant and must not appear.
    expect((parsed.payload as Record<string, unknown>).reason).toBeUndefined();
  });
});

describe('locality.degraded payload — bus subject schema', () => {
  const busEnvelope = {
    sessionId: 'sess-1',
    eventId: 'evt-1',
    timestamp: 1000,
  };

  it('accepts a valid degrade bus event', () => {
    expect(() =>
      EventSchemas['locality.degraded'].parse({
        ...busEnvelope,
        intent: 'resume',
        verdictKind: 'degrade',
        reason: 'cwd-mismatch',
      }),
    ).not.toThrow();
  });

  it('accepts a valid foreign bus event', () => {
    expect(() =>
      EventSchemas['locality.degraded'].parse({
        ...busEnvelope,
        intent: 'fork',
        verdictKind: 'foreign',
        foreignMachineId: 'machine-42',
      }),
    ).not.toThrow();
  });

  it('rejects degrade without reason', () => {
    expect(() =>
      EventSchemas['locality.degraded'].parse({
        ...busEnvelope,
        intent: 'resume',
        verdictKind: 'degrade',
      }),
    ).toThrow();
  });

  it('rejects foreign without foreignMachineId', () => {
    expect(() =>
      EventSchemas['locality.degraded'].parse({
        ...busEnvelope,
        intent: 'fork',
        verdictKind: 'foreign',
      }),
    ).toThrow();
  });
});
