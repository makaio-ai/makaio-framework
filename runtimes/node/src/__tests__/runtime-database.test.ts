/**
 * Tests for the typed runtime database accessor and the local-only routing
 * of runtime resource subjects.
 */
import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { getRuntimeDatabase } from '../bus/runtime/get-runtime-database.js';
import { RuntimeSubjects } from '../bus/runtime/namespace.js';

describe('getRuntimeDatabase', () => {
  it('returns the handle registered on runtime.database', async () => {
    const bus = createBusInstance();
    const dbStub = { select: () => undefined };
    const cleanup = bus.on(RuntimeSubjects.database, (ctx) => {
      ctx.setResult({ db: dbStub });
    });

    await expect(getRuntimeDatabase(bus)).resolves.toBe(dbStub);
    cleanup();
  });

  it('rejects when no runtime registered a database provider', async () => {
    const bus = createBusInstance();

    await expect(getRuntimeDatabase(bus)).rejects.toThrow();
  });
});

describe('runtime resource subject routing', () => {
  it('marks the non-serializable resource subjects as local-only', () => {
    expect(RuntimeSubjects.database.$meta.local).toBe(true);
    expect(RuntimeSubjects.machineIdentity.$meta.local).toBe(true);
  });

  it('keeps busPort remotely invokable', () => {
    expect(RuntimeSubjects.busPort.$meta.local).toBe(false);
  });
});
