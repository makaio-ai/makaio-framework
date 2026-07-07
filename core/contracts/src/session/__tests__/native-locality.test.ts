import { describe, expect, it } from 'vitest';
import {
  ImportUpsertRequestSchema,
  MakaioSessionSchema,
  NativeLocalityVerdictSchema,
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
});
