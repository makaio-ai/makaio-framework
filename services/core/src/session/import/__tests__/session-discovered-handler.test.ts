import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type ImportUpsertRequest } from '@makaio/contracts';
import { SessionStorageSubjects } from '../../storage/namespace.js';
import { registerSessionDiscoveredHandler } from '../session-discovered-handler.js';

describe('registerSessionDiscoveredHandler', () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanups.length = 0;
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it('forwards caller-supplied machineId to importUpsert unchanged', async () => {
    const importUpserts: ImportUpsertRequest[] = [];

    cleanups.push(
      registerSessionDiscoveredHandler(MakaioBus),
      MakaioBus.on(SessionStorageSubjects.importUpsert, (ctx) => {
        importUpserts.push(ctx.payload);
        ctx.setResult({ sessionId: 'imported-session', created: true });
      }),
    );

    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-local',
      adapterName: 'claude-code',
      adapterSessionId: 'provider-session',
      model: 'sonnet',
      cwd: '/repo',
      title: 'Imported session',
      machineId: 'owner-machine',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });

    expect(importUpserts).toHaveLength(1);
    expect(importUpserts[0]?.machineId).toBe('owner-machine');
  });
});
