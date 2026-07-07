import { describe, expect, it } from 'vitest';
import {
  ClientSessionStartedSchema,
  ClientSessionTurnCompletedSchema,
  ClientSessionTurnStartedSchema,
} from '../session-observed.js';

/** Minimal valid base payload shared by all `client.session.*` events. */
const basePayload = {
  clientId: 'claude-code',
  source: 'native-hook',
  observedAt: 1750000000000,
} as const;

describe('ClientSessionStartedSchema', () => {
  it('accepts a base-only payload without transcriptPath or cwd', () => {
    expect(ClientSessionStartedSchema.parse(basePayload)).toEqual(basePayload);
  });

  it('accepts a payload with transcriptPath and cwd', () => {
    const payload = {
      ...basePayload,
      adapterSessionId: 'abc-123',
      transcriptPath: '/home/user/.claude/projects/foo/abc-123.jsonl',
      cwd: '/home/user/project',
    };
    expect(ClientSessionStartedSchema.parse(payload)).toEqual(payload);
  });

  it('rejects a non-string transcriptPath', () => {
    expect(() => ClientSessionStartedSchema.parse({ ...basePayload, transcriptPath: 42 })).toThrow();
  });

  it('rejects a non-string cwd', () => {
    expect(() => ClientSessionStartedSchema.parse({ ...basePayload, cwd: 42 })).toThrow();
  });

  it('accepts a payload with machineId', () => {
    const payload = {
      ...basePayload,
      adapterSessionId: 'abc-123',
      machineId: 'machine-abc-def',
    };
    expect(ClientSessionStartedSchema.parse(payload)).toEqual(payload);
  });

  it('rejects a non-string machineId', () => {
    expect(() => ClientSessionStartedSchema.parse({ ...basePayload, machineId: 42 })).toThrow();
  });

  it('accepts a payload with fork startMode and parentAdapterSessionId', () => {
    const payload = {
      ...basePayload,
      adapterSessionId: 'fork-child-123',
      startMode: 'fork' as const,
      parentAdapterSessionId: 'parent-session-456',
    };
    const parsed = ClientSessionStartedSchema.parse(payload);
    expect(parsed).toEqual(payload);
    expect(parsed.startMode).toBe('fork');
    expect(parsed.parentAdapterSessionId).toBe('parent-session-456');
  });

  it('accepts a payload with fresh startMode and no parent', () => {
    const payload = {
      ...basePayload,
      adapterSessionId: 'fresh-session-789',
      startMode: 'fresh' as const,
    };
    expect(ClientSessionStartedSchema.parse(payload)).toEqual(payload);
  });

  it('accepts a payload without startMode (hook-only, no fork signal)', () => {
    const payload = {
      ...basePayload,
      adapterSessionId: 'observed-session-000',
    };
    const parsed = ClientSessionStartedSchema.parse(payload);
    expect(parsed.startMode).toBeUndefined();
    expect(parsed.parentAdapterSessionId).toBeUndefined();
  });

  it('rejects an invalid startMode value', () => {
    expect(() =>
      ClientSessionStartedSchema.parse({
        ...basePayload,
        startMode: 'rotation',
      }),
    ).toThrow();
  });
});

describe('ClientSessionTurnCompletedSchema', () => {
  it('accepts a base-only payload without transcriptPath', () => {
    expect(ClientSessionTurnCompletedSchema.parse(basePayload)).toEqual(basePayload);
  });

  it('accepts a payload with transcriptPath', () => {
    const payload = {
      ...basePayload,
      transcriptPath: '/home/user/.claude/projects/foo/abc-123.jsonl',
    };
    expect(ClientSessionTurnCompletedSchema.parse(payload)).toEqual(payload);
  });

  it('rejects a non-string transcriptPath', () => {
    expect(() => ClientSessionTurnCompletedSchema.parse({ ...basePayload, transcriptPath: 42 })).toThrow();
  });
});

describe('ClientSessionTurnStartedSchema', () => {
  it('stays base-only: unknown keys such as transcriptPath are stripped', () => {
    // turn.started is intentionally cadence-only; the Stop hook
    // (turn.completed) is the import trigger. See the schema TSDoc.
    const parsed = ClientSessionTurnStartedSchema.parse({
      ...basePayload,
      transcriptPath: '/should/be/stripped.jsonl',
    });
    expect(parsed).toEqual(basePayload);
  });
});
