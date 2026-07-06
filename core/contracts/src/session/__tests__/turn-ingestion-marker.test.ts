import { describe, expect, it } from 'vitest';
import { OrchestratorSchemas, TurnIngestionMarkerSchema } from '../schemas/orchestrator.js';

/** Minimal valid `session.turn.completed` payload without the marker. */
const turnCompletedBase = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  turnNumber: 1,
  success: true,
};

/** Minimal valid `session.turn.started` payload without the marker. */
const turnStartedBase = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  turnNumber: 1,
  messageId: 'msg-1',
  agentIds: ['agent-1'],
};

describe('TurnIngestionMarkerSchema', () => {
  it('accepts live and backfill', () => {
    expect(TurnIngestionMarkerSchema.safeParse('live').success).toBe(true);
    expect(TurnIngestionMarkerSchema.safeParse('backfill').success).toBe(true);
  });

  it('rejects other values', () => {
    expect(TurnIngestionMarkerSchema.safeParse('imported').success).toBe(false);
    expect(TurnIngestionMarkerSchema.safeParse('').success).toBe(false);
  });
});

describe("OrchestratorSchemas['turn.completed'] ingestionMarker", () => {
  it("accepts ingestionMarker 'live'", () => {
    const result = OrchestratorSchemas['turn.completed'].safeParse({
      ...turnCompletedBase,
      ingestionMarker: 'live',
    });

    expect(result.success).toBe(true);
  });

  it("accepts ingestionMarker 'backfill'", () => {
    const result = OrchestratorSchemas['turn.completed'].safeParse({
      ...turnCompletedBase,
      ingestionMarker: 'backfill',
    });

    expect(result.success).toBe(true);
  });

  it('accepts an absent ingestionMarker (field is additive/optional)', () => {
    const result = OrchestratorSchemas['turn.completed'].safeParse(turnCompletedBase);

    expect(result.success).toBe(true);
    expect(result.data?.ingestionMarker).toBeUndefined();
  });

  it('rejects unknown marker strings', () => {
    const result = OrchestratorSchemas['turn.completed'].safeParse({
      ...turnCompletedBase,
      ingestionMarker: 'replay',
    });

    expect(result.success).toBe(false);
  });

  it('surfaces the marker through the turn.await response envelope', () => {
    const result = OrchestratorSchemas['turn.await'].response.safeParse({
      completion: { ...turnCompletedBase, ingestionMarker: 'backfill' },
    });

    expect(result.success).toBe(true);
  });
});

describe("OrchestratorSchemas['turn.started'] ingestionMarker", () => {
  it("accepts ingestionMarker 'live'", () => {
    const result = OrchestratorSchemas['turn.started'].safeParse({
      ...turnStartedBase,
      ingestionMarker: 'live',
    });

    expect(result.success).toBe(true);
  });

  it("accepts ingestionMarker 'backfill'", () => {
    const result = OrchestratorSchemas['turn.started'].safeParse({
      ...turnStartedBase,
      ingestionMarker: 'backfill',
    });

    expect(result.success).toBe(true);
  });

  it('accepts an absent ingestionMarker (field is additive/optional)', () => {
    const result = OrchestratorSchemas['turn.started'].safeParse(turnStartedBase);

    expect(result.success).toBe(true);
    expect(result.data?.ingestionMarker).toBeUndefined();
  });

  it('rejects unknown marker strings', () => {
    const result = OrchestratorSchemas['turn.started'].safeParse({
      ...turnStartedBase,
      ingestionMarker: 'historic',
    });

    expect(result.success).toBe(false);
  });
});
