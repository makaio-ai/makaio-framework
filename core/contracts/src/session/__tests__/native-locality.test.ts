import { describe, expect, it } from 'vitest';
import {
  ImportUpsertRequestSchema,
  MakaioSessionEventSchema,
  MakaioSessionSchema,
  NativeLocalityVerdictSchema,
  SESSION_EVENT_TYPES,
  SessionContextSchema,
} from '@makaio/contracts';

describe('native session locality contracts', () => {
  it('accepts caller-supplied machineId on session records', () => {
    const parsed = MakaioSessionSchema.parse({
      sessionId: 'session-1',
      createdAt: 1,
      lastActivityAt: 1,
      agents: [],
      status: 'active',
      machineId: 'machine-owner',
    });

    expect(parsed.machineId).toBe('machine-owner');
  });

  it('models local native, local degrade, and foreign ownership verdicts', () => {
    const native = NativeLocalityVerdictSchema.parse({ kind: 'native' });
    expect(native.kind).toBe('native');

    const degrade = NativeLocalityVerdictSchema.parse({ kind: 'degrade', reason: 'cwd-mismatch' });
    expect(degrade.kind).toBe('degrade');
    expect((degrade as { reason: string }).reason).toBe('cwd-mismatch');

    const foreign = NativeLocalityVerdictSchema.parse({ kind: 'foreign', machineId: 'machine-remote' });
    expect(foreign.kind).toBe('foreign');
    expect((foreign as { machineId: string }).machineId).toBe('machine-remote');
  });

  it('carries verdicts and fork directives through SessionContext', () => {
    const parsed = SessionContextSchema.parse({
      nativeLocality: { kind: 'native' },
      nativeFork: {
        sourceAdapterSessionId: 'adapter-source',
        sourceSessionId: 'source-session',
        forkPointMessageId: 'message-1',
      },
    });

    expect(parsed.nativeFork?.sourceAdapterSessionId).toBe('adapter-source');
  });

  it('accepts machineId on importUpsert payloads as caller-supplied locality', () => {
    const payload = {
      kind: 'root',
      externalSessionId: 'external-1',
      source: 'claude-code',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      cwd: '/repo',
      machineId: 'machine-owner',
    };

    const parsed = ImportUpsertRequestSchema.parse(payload);
    expect(parsed.machineId).toBe('machine-owner');
  });

  it('requires source on importUpsert payloads', () => {
    expect(() =>
      ImportUpsertRequestSchema.parse({
        kind: 'root',
        externalSessionId: 'external-1',
        cwd: '/repo',
      }),
    ).toThrow();
  });

  describe('locality.degraded event schema', () => {
    it('is listed in CORE_SESSION_EVENT_TYPES', () => {
      expect(SESSION_EVENT_TYPES).toContain('locality.degraded');
    });

    it('round-trips a degrade event with all fields', () => {
      const raw = {
        sessionId: 'session-1',
        eventId: 'evt-1',
        timestamp: Date.now(),
        type: 'locality.degraded',
        payload: {
          intent: 'resume',
          verdictKind: 'degrade',
          reason: 'cwd-mismatch',
          agentId: 'agent-1',
          adapterId: 'adapter-1',
          turnId: 'turn-1',
        },
      };

      const parsed = MakaioSessionEventSchema.parse(raw);
      expect(parsed).toMatchObject(raw);
    });

    it('round-trips a foreign verdict event without reason', () => {
      const raw = {
        sessionId: 'session-1',
        eventId: 'evt-2',
        timestamp: Date.now(),
        type: 'locality.degraded',
        payload: {
          intent: 'fork',
          verdictKind: 'foreign',
          foreignMachineId: 'remote-machine',
        },
      };

      const parsed = MakaioSessionEventSchema.parse(raw);
      expect(parsed).toMatchObject(raw);
    });

    it('round-trips a minimal degrade event (only required fields)', () => {
      const raw = {
        sessionId: 'session-1',
        eventId: 'evt-3',
        timestamp: Date.now(),
        type: 'locality.degraded',
        payload: {
          intent: 'resume',
          verdictKind: 'degrade',
          reason: 'adapter-unsupported',
        },
      };

      const parsed = MakaioSessionEventSchema.parse(raw);
      expect(parsed).toMatchObject(raw);
    });

    it('rejects invalid degrade reasons', () => {
      expect(() =>
        MakaioSessionEventSchema.parse({
          sessionId: 'session-1',
          eventId: 'evt-4',
          timestamp: Date.now(),
          type: 'locality.degraded',
          payload: {
            intent: 'resume',
            verdictKind: 'degrade',
            reason: 'invented-reason',
          },
        }),
      ).toThrow();
    });
  });
});
