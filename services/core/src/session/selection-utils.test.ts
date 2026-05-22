import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterRuntimeSubjects } from '../adapter-runtime/namespace.js';
import { resolveAdapterNameById } from './selection-utils.js';

describe('resolveAdapterNameById', () => {
  it('returns the adapter name resolved by the adapter runtime', async () => {
    MakaioBus.__resetHandlers?.();

    const cleanup = MakaioBus.on(AdapterRuntimeSubjects.resolveName, (ctx) => {
      expect(ctx.payload).toEqual({ adapterId: 'machine-1:adapter:name:with:colons' });
      ctx.setResult({ adapterName: 'adapter:name:with:colons' });
    });

    try {
      await expect(
        resolveAdapterNameById(MakaioBus, 'machine-1:adapter:name:with:colons', undefined, '[test] '),
      ).resolves.toBe('adapter:name:with:colons');
    } finally {
      cleanup();
      MakaioBus.__resetHandlers?.();
    }
  });

  it('rejects when the explicit adapter name does not match the reverse lookup', async () => {
    MakaioBus.__resetHandlers?.();

    const cleanup = MakaioBus.on(AdapterRuntimeSubjects.resolveName, (ctx) => {
      ctx.setResult({ adapterName: 'adapter:name:with:colons' });
    });

    try {
      await expect(
        resolveAdapterNameById(MakaioBus, 'machine-1:adapter:name:with:colons', 'other-adapter', '[test] '),
      ).rejects.toThrow(
        '[test] adapterName "other-adapter" does not match adapterId "machine-1:adapter:name:with:colons"',
      );
    } finally {
      cleanup();
      MakaioBus.__resetHandlers?.();
    }
  });

  it('propagates adapter runtime lookup failures', async () => {
    MakaioBus.__resetHandlers?.();

    const cleanup = MakaioBus.on(AdapterRuntimeSubjects.resolveName, (ctx) => {
      throw new Error(`Adapter not found for adapterId="${ctx.payload.adapterId}"`);
    });

    try {
      await expect(resolveAdapterNameById(MakaioBus, ':adapter', undefined, '[test] ')).rejects.toThrow(
        'Adapter not found for adapterId=":adapter"',
      );
    } finally {
      cleanup();
      MakaioBus.__resetHandlers?.();
    }
  });

  it('preserves remote-machine deterministic adapterId lookups through the runtime seam', async () => {
    MakaioBus.__resetHandlers?.();

    const cleanup = MakaioBus.on(AdapterRuntimeSubjects.resolveName, (ctx) => {
      expect(ctx.payload).toEqual({ adapterId: 'remote-machine:adapter:name:with:colons' });
      ctx.setResult({ adapterName: 'adapter:name:with:colons' });
    });

    try {
      await expect(
        resolveAdapterNameById(MakaioBus, 'remote-machine:adapter:name:with:colons', undefined, '[test] '),
      ).resolves.toBe('adapter:name:with:colons');
    } finally {
      cleanup();
      MakaioBus.__resetHandlers?.();
    }
  });
});
